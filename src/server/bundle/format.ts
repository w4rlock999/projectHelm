import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BUNDLE_FORMAT_VERSION } from '../../version.ts';
import { HarnessProfileSchema } from '../harness/profile.ts';

// The agent bundle: the wire and on-disk format for ship & recall.
//
// A bundle is a gzipped tar of
//
//   manifest.json    frozen envelope — parseable by a helm that does NOT
//                    understand the payload
//   db.json          every exported row
//   workspace/       loose agent-created files (NOT CLAUDE.md or tools/,
//                    which the receiver re-materializes rather than trusting)
//   data/            the durable data plane, unless --without-data
//
// manifest and payload are separate files so a v1 helm can open a v3 bundle and
// say "bundle format 3, this helm speaks 1 — upgrade" instead of emitting a wall
// of validation errors about a payload it was never going to understand. That
// only works if the envelope's shape is frozen forever and the payload is free
// to change wholesale.
//
// This module is pure: no I/O, no database. Everything here is unit-testable.

/** Limits. Each is a real boundary against a hostile or broken bundle. */
export const CAPS = {
  /** Compressed bytes accepted off the wire. */
  maxCompressedBytes: 256 * 1024 * 1024,
  /** Uncompressed budget: checked against the gzip trailer AND re-summed after extraction. */
  maxUncompressedBytes: 1024 * 1024 * 1024,
  /** Members in the archive, counted from the listing before anything is extracted. */
  maxMembers: 50_000,
  maxSingleFileBytes: 256 * 1024 * 1024,
} as const;

export type BundleErrorCode =
  | 'unsupported-version'
  | 'malformed'
  | 'integrity'
  | 'too-large'
  | 'unsafe-path'
  | 'conflict'
  | 'tool-conflict'
  | 'operator'
  | 'tar';

