import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { agents } from '../db/schema.ts';
import { paths, SHARED_SESSION_KEY } from './paths.ts';
import { syncAgentTools } from './tools.ts';
import { DEFAULT_ALLOWED_TOOLS, DEFAULT_MODEL } from './adapter/claude.ts';
import { getHarnessDefaults } from './harness/defaults.ts';
import {
  assertProfileRunnable,
  harnessAllowedTools,
  resolveHarnessProfile,
  type HarnessArgv,
  type HarnessProfile,
} from './harness/profile.ts';
import type { HarnessFingerprint } from './harness/fingerprint.ts';
import type { Agent } from '../db/schema.ts';

export interface CreateAgentInput {
  name: string;
  systemPrompt: string;
  allowedTools?: string[] | null;
  model?: string | null;
  /** Per-agent harness profile; null/absent inherits the fleet defaults. */
  harness?: HarnessProfile | null;
}

export function createAgent(input: CreateAgentInput): Agent {
  const id = randomUUID();
  const workspaceDir = paths.agentWorkspaceDir(id);
  const logsDir = paths.agentLogsDir(id);
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  // Durable data plane: the agent store (shared) and the SHARED_SESSION_KEY
  // session store (used by the agent-scope session, console, and 'main'
  // heartbeats). Per-chat session stores are created lazily on first turn.
  mkdirSync(paths.agentStoreArtifactsDir(id), { recursive: true });
  mkdirSync(paths.agentSessionStoreArtifactsDir(id, SHARED_SESSION_KEY), { recursive: true });

  const harness = input.harness ?? null;
  // Refuse a profile the CLI would die on, before the row exists.
  assertProfileRunnable(
    resolveHarnessProfile(harness, getHarnessDefaults()),
    input.model ?? DEFAULT_MODEL,
  );

  const row = {
    id,
    name: input.name,
    systemPrompt: input.systemPrompt,
    allowedTools: input.allowedTools?.length ? input.allowedTools.join(',') : null,
    model: input.model ?? null,
    claudeSessionId: null,
    // New agents default to isolated per-chat sessions...
    sessionScope: 'chat' as const,
    // ...and to no cross-session recall (each session is context-isolated).
    sessionRecall: 'none' as const,
    isOperator: false,
    // Locally live and unbudgeted until a ship or an explicit budget says
    // otherwise. Spelled out rather than left to the column defaults because
    // this object is returned to the caller as the created Agent.
    deployedTo: null,
    deployState: null,
    deployedAt: null,
    deployError: null,
    runBudgetPerHour: null,
    // Filled by the first turn's `system/init` (run.ts).
    lastHarness: null,
    harness,
    createdAt: new Date(),
  };
  db.insert(agents).values(row).run();
  // Materializes built-in tools (heartbeat), renders the harness files and
  // writes CLAUDE.md with the tools block.
  syncAgentTools(id);
  return row;
}

/** The model alias the CLI is actually given (`--model`). */
export function effectiveModel(a: Pick<Agent, 'model'>): string {
  return a.model ?? DEFAULT_MODEL;
}

/** The agent's profile with fleet defaults filled in — what the CLI is spawned with. */
export function resolvedHarnessProfile(a: Pick<Agent, 'harness'>): HarnessProfile {
  return resolveHarnessProfile(a.harness, getHarnessDefaults());
}

/**
 * Set (or with null, clear) the agent's own harness profile, then re-render.
 * Validated against the *effective* profile so a fleet default cannot be
 * combined into something the CLI refuses.
 */
export function updateAgentHarness(id: string, harness: HarnessProfile | null): void {
  const agent = loadAgent(id);
  if (!agent) throw new Error(`agent ${id} not found`);
  assertProfileRunnable(
    resolveHarnessProfile(harness, getHarnessDefaults()),
    effectiveModel(agent),
  );
  db.update(agents).set({ harness }).where(eq(agents.id, id)).run();
  syncAgentTools(id);
}

/** The user-facing fleet — excludes the operator (helmCaptain). */
export function listAgents(): Agent[] {
  return db.select().from(agents).where(eq(agents.isOperator, false)).all();
}

export function loadAgent(id: string): Agent | null {
  return db.select().from(agents).where(eq(agents.id, id)).get() ?? null;
}

