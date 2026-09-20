import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { agents, agentTools, gateways, gatewaysChat, heartbeats, tools } from '../../db/schema.ts';
import { BUNDLE_FORMAT_VERSION, HELM_VERSION } from '../../version.ts';
import { getHarnessDefaults } from '../harness/defaults.ts';
import { resolveHarnessProfile } from '../harness/profile.ts';
import { paths } from '../paths.ts';
import { hashFile, stageTree } from './fs.ts';
import {
  BundleError,
  isUntravelledWorkspacePath,
  toolContentHash,
  type BundleContents,
  type BundleDb,
  type BundleManifest,
} from './format.ts';
import { createTarball } from './tar.ts';

// Export: turn a local agent into a bundle file.

/** Drizzle stores timestamps as epoch seconds; the bundle format matches. */
function secs(d: Date | null): number | null {
  return d === null ? null : Math.floor(new Date(d).getTime() / 1000);
}

export interface ExportOptions {
  /** Default true. `--without-data` sets false. */
  withData?: boolean;
  /** Default `.helm/tmp/bundles/<uuid>.helm.tgz`. */
  outFile?: string;
}

export interface ExportResult {
  path: string;
  bytes: number;
  sha256: string;
  manifest: BundleManifest;
  warnings: string[];
}

/**
 * Read every row that belongs to an agent and apply the export redactions.
 *
 * Runs inside a transaction so a concurrent gateway `pollOffset` update can't
 * produce a bundle whose gateway rows and chat rows disagree.
 *
 * Arrays are sorted by id and timestamps written as epoch seconds, so db.json is
 * byte-reproducible for a given database state — which makes the manifest's
 * dbJsonSha256 a stable fixture and "did anything change?" answerable by hash.
 */
export function collectAgentBundleRows(agentId: string): BundleDb {
  return db.transaction((tx) => {
    const agent = tx.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!agent) throw new BundleError('malformed', `agent ${agentId} not found`);
    if (agent.isOperator) {
      throw new BundleError(
        'operator',
        'helmCaptain is a per-install singleton and cannot be shipped',
      );
    }

    const toolIds = tx
      .select({ toolId: agentTools.toolId })
      .from(agentTools)
      .where(eq(agentTools.agentId, agentId))
      .all()
      .map((r) => r.toolId)
      .sort();

    const toolRows = toolIds.length
      ? tx.select().from(tools).where(inArray(tools.id, toolIds)).all()
      : [];

    const gatewayRows = tx.select().from(gateways).where(eq(gateways.agentId, agentId)).all();
    const gatewayIds = gatewayRows.map((g) => g.id);
    const chatRows = gatewayIds.length
      ? tx.select().from(gatewaysChat).where(inArray(gatewaysChat.gatewayId, gatewayIds)).all()
      : [];
    const hbRows = tx.select().from(heartbeats).where(eq(heartbeats.agentId, agentId)).all();

    const byId = <T extends { id: string }>(xs: T[]) =>
      [...xs].sort((a, b) => a.id.localeCompare(b.id));

    // Snapshot the *effective* profile so the fleet default the agent ran
    // under here is pinned on the other side (see BundleAgentSchema.harness).
    const effective = resolveHarnessProfile(agent.harness, getHarnessDefaults());
    const harness = Object.values(effective).every((v) => v === null) ? null : effective;

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        allowedTools: agent.allowedTools,
        model: agent.model,
        // Claude sessions live under ~/.claude on this machine and cannot
        // resume elsewhere. Continuity travels via the data plane instead.
        claudeSessionId: null,
        sessionScope: agent.sessionScope as 'chat' | 'agent',
        sessionRecall: agent.sessionRecall as 'none' | 'all',
        harness,
        createdAt: secs(agent.createdAt)!,
      },
      tools: byId(toolRows).map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        interpreter: t.interpreter as 'bash' | 'sh' | 'node' | 'python3',
        source: t.source,
        contentHash: toolContentHash(t),
        createdAt: secs(t.createdAt)!,
        updatedAt: secs(t.updatedAt)!,
      })),
      agentToolIds: toolIds,
      gateways: byId(gatewayRows).map((g) => ({
        id: g.id,
        agentId: g.agentId,
        type: 'telegram' as const,
        token: g.token,
        pollOffset: g.pollOffset ?? 0,
        enabled: g.enabled,
        createdAt: secs(g.createdAt)!,
      })),
      chats: byId(chatRows).map((c) => ({
        // Preserved verbatim: this is a data/sessions/<key> directory name.
        id: c.id,
        gatewayId: c.gatewayId,
        chatId: c.chatId,
        claudeSessionId: null,
        title: c.title,
        status: c.status as 'active' | 'blocked',
        createdAt: secs(c.createdAt)!,
        lastMessageAt: secs(c.lastMessageAt),
      })),
      heartbeats: byId(hbRows).map((h) => ({
        id: h.id,
        agentId: h.agentId,
        name: h.name,
        cron: h.cron,
        prompt: h.prompt,
        targetType: h.targetType as 'main' | 'chat',
        targetChatId: h.targetChatId,
        enabled: h.enabled,
        lastRunAt: secs(h.lastRunAt),
        createdAt: secs(h.createdAt)!,
      })),
    };
  });
}

