import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import {
  agents,
  agentTools,
  gateways,
  gatewaysChat,
  heartbeats,
  tools,
  type Tool,
} from '../../db/schema.ts';
import { loadAgent } from '../agents.ts';
import { isValidCron } from '../cron.ts';
import { paths } from '../paths.ts';
import { syncAgentTools } from '../tools.ts';
import { normalizeModes, validateExtractedTree } from './fs.ts';
import {
  BundleDbSchema,
  BundleEnvelopeSchema,
  BundleError,
  BundleManifestSchema,
  toolContentHash,
  type BundleDb,
  type BundleManifest,
} from './format.ts';
import { assertGzipSane, extractTarball, listTarball, validateMemberNames } from './tar.ts';
import { BUNDLE_FORMAT_VERSION } from '../../version.ts';

// Import: turn a bundle file into a live local agent.
//
// Ordering is FILESYSTEM-FIRST, and the workspace is materialized *before* the
// transaction commits. The alternative (commit rows, then write files) loses:
// the heartbeat tick re-reads every row every 30s with no registration step, so
// between commit and file-write it can fire a turn against an agent whose
// workspace does not exist. Here the worst residue is a directory with no row,
// which is inert — runAgentTurn, the scheduler and the pollers all start from a
// database query.

export interface ToolPlan {
  /** bundled tool id -> local tool id */
  idMap: Map<string, string>;
  create: BundleDb['tools'];
  reuse: { id: string; name: string }[];
}

/**
 * Decide, for each bundled tool, whether to create it locally or reuse an
 * existing library entry.
 *
 * This is insert-or-reuse-or-fail, NOT an upsert. Updating a shared library tool
 * would re-materialize every *other* local agent that has it assigned, so a
 * shipped bundle could silently rewrite unrelated agents' tools. `tools.name`
 * also has no unique index, so a name lookup can legitimately return more than
 * one row — that is ambiguous, and ambiguity fails rather than guesses.
 *
 * Pure over two arrays, so the whole matrix is unit-testable.
 */
export function resolveToolImports(
  bundled: BundleDb['tools'],
  local: Pick<Tool, 'id' | 'name' | 'interpreter' | 'source'>[],
): ToolPlan {
  const idMap = new Map<string, string>();
  const create: BundleDb['tools'] = [];
  const reuse: { id: string; name: string }[] = [];
  const localIds = new Set(local.map((t) => t.id));

  for (const t of bundled) {
    // Recompute rather than trust: a bundle could otherwise declare a hash that
    // matches a local tool while carrying different source.
    const computed = toolContentHash(t);
    if (computed !== t.contentHash) {
      throw new BundleError(
        'integrity',
        `tool "${t.name}" declares a content hash that does not match its source`,
      );
    }

    const matches = local.filter((l) => l.name === t.name);
    if (matches.length > 1) {
      throw new BundleError(
        'tool-conflict',
        `tool name "${t.name}" is ambiguous here (${matches.length} library entries share it)`,
      );
    }
    if (matches.length === 1) {
      const localHash = toolContentHash(matches[0]);
      if (localHash !== computed) {
        throw new BundleError(
          'tool-conflict',
          `tool "${t.name}" already exists here with different source ` +
            `(local ${localHash.slice(0, 12)}, bundle ${computed.slice(0, 12)}) — ` +
            `rename one of them and retry`,
        );
      }
      idMap.set(t.id, matches[0].id);
      reuse.push({ id: matches[0].id, name: t.name });
      continue;
    }

    // Preserve the bundle's id when it is free, so ship -> recall -> ship is a
    // true round-trip; otherwise mint a fresh one and let idMap absorb it.
    const newId = localIds.has(t.id) ? randomUUID() : t.id;
    idMap.set(t.id, newId);
    create.push({ ...t, id: newId });
  }
  return { idMap, create, reuse };
}

export interface InspectedBundle {
  manifest: BundleManifest;
  data: BundleDb;
  quarantineDir: string;
  plan: ToolPlan;
  warnings: string[];
}

/**
 * Validate a bundle and extract it to quarantine. Writes nothing outside
 * `.helm/tmp`. Cheapest and most disqualifying checks first.
 */
