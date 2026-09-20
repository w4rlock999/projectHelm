import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { agents } from '../db/schema.ts';
import { BUNDLE_FORMAT_VERSION, HELM_BUILD, HELM_VERSION } from '../version.ts';
import { config } from './config.ts';
import {
  machineEnv,
  machineFacts,
  MachineFactsSchema,
  onPath,
  versionOf,
} from './machine/probe.ts';
import { readRemoteJson } from './remote-auth.ts';
import { isPaused } from './runtime/pause.ts';

// The pairing handshake payload served at GET /api/remote/info. The local
// helm validates responses against this same schema (the version/shape
// assertion at the seam — skew fails loudly, not mysteriously).

/**
 * Runtimes an MCP server or a library tool may need on this machine. Version
 * strings where cheap, booleans for the launchers. Advertised so ship
 * preflight can refuse an agent whose tools need something the remote lacks,
 * instead of that agent failing at 3am.
 */
export const RuntimesSchema = z.object({
  node: z.string().nullable(),
  python3: z.string().nullable(),
  npx: z.boolean(),
  uvx: z.boolean(),
});
export type Runtimes = z.infer<typeof RuntimesSchema>;

export const HarnessInfoSchema = z.object({
  type: z.string(),
  version: z.string().nullable(),
  authOk: z.boolean(),
  // ── Added in harness H0 ─────────────────────────────────────────────────
  // Optional (see the rule on RemoteInfoSchema below).
  runtimes: RuntimesSchema.optional(),
});
export type HarnessInfo = z.infer<typeof HarnessInfoSchema>;

export const RemoteInfoSchema = z.object({
  helmVersion: z.string(),
  headless: z.boolean(),
  harnesses: z.array(HarnessInfoSchema),
  agentCount: z.number(),
  uptimeSec: z.number(),
  // ── Added in M-remote-2 ───────────────────────────────────────────────────
  // Optional, and they must stay optional for at least one release: this schema
  // is parsed strictly by the local side, so a required field would make a
  // newer local helm fail to ping an older remote — and breaking `ping` is the
  // worst outcome, because ping is how the user *sees* version skew.
  //
  // Absent bundleFormats means an M1 daemon that cannot accept a bundle at all.
  bundleFormats: z.array(z.number()).optional(),
  paused: z.boolean().optional(),
  deployedAgentCount: z.number().optional(),
  // ── Added in harness H0 (same optionality rule) ───────────────────────────
  /** Git short sha of the running build; two 0.1.0 daemons can differ. */
  helmBuild: z.string().optional(),
  /** Index of the newest applied drizzle migration; skew here 500s the handshake. */
  schemaVersion: z.number().int().optional(),
  // ── Added in harness H1 (same optionality rule) ───────────────────────────
  /**
   * The bundle format this daemon *writes* on export. Recall preflight checks
   * it against what the local side can read, so a recall is refused with a
   * sentence instead of the remote deactivating its agent and streaming a
   * bundle the local then cannot import.
   */
  bundleWrites: z.number().int().optional(),
  // ── Added in machine parity P0 (same optionality rule) ────────────────────
  /**
   * What the machine under the daemon is: OS, uid/root/sudo, the app dir and
   * absolute node/pnpm — what a check compares and what recipes need handed
   * to them, since `ssh … bash -s` is a non-login shell with no nvm PATH.
   */
  machine: MachineFactsSchema.optional(),
});
export type RemoteInfo = z.infer<typeof RemoteInfoSchema>;

const execFileAsync = promisify(execFile);

// Memoized with a TTL: `claude --version` is stable for minutes at a time, and
// the handshake must stay cheap (no child process per ping) — but not for the
// daemon's whole lifetime, because `remote:init --claude <v>` and the local
// auto-updater both change the binary underneath a running process, and the
// version is now something ship preflight *refuses* on.
const PROBE_TTL_MS = 60_000;

let claudeInfo: { at: number; value: Promise<HarnessInfo> } | undefined;

/** The claude-code harness on *this* machine — local console or headless daemon alike. */
export function localHarnessInfo(): Promise<HarnessInfo> {
  const now = Date.now();
  if (!claudeInfo || now - claudeInfo.at > PROBE_TTL_MS) {
    claudeInfo = { at: now, value: probeClaude() };
  }
  return claudeInfo.value;
}

async function probeClaude(): Promise<HarnessInfo> {
  const runtimes = await detectRuntimes();
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], {
      timeout: 15_000,
      env: machineEnv(),
    });
    const version = /\d+[^\s]*/.exec(stdout.trim())?.[0] ?? null;
    // Headless: authed iff the OAuth token env is present and remote:init's
    // `claude -p ping` smoke test passed. Local: the CLI resolving at all
    // implies a usable keychain login.
    const authOk = config.headless
      ? Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) && readRemoteJson()?.smokeOk === true
      : true;
    return { type: 'claude-code', version, authOk, runtimes };
  } catch {
    return { type: 'claude-code', version: null, authOk: false, runtimes };
  }
}

/** What this machine can start an MCP server or a tool with. Cheap: four PATH probes. */
export async function detectRuntimes(): Promise<Runtimes> {
  const [node, python3, npx, uvx] = await Promise.all([
    versionOf('node', ['--version']),
    versionOf('python3', ['--version']),
    onPath('npx'),
    onPath('uvx'),
  ]);
  return { node, python3, npx, uvx };
}

/** Test seam: forget the probe so the next call re-runs it. */
export function clearHarnessProbe(): void {
  claudeInfo = undefined;
}

export async function getRemoteInfo(): Promise<RemoteInfo> {
  const all = db.select().from(agents).where(eq(agents.isOperator, false)).all();
  return {
    helmVersion: HELM_VERSION,
    helmBuild: HELM_BUILD,
    headless: config.headless,
    harnesses: [await localHarnessInfo()],
    agentCount: all.length,
    uptimeSec: Math.floor(process.uptime()),
    // The bundle formats this daemon can import. Ship preflight checks its own
    // BUNDLE_FORMAT_VERSION against this before spending time building a bundle.
    bundleFormats: [BUNDLE_FORMAT_VERSION],
    bundleWrites: BUNDLE_FORMAT_VERSION,
    paused: isPaused(),
    deployedAgentCount: all.filter((a) => a.deployedTo !== null).length,
    schemaVersion: appliedSchemaVersion(),
    machine: await machineFacts(),
  };
}

/**
 * How many migrations drizzle's migrator has applied to this database, read
 * from its own bookkeeping table (one row per applied migration, so this is
 * the journal index + 1). Undefined when the table is missing — a database
 * migrated by hand, e.g. the test fixture.
 */
export function appliedSchemaVersion(): number | undefined {
  try {
    const row = db.get<{ n: number }>(sql`select count(*) as n from __drizzle_migrations`);
    return row ? row.n : undefined;
  } catch {
    return undefined;
  }
}