/**
 * Mirror the agent's on-disk tree into `stageDir`, applying the include rules.
 * This function IS the include/exclude policy — nothing is expressed as a tar
 * flag, so it can be tested directly.
 */
export function stageBundleTree(
  agentId: string,
  stageDir: string,
  opts: { withData: boolean },
): {
  workspace: { files: number; bytes: number };
  data: { files: number; bytes: number };
  warnings: string[];
} {
  const warnings: string[] = [];

  const workspace = stageTree(
    paths.agentWorkspaceDir(agentId),
    path.join(stageDir, 'workspace'),
    (rel) => {
      // CLAUDE.md and tools/ are regenerated by the receiver from the agent row
      // and the resolved tool set — never trusted from a bundle. Note this
      // excludes only the TOP-LEVEL ones: a nested docs/CLAUDE.md still travels.
      if (rel === 'CLAUDE.md') return false;
      if (rel === 'tools' || rel.startsWith('tools/')) return false;
      // The CLI's cwd configuration (`.claude/`, `.mcp.json`, `CLAUDE.local.md`)
      // is rendered by the receiver too, and anything here is agent-authored.
      if (isUntravelledWorkspacePath(rel)) return false;
      return true;
    },
    warnings,
  );

  // Logs are excluded unconditionally: they are the bulky part, they are
  // machine-local, and a shipped agent's history starts fresh on the remote.
  let data = { files: 0, bytes: 0 };
  if (opts.withData) {
    // Agents created before the data plane landed have no data/ at all;
    // stageTree tolerates a missing source directory.
    data = stageTree(
      paths.agentDataDir(agentId),
      path.join(stageDir, 'data'),
      () => true,
      warnings,
    );
  }

  return { workspace, data, warnings };
}

export async function exportAgentBundle(
  agentId: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const withData = opts.withData ?? true;
  const transferId = randomUUID();
  const stageDir = paths.bundleStageDir(transferId);
  const outFile = opts.outFile ?? paths.bundleFile(transferId);

  try {
    // Throws early on the operator agent, before any filesystem work.
    const rows = collectAgentBundleRows(agentId);

    mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });

    const staged = stageBundleTree(agentId, stageDir, { withData });

    const dbJson = JSON.stringify(rows, null, 2);
    writeFileSync(path.join(stageDir, 'db.json'), dbJson, { mode: 0o600 });

    const contents: BundleContents = {
      tools: rows.tools.length,
      gateways: rows.gateways.length,
      chats: rows.chats.length,
      heartbeats: rows.heartbeats.length,
      workspaceFiles: staged.workspace.files,
      workspaceBytes: staged.workspace.bytes,
      data: withData,
      dataFiles: staged.data.files,
      dataBytes: staged.data.bytes,
    };

    const manifest: BundleManifest = {
      bundleVersion: BUNDLE_FORMAT_VERSION,
      helmVersion: HELM_VERSION,
      exportedAt: new Date().toISOString(),
      agent: { id: rows.agent.id, name: rows.agent.name },
      requires: { harness: 'claude-code' },
      contents,
      integrity: { dbJsonSha256: createHash('sha256').update(dbJson, 'utf8').digest('hex') },
      warnings: staged.warnings.slice(0, 200),
    };
    writeFileSync(path.join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });

    await createTarball(stageDir, outFile);
    // 0600: a bundle carries gateways.token in plaintext.
    chmodSync(outFile, 0o600);
    const { size } = statSync(outFile);
    const sha256 = await hashFile(outFile);

    return { path: outFile, bytes: size, sha256, manifest, warnings: staged.warnings };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}