export async function inspectBundle(bundlePath: string): Promise<InspectedBundle> {
  const warnings: string[] = [];

  // 1. Gzip sanity + size + free disk, before spawning tar at all.
  assertGzipSane(bundlePath, paths.helmRoot);

  // 2. Member names, from the listing — before a single inode is created.
  const names = validateMemberNames(await listTarball(bundlePath));

  // 3. Extract to quarantine, then walk for bad inodes a name cannot express.
  const quarantineDir = paths.bundleQuarantineDir(randomUUID());
  mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  let ok = false;
  try {
    await extractTarball(bundlePath, quarantineDir);
    validateExtractedTree(quarantineDir);
    normalizeModes(quarantineDir);

    // 4. Envelope first, so a future-format bundle gets a sentence rather than
    //    a wall of validation errors about a payload it never understood.
    const manifestRaw: unknown = JSON.parse(
      readFileSync(path.join(quarantineDir, 'manifest.json'), 'utf8'),
    );
    const envelope = BundleEnvelopeSchema.safeParse(manifestRaw);
    if (!envelope.success) {
      throw new BundleError('malformed', 'manifest.json is not a helm bundle envelope');
    }
    if (envelope.data.bundleVersion !== BUNDLE_FORMAT_VERSION) {
      throw new BundleError(
        'unsupported-version',
        `bundle format v${envelope.data.bundleVersion}; this helm speaks v${BUNDLE_FORMAT_VERSION}`,
      );
    }

    const manifestParsed = BundleManifestSchema.safeParse(manifestRaw);
    if (!manifestParsed.success) {
      throw new BundleError(
        'malformed',
        `manifest.json is invalid: ${manifestParsed.error.issues[0]?.message ?? 'unknown'}`,
      );
    }
    const manifest = manifestParsed.data;

    // 5. Payload integrity, then shape.
    const dbBytes = readFileSync(path.join(quarantineDir, 'db.json'), 'utf8');
    const dbHash = createHash('sha256').update(dbBytes, 'utf8').digest('hex');
    if (dbHash !== manifest.integrity.dbJsonSha256) {
      throw new BundleError('integrity', 'db.json does not match the hash in manifest.json');
    }
    const parsed = BundleDbSchema.safeParse(JSON.parse(dbBytes));
    if (!parsed.success) {
      throw new BundleError(
        'malformed',
        `db.json is invalid: ${parsed.error.issues
          .map((i) => i.message)
          .slice(0, 3)
          .join('; ')}`,
      );
    }
    const data = parsed.data;
    if (data.agent.id !== manifest.agent.id) {
      throw new BundleError('malformed', 'manifest and db.json disagree about the agent id');
    }

    // 6. Semantic preflight — all reads, no writes.
    if (loadAgent(data.agent.id)) {
      throw new BundleError('conflict', `agent ${data.agent.id} already exists on this helm`);
    }
    if (existsSync(paths.agentDir(data.agent.id))) {
      throw new BundleError(
        'conflict',
        `${paths.agentDir(data.agent.id)} already exists with no matching row — ` +
          `debris from an interrupted import. Remove it and retry.`,
      );
    }
    for (const c of data.chats) {
      const clash = db.select().from(gatewaysChat).where(eq(gatewaysChat.id, c.id)).get();
      if (clash) {
        throw new BundleError('conflict', `chat ${c.id} already exists on this helm`);
      }
    }
    for (const g of data.gateways) {
      const clash = db.select().from(gateways).where(eq(gateways.token, g.token)).get();
      if (clash) {
        // Two pollers on one bot token fight over getUpdates and steal each
        // other's messages. There is no unique index, so this must be checked.
        throw new BundleError(
          'conflict',
          'that Telegram bot token is already polled by another agent on this helm',
        );
      }
    }
    for (const h of data.heartbeats) {
      if (!isValidCron(h.cron)) {
        throw new BundleError('malformed', `heartbeat "${h.name}" has an invalid cron: ${h.cron}`);
      }
    }

    // Session stores whose chat row is gone are legitimate (deleting a chat
    // cascades in SQL but leaves the directory) — warn, don't fail.
    const chatIds = new Set(data.chats.map((c) => c.id));
    for (const n of names) {
      const parts = n.split('/');
      if (parts[0] === 'data' && parts[1] === 'sessions' && parts.length >= 3) {
        const key = parts[2];
        if (key !== 'shared' && !chatIds.has(key)) {
          warnings.push(`session store ${key} has no matching chat row (orphan, imported anyway)`);
        }
      }
    }

    const localTools = db.select().from(tools).all();
    const plan = resolveToolImports(data.tools, localTools);

    ok = true;
    return { manifest, data, quarantineDir, plan, warnings };
  } finally {
    if (!ok) rmSync(quarantineDir, { recursive: true, force: true });
  }
}

export interface ImportResult {
  agentId: string;
  manifest: BundleManifest;
  imported: { tools: number; gateways: number; chats: number; heartbeats: number };
  toolsCreated: { id: string; name: string }[];
  toolsReused: { id: string; name: string }[];
  warnings: string[];
}