export function updateAgentSystemPrompt(id: string, systemPrompt: string): void {
  db.update(agents).set({ systemPrompt }).where(eq(agents.id, id)).run();
  // Re-render CLAUDE.md so the managed tools block is preserved below the prompt.
  syncAgentTools(id);
}

/** `null` forgets the session — see SessionStore.clear in run.ts. */
export function updateAgentSessionId(id: string, sessionId: string | null): void {
  db.update(agents).set({ claudeSessionId: sessionId }).where(eq(agents.id, id)).run();
}

/**
 * Record what the harness actually loaded on the agent's latest turn. Written
 * from inside the per-agent run chain (run.ts), so it never races a ship.
 */
export function updateAgentLastHarness(id: string, lastHarness: HarnessFingerprint): void {
  db.update(agents).set({ lastHarness }).where(eq(agents.id, id)).run();
}

/** 'chat' = isolated per Telegram chat; 'agent' = one shared session for everything. */
export function updateAgentSessionScope(id: string, sessionScope: 'chat' | 'agent'): void {
  db.update(agents).set({ sessionScope }).where(eq(agents.id, id)).run();
}

/**
 * 'none' = the agent only sees the current session's store; 'all' = it may read
 * across every session store (exposed as HELM_SESSIONS_DIR). Re-renders CLAUDE.md
 * so the "Your data" block reflects the new recall permission.
 */
export function updateAgentSessionRecall(id: string, sessionRecall: 'none' | 'all'): void {
  db.update(agents).set({ sessionRecall }).where(eq(agents.id, id)).run();
  syncAgentTools(id);
}

/**
 * Rolling-window cap on turns from every source. null = unlimited.
 *
 * Enforced centrally in src/server/runs.ts, so it applies to heartbeats,
 * inbound gateway messages and the console alike — a limit that only covered
 * the unattended paths would not be a limit.
 */
export function updateAgentRunBudget(id: string, runBudgetPerHour: number | null): void {
  db.update(agents).set({ runBudgetPerHour }).where(eq(agents.id, id)).run();
}

export function resetAgentSession(id: string): void {
  db.update(agents).set({ claudeSessionId: null }).where(eq(agents.id, id)).run();
}

/**
 * Thrown when an operation would strand an agent that lives on a remote.
 * The local row holds the only record of `deployedTo`, so deleting it orphans a
 * live remote agent permanently — it keeps polling Telegram with nothing left
 * here that knows it exists.
 */
export class DeployedAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployedAgentError';
  }
}

export function deleteAgent(id: string, opts: { force?: boolean } = {}): void {
  const agent = loadAgent(id);
  if (agent && agent.deployState !== null && !opts.force) {
    throw new DeployedAgentError(
      `"${agent.name}" is ${agent.deployState} on a remote — recall it before deleting, ` +
        `or the remote copy keeps running with nothing here tracking it`,
    );
  }
  db.delete(agents).where(eq(agents.id, id)).run();
  rmSync(paths.agentDir(id), { recursive: true, force: true });
}

export function agentRuntime(a: Agent): {
  id: string;
  workspaceDir: string;
  claudeSessionId: string | null;
  allowedTools?: string[] | null;
  model?: string | null;
  harness: HarnessArgv;
} {
  // Every agent invokes tools via Bash — regular agents have the built-in
  // heartbeat tool, and helmCaptain now has the helm CLI — so Bash is always
  // in the allow-list.
  const base = a.allowedTools
    ? a.allowedTools
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_ALLOWED_TOOLS];
  if (!base.includes('Bash')) base.push('Bash');

  // The harness is described here from the database and the well-known file
  // paths; the files themselves are (re)written by renderAgentHarness right
  // before the spawn (run.ts), so this never reads the filesystem.
  const harness: HarnessArgv = {
    settingsFile: paths.agentHarnessSettings(a.id),
    mcpConfigFile: paths.agentHarnessMcp(a.id),
    pluginDirs: [],
    profile: resolvedHarnessProfile(a),
    mcpServerNames: [],
    hasSkills: false,
  };
  for (const t of harnessAllowedTools(harness)) if (!base.includes(t)) base.push(t);

  return {
    id: a.id,
    workspaceDir: paths.agentWorkspaceDir(a.id),
    claudeSessionId: a.claudeSessionId,
    allowedTools: base,
    model: a.model,
    harness,
  };
}