export class BundleError extends Error {
  constructor(
    readonly code: BundleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

// ── primitives ──────────────────────────────────────────────────────────────

/**
 * Epoch SECONDS — matches drizzle's `integer({ mode: 'timestamp' })` storage and
 * the `unixepoch()` column defaults. Never milliseconds, never ISO.
 */
const EpochSeconds = z.number().int().min(0).max(4_102_444_800); // ≤ year 2100

/**
 * Load-bearing security check, not pedantry: agent ids and gateways_chat ids
 * become directory names (`.helm/agents/<id>`, `data/sessions/<id>`). Requiring
 * a uuid makes path traversal via a crafted id structurally impossible.
 */
const Id = z.uuid();

/** Telegram chat.id — a signed integer, stored string-encoded. */
const TelegramChatId = z.string().regex(/^-?\d{1,20}$/);

/**
 * Same set the tools router already enforces. Load-bearing here too: the
 * interpreter is interpolated into the shebang of a file we then chmod 755, so
 * a freeform value would let a bundle choose the argv of an exec. An import
 * bypasses both the tRPC and REST routes, so this is the only guard on that path.
 */
export const INTERPRETERS = ['bash', 'sh', 'node', 'python3'] as const;
const Interpreter = z.enum(INTERPRETERS);

// ── envelope (frozen shape; loose so unknown future fields don't fail it) ────

export const BundleEnvelopeSchema = z.looseObject({
  bundleVersion: z.number().int().positive(),
  helmVersion: z.string().min(1),
});
export type BundleEnvelope = z.infer<typeof BundleEnvelopeSchema>;

// ── manifest v1 ─────────────────────────────────────────────────────────────

export const BundleContentsSchema = z.object({
  tools: z.number().int().nonnegative(),
  gateways: z.number().int().nonnegative(),
  chats: z.number().int().nonnegative(),
  heartbeats: z.number().int().nonnegative(),
  workspaceFiles: z.number().int().nonnegative(),
  workspaceBytes: z.number().int().nonnegative(),
  data: z.boolean(),
  dataFiles: z.number().int().nonnegative(),
  dataBytes: z.number().int().nonnegative(),
});
export type BundleContents = z.infer<typeof BundleContentsSchema>;

export const BundleManifestSchema = z.object({
  bundleVersion: z.literal(BUNDLE_FORMAT_VERSION),
  helmVersion: z.string().min(1),
  exportedAt: z.iso.datetime(),
  agent: z.object({ id: Id, name: z.string().min(1).max(200) }),
  requires: z.object({ harness: z.literal('claude-code') }),
  contents: BundleContentsSchema,
  /**
   * sha256 of db.json's exact bytes. The manifest is the root of trust for the
   * payload; the transport hash is the root of trust for the manifest.
   */
  integrity: z.object({ dbJsonSha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  /** Non-fatal notes recorded at export (skipped symlinks, odd filenames). */
  warnings: z.array(z.string()).max(200).default([]),
});
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

// ── db.json v2 ──────────────────────────────────────────────────────────────

/**
 * Strict since v2: an unknown key on the agent is refused, not stripped. The
 * harness profile is the first field where silently dropping a key would
 * change how the agent *runs* on the other side, and a bundle is the one
 * place a hostile or merely newer writer could put one.
 */
export const BundleAgentSchema = z.strictObject({
  id: Id,
  name: z.string().min(1).max(200),
  systemPrompt: z.string(),
  allowedTools: z.string().nullable(),
  model: z.string().max(200).nullable(),
  /**
   * Asserted null rather than omitted: Claude sessions live under ~/.claude on
   * the source machine and cannot resume elsewhere, so a bundle that carries one
   * is *malformed* and we want to say so rather than silently drop it.
   */
  claudeSessionId: z.null(),
  sessionScope: z.enum(['chat', 'agent']),
  sessionRecall: z.enum(['none', 'all']),
  /**
   * The EFFECTIVE profile at export (agent ⊕ fleet defaults), never the raw
   * per-agent one: a shipped agent pins the effort/permission mode it left
   * with rather than inheriting whatever the remote's fleet default happens to
   * be. Null only when nothing was set on either side.
   */
  harness: HarnessProfileSchema.nullable(),
  createdAt: EpochSeconds,
  // `isOperator` is structurally absent: helmCaptain is a per-install singleton
  // and a second one would corrupt the operator lookup. Import always writes false.
});

export const BundleToolSchema = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  description: z.string().max(4000),
  interpreter: Interpreter,
  source: z.string(),
  /** Declared hash. ALWAYS recomputed on import; a mismatch is an integrity failure. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: EpochSeconds,
  updatedAt: EpochSeconds,
});

export const BundleGatewaySchema = z.object({
  id: Id,
  agentId: Id,
  type: z.literal('telegram'),
  token: z.string().min(1).max(300),
  /** The getUpdates cursor — travels so the remote continues where we stopped. */
  pollOffset: z.number().int().nonnegative(),
  enabled: z.boolean(),
  createdAt: EpochSeconds,
});

export const BundleChatSchema = z.object({
  /**
   * PRESERVED VERBATIM ON IMPORT. `data/sessions/<key>` directories are named by
   * this id, so remapping it orphans every per-conversation store — the agent
   * would lose all memory while the import still looked successful.
   */
  id: Id,
  gatewayId: Id,
  chatId: TelegramChatId,
  claudeSessionId: z.null(),
  title: z.string().max(500).nullable(),
  status: z.enum(['active', 'blocked']),
  createdAt: EpochSeconds,
  lastMessageAt: EpochSeconds.nullable(),
});

export const BundleHeartbeatSchema = z
  .object({
    id: Id,
    agentId: Id,
    name: z.string().min(1).max(200),
    cron: z.string().min(1).max(200),
    prompt: z.string(),
    // 'all' is reserved in the schema but never valid inside a bundle.
    targetType: z.enum(['main', 'chat']),
    targetChatId: TelegramChatId.nullable(),
    enabled: z.boolean(),
    lastRunAt: EpochSeconds.nullable(),
    createdAt: EpochSeconds,
  })
  .refine((h) => h.targetType !== 'chat' || h.targetChatId !== null, {
    message: "targetType 'chat' requires targetChatId",
    path: ['targetChatId'],
  });

export const BundleDbSchema = z
  .object({
    agent: BundleAgentSchema,
    tools: z.array(BundleToolSchema).max(500),
    /** agent_tools, flattened: the join carries no data beyond its timestamp. */
    agentToolIds: z.array(Id).max(500),
    gateways: z.array(BundleGatewaySchema).max(50),
    chats: z.array(BundleChatSchema).max(10_000),
    heartbeats: z.array(BundleHeartbeatSchema).max(500),
  })
  .superRefine((d, ctx) => {
    const dup = (xs: string[]) => new Set(xs).size !== xs.length;
    const toolIds = new Set(d.tools.map((t) => t.id));
    const gwIds = new Set(d.gateways.map((g) => g.id));

    if (dup(d.tools.map((t) => t.id)))
      ctx.addIssue({ code: 'custom', message: 'duplicate tool id' });
    if (dup(d.gateways.map((g) => g.id)))
      ctx.addIssue({ code: 'custom', message: 'duplicate gateway id' });
    if (dup(d.chats.map((c) => c.id)))
      ctx.addIssue({ code: 'custom', message: 'duplicate chat id' });
    if (dup(d.heartbeats.map((h) => h.id)))
      ctx.addIssue({ code: 'custom', message: 'duplicate heartbeat id' });
    if (dup(d.agentToolIds)) ctx.addIssue({ code: 'custom', message: 'duplicate agent_tools row' });

    for (const id of d.agentToolIds) {
      if (!toolIds.has(id))
        ctx.addIssue({ code: 'custom', message: `agent_tools references missing tool ${id}` });
    }
    for (const g of d.gateways) {
      if (g.agentId !== d.agent.id)
        ctx.addIssue({ code: 'custom', message: `gateway ${g.id} belongs to another agent` });
    }
    for (const c of d.chats) {
      if (!gwIds.has(c.gatewayId))
        ctx.addIssue({ code: 'custom', message: `chat ${c.id} references missing gateway` });
    }
    for (const h of d.heartbeats) {
      if (h.agentId !== d.agent.id)
        ctx.addIssue({ code: 'custom', message: `heartbeat ${h.id} belongs to another agent` });
    }
    // Mirrors the gateway_chat_uq index, which the import would otherwise hit as
    // a raw constraint violation mid-transaction.
    if (dup(d.chats.map((c) => `${c.gatewayId}/${c.chatId}`))) {
      ctx.addIssue({
        code: 'custom',
        message: 'duplicate (gatewayId, chatId) — violates gateway_chat_uq',
      });
    }
  });
export type BundleDb = z.infer<typeof BundleDbSchema>;

// ── tool identity ───────────────────────────────────────────────────────────

/**
 * Executable identity of a tool. Deliberately excludes `name` and `description`:
 * documentation drift must not fail an import, and only what actually runs
 * counts as a difference.
 */
export function toolContentHash(t: { interpreter: string; source: string }): string {
  return createHash('sha256')
    .update(t.interpreter, 'utf8')
    .update('\n')
    .update(t.source, 'utf8')
    .digest('hex');
}

// ── workspace files that never travel ───────────────────────────────────────

/**
 * Top-level workspace entries the CLI reads as configuration from its cwd —
 * the *project* setting source (`.claude/settings.json`, hooks, `env`,
 * `apiKeyHelper`), the project MCP file, and the local memory file. The
 * receiver renders `.claude/` itself (harness/render.ts), so anything here is
 * agent-authored and must neither leave the source nor load on the target.
 * Excluded at export, stripped (with a warning) at import: belt and braces,
 * because only one of the two sides is under this helm's control.
 */
export const UNTRAVELLED_WORKSPACE_ENTRIES = ['.claude', '.mcp.json', 'CLAUDE.local.md'] as const;

/** Whether a workspace-relative path is (inside) one of the untravelled entries. */
export function isUntravelledWorkspacePath(rel: string): boolean {
  const top = rel.split('/')[0];
  return (UNTRAVELLED_WORKSPACE_ENTRIES as readonly string[]).includes(top);
}

// ── archive member safety ───────────────────────────────────────────────────

const TOP_LEVEL = new Set(['manifest.json', 'db.json', 'workspace', 'data']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Normalize a `tar -t` line to a comparable relative path, or null if unusable.
 * Absorbs the two harmless bsdtar/GNU differences: an optional `./` prefix and a
 * trailing `/` on directories.
 */
export function normalizeMemberName(raw: string): string | null {
  let n = raw.replace(/\/+$/, '');
  if (n.startsWith('./')) n = n.slice(2);
  if (n === '.' || n === '') return null;
  return n;
}

/**
 * Whether an archive member name may be extracted. This is the security
 * boundary — it runs over the listing BEFORE a single inode is created, so a
 * crafted archive never gets to touch the filesystem.
 */
export function isSafeBundleMemberName(name: string): boolean {
  if (name.length === 0 || name.length > 1024) return false;
  // Absolute, or a Windows drive letter.
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  if (name.includes('\\')) return false;
  // Control characters, newline included: a newline in a member name would split
  // a `tar -t` line and let a crafted archive smuggle a second name past this.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;

  const parts = name.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (!TOP_LEVEL.has(parts[0])) return false;
  // The two payload files are files, not directories.
  if ((parts[0] === 'manifest.json' || parts[0] === 'db.json') && parts.length !== 1) return false;
  // `data/sessions/<key>` becomes a directory name; only 'shared' or a uuid.
  if (parts[0] === 'data' && parts.length >= 3 && parts[1] === 'sessions') {
    const key = parts[2];
    if (key !== 'shared' && !UUID_RE.test(key)) return false;
  }
  return true;
}