/** Install a validated bundle. See the ordering note at the top of this file. */
export async function importAgentBundle(bundlePath: string): Promise<ImportResult> {
  const { manifest, data, quarantineDir, plan, warnings } = await inspectBundle(bundlePath);
  const agentId = data.agent.id;
  const agentDir = paths.agentDir(agentId);

  let installed = false;
  try {
    // Materialize INTO QUARANTINE from the resolved tool set, before any row
    // exists. CLAUDE.md and workspace/tools are regenerated here rather than
    // trusted from the bundle.
    // One entry per bundled tool, under whichever local id it resolved to
    // (freshly created or an existing library row).
    const resolvedTools: Tool[] = data.tools.map((t) => ({
      id: plan.idMap.get(t.id)!,
      name: t.name,
      description: t.description,
      interpreter: t.interpreter,
      source: t.source,
      createdAt: new Date(t.createdAt * 1000),
      updatedAt: new Date(t.updatedAt * 1000),
    }));

    mkdirSync(path.join(quarantineDir, 'workspace'), { recursive: true });
    syncAgentTools(agentId, {
      agent: {
        systemPrompt: data.agent.systemPrompt,
        sessionScope: data.agent.sessionScope,
        sessionRecall: data.agent.sessionRecall,
        isOperator: false,
      },
      tools: resolvedTools,
      hasGateway: data.gateways.length > 0,
      workspaceDir: path.join(quarantineDir, 'workspace'),
    });

    // Standard directories the runtime expects, created whether or not the
    // bundle carried a data plane.
    mkdirSync(path.join(quarantineDir, 'data', 'store', 'artifacts'), { recursive: true });
    mkdirSync(path.join(quarantineDir, 'data', 'sessions', 'shared', 'artifacts'), {
      recursive: true,
    });
    mkdirSync(path.join(quarantineDir, 'logs'), { recursive: true });

    // Atomic install — same filesystem, because quarantine lives under .helm/.
    mkdirSync(path.dirname(agentDir), { recursive: true });
    renameSync(quarantineDir, agentDir);
    installed = true;

    // Synchronous transaction: better-sqlite3 transactions do NOT await, so an
    // async callback here would commit before the work ran.
    db.transaction((tx) => {
      tx.insert(agents)
        .values({
          id: agentId,
          name: data.agent.name,
          systemPrompt: data.agent.systemPrompt,
          allowedTools: data.agent.allowedTools,
          model: data.agent.model,
          claudeSessionId: null,
          sessionScope: data.agent.sessionScope,
          sessionRecall: data.agent.sessionRecall,
          // Always false: helmCaptain is a per-install singleton and an
          // imported second operator would corrupt the operator lookup.
          isOperator: false,
          deployedTo: null,
          deployState: null,
          deployedAt: null,
          deployError: null,
          runBudgetPerHour: null,
          createdAt: new Date(data.agent.createdAt * 1000),
        })
        .run();

      for (const t of plan.create) {
        tx.insert(tools)
          .values({
            id: t.id,
            name: t.name,
            description: t.description,
            interpreter: t.interpreter,
            source: t.source,
            createdAt: new Date(t.createdAt * 1000),
            updatedAt: new Date(t.updatedAt * 1000),
          })
          .run();
      }
      for (const bundledId of data.agentToolIds) {
        tx.insert(agentTools)
          .values({ agentId, toolId: plan.idMap.get(bundledId)!, createdAt: new Date() })
          .run();
      }
      for (const g of data.gateways) {
        tx.insert(gateways)
          .values({
            id: g.id,
            agentId,
            type: g.type,
            token: g.token,
            pollOffset: g.pollOffset,
            enabled: g.enabled,
            createdAt: new Date(g.createdAt * 1000),
          })
          .run();
      }
      for (const c of data.chats) {
        tx.insert(gatewaysChat)
          .values({
            // Verbatim: data/sessions/<id> directories are named by this.
            id: c.id,
            gatewayId: c.gatewayId,
            chatId: c.chatId,
            claudeSessionId: null,
            title: c.title,
            status: c.status,
            createdAt: new Date(c.createdAt * 1000),
            lastMessageAt: c.lastMessageAt === null ? null : new Date(c.lastMessageAt * 1000),
          })
          .run();
      }
      for (const h of data.heartbeats) {
        tx.insert(heartbeats)
          .values({
            id: h.id,
            agentId,
            name: h.name,
            cron: h.cron,
            prompt: h.prompt,
            targetType: h.targetType,
            targetChatId: h.targetChatId,
            enabled: h.enabled,
            lastRunAt: h.lastRunAt === null ? null : new Date(h.lastRunAt * 1000),
            createdAt: new Date(h.createdAt * 1000),
          })
          .run();
      }
    });

    return {
      agentId,
      manifest,
      imported: {
        tools: plan.create.length,
        gateways: data.gateways.length,
        chats: data.chats.length,
        heartbeats: data.heartbeats.length,
      },
      toolsCreated: plan.create.map((t) => ({ id: t.id, name: t.name })),
      toolsReused: plan.reuse,
      warnings: warnings.concat(manifest.warnings),
    };
  } catch (err) {
    // Preflight refused to import over an existing agent, so the directory
    // provably did not exist before — removing it restores the prior state
    // exactly.
    if (installed) rmSync(agentDir, { recursive: true, force: true });
    else rmSync(quarantineDir, { recursive: true, force: true });
    throw err;
  }
}
