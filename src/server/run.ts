import { createWriteStream, mkdirSync } from 'node:fs';
import { buildClaudeArgs, resultText, runClaude } from './adapter/claude.ts';
import { agentRuntime, loadAgent, updateAgentLastHarness, updateAgentSessionId } from './agents.ts';
import { config } from './config.ts';
import {
  fingerprintDelta,
  fingerprintFromInit,
  type HarnessFingerprint,
} from './harness/fingerprint.ts';
import { listAgentMcpServers } from './library/mcp.ts';
import { mcpSecretValues, scrubSecrets } from './library/mcp-schema.ts';
import { paths, SHARED_SESSION_KEY } from './paths.ts';
import { getInternalToken } from './remote-auth.ts';
import {
  markRunErrored,
  markRunFinished,
  markRunInterrupted,
  markRunStarted,
  reserveRun,
} from './runs.ts';
import { renderAgentHarness } from './tools.ts';
import type { ClaudeEvent } from './adapter/types.ts';
import type { Agent } from '../db/schema.ts';

export interface AgentTurnResult {
  runId: string;
  text: string;
  sessionId: string | null;
  code: number | null;
  isError: boolean;
  /**
   * What the CLI loaded for this turn (from `system/init`), or null when it
   * died before saying. The remote's import smoke turn returns this to the
   * shipping side so the two harnesses can be compared.
   */
  harness: HarnessFingerprint | null;
}

/**
 * The session a turn resumes/persists. Decoupling this from the agent lets a
 * turn run against either the agent's shared session (browser, heartbeats,
 * sessionScope='agent') or a per-chat session (sessionScope='chat').
 */
export interface SessionStore {
  get(): string | null;
  set(sid: string): void;
  /**
   * Forget the stored id because the transcript no longer exists (Claude Code
   * prunes after `cleanupPeriodDays`). The next turn starts a fresh
   * conversation.
   *
   * Only the *Claude* session is dropped — the durable data plane under
   * `paths.agentSessionStoreDir` is keyed by chat id or 'shared' and survives,
   * so a reset agent still has its notes. That is what makes starting over
   * tolerable rather than total amnesia.
   */
  clear(): void;
}

/** Agent-backed session: the shared `agents.claudeSessionId`. The default. */
export function agentStore(agent: Pick<Agent, 'id' | 'claudeSessionId'>): SessionStore {
  let current = agent.claudeSessionId;
  return {
    get: () => current,
    set: (sid) => {
      current = sid;
      updateAgentSessionId(agent.id, sid);
    },
    clear: () => {
      current = null;
      updateAgentSessionId(agent.id, null);
    },
  };
}

// Per-agent serialization. Headless triggers (heartbeats, inbound gateway
// messages) can fire concurrently for the same agent; running two `--resume`
// turns against one Claude session at once corrupts it. We chain each agent's
// turns through a single in-flight promise so they execute one at a time.
const agentChains = new Map<string, Promise<unknown>>();

function enqueue<T>(agentId: string, task: () => Promise<T>): Promise<T> {
  const prev = agentChains.get(agentId) ?? Promise.resolve();
  const next = prev.then(task, task);
  // Keep the chain alive but don't leak rejections into the next link's catch.
  agentChains.set(
    agentId,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Wait for the agent's in-flight turn (and anything already queued behind it) to
 * finish. Returns false on timeout.
 *
 * Only a *true* drain once the run gate is already shut for this agent — i.e.
 * after `deployState` has been persisted — because nothing stops a new turn
 * joining the chain otherwise. Ship relies on that ordering.
 */
export async function drainAgentRuns(agentId: string, timeoutMs = 120_000): Promise<boolean> {
  const tail = agentChains.get(agentId);
  if (!tail) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([
      tail.then(
        () => true as const,
        () => true as const,
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run one headless agent turn to completion and return the final assistant
 * text. Reuses the same `runClaude` primitive and `.ndjson` run logs as the SSE
 * chat route, persists the resolved session id, and serializes turns per agent.
 *
 * The SSE chat route keeps its own streaming path; this is for triggers that
 * just need the result (cron heartbeats, inbound Telegram messages).
 */
export function runAgentTurn(
  agentId: string,
  prompt: string,
  opts: {
    source?: string;
    signal?: AbortSignal;
    /** Session to resume/persist. Defaults to the agent's shared session. */
    session?: SessionStore;
    /**
     * Durable session-store dir key (see resolveSessionKey in runtime/gateways).
     * Defaults to 'shared' — the agent-scope / console / 'main'-heartbeat session.
     */
    sessionKey?: string;
    /** Telegram chat this turn belongs to; injected as HELM_CHAT_ID. */
    chatId?: string;
    /** Per-event hook (e.g. SSE streaming for the browser chat route). */
    onEvent?: (evt: ClaudeEvent) => void;
    /** Fired once with the runId before streaming starts. */
    onRunId?: (runId: string) => void;
  } = {},
): Promise<AgentTurnResult> {
  // Admission control runs BEFORE enqueue, so a refusal is immediate instead of
  // waiting out an in-flight turn it was never going to join. reserveRun also
  // *claims* the slot, which is what keeps a batch of simultaneous triggers from
  // all passing the same budget check.
  const source = opts.source ?? 'manual';
  const sessionKey = opts.sessionKey ?? SHARED_SESSION_KEY;
  const { runId } = reserveRun(agentId, { source, prompt, sessionKey });
  // Fires at reservation rather than turn start — strictly better for the SSE
  // chat route, which can emit its `open` event without waiting in line.
  opts.onRunId?.(runId);

  return enqueue(agentId, async () => {
    const agent = loadAgent(agentId);
    if (!agent) {
      markRunErrored(runId, `agent ${agentId} not found`);
      throw new Error(`agent ${agentId} not found`);
    }
    markRunStarted(runId);

    const session = opts.session ?? agentStore(agent);
    const runtime = agentRuntime(agent);

    // Render-before-spawn. Inside the chain no `claude` is running for this
    // agent, so wiping the workspace's `.claude/` (the project setting source
    // the agent could have written to) cannot race a CLI reading it. Cheap:
    // three small files.
    renderAgentHarness(agentId);

    mkdirSync(paths.agentLogsDir(agent.id), { recursive: true });
    const logStream = createWriteStream(paths.agentLogFile(agent.id, runId), { flags: 'a' });
    // The argv is logged so a run can be reproduced by hand and so a harness
    // flag change is visible next to the fingerprint it produced.
    logStream.write(
      JSON.stringify({
        type: 'helm_meta',
        source,
        prompt,
        runId,
        argv: buildClaudeArgs(runtime, session.get()),
      }) + '\n',
    );

    let text = '';
    let sessionId: string | null = session.get();
    let isError = false;
    let harness: HarnessFingerprint | null = null;
    let sawResult = false;
    const signal = opts.signal ?? new AbortController().signal;

    // Durable data plane, exposed to the turn's tools as env paths (cwd stays the
    // shared workspace). The agent store is shared across the agent's sessions;
    // the session store is per-conversation ('shared' unless the caller passed a
    // chat key). Per-chat session stores are created here on first use.
    const storeDir = paths.agentStoreDir(agentId);
    const sessionStoreDir = paths.agentSessionStoreDir(agentId, sessionKey);
    mkdirSync(storeDir, { recursive: true });
    mkdirSync(sessionStoreDir, { recursive: true });
    // Cross-session recall is a per-agent authz control (not a caller opt): when
    // enabled, expose the parent of all session stores so the agent can read
    // across its own sessions. Under 'none' the var is absent and each turn sees
    // only its own HELM_SESSION_STORE_DIR.
    const sessionsRootDir = agent.sessionRecall === 'all' ? paths.agentSessionsDir(agentId) : null;

    try {
      const { code, stderrTail } = await runClaude({
        // Resume the store's session (per-chat or agent), not whatever the
        // agent row happens to hold.
        agent: { ...runtime, claudeSessionId: session.get() },
        prompt,
        signal,
        env: {
          // Identifies the agent to its built-in tools (heartbeat, send-telegram),
          // which call back into the daemon at /api/agents/<id>/…
          HELM_AGENT_ID: agentId,
          // Where those tool scripts reach the daemon (their default is
          // localhost:3000). In headless mode the /api surface requires auth,
          // so agents also get the per-process internal token — local mode
          // stays token-free (unchanged behavior).
          HELM_BASE_URL: config.baseUrl,
          ...(config.headless ? { HELM_INTERNAL_TOKEN: getInternalToken() } : {}),
          HELM_AGENT_STORE_DIR: storeDir,
          HELM_SESSION_STORE_DIR: sessionStoreDir,
          // Always set (blank when recall is off) so the agent's DB knob is the
          // sole source of truth — a stray HELM_SESSIONS_DIR in the daemon's own
          // environment can't leak cross-session recall to a 'none' agent.
          HELM_SESSIONS_DIR: sessionsRootDir ?? '',
          ...(opts.chatId ? { HELM_CHAT_ID: opts.chatId } : {}),
        },
        onEvent: (evt: ClaudeEvent) => {
          logStream.write(JSON.stringify(evt) + '\n');
          opts.onEvent?.(evt);
          if (evt.type === 'system' && evt.subtype === 'init') {
            // The CLI states what it loaded before the first API call. Persist
            // it on the agent here — inside the chain, after the run gate — so
            // "last harness" can never be written by a turn a ship raced.
            harness = fingerprintFromInit(evt as Record<string, unknown>);
            // Anything the agent could notice changing between its last turn
            // and this one goes to the daemon log, so a hidden dependency on a
            // host skill or plugin surfaces there rather than as a quietly
            // worse agent.
            const delta = agent.lastHarness ? fingerprintDelta(agent.lastHarness, harness) : [];
            if (delta.length > 0) {
              console.log(`[helm] agent ${agent.name}: harness changed — ${delta.join(', ')}`);
            }
            updateAgentLastHarness(agentId, harness);
          }
          if (evt.type === 'result') {
            sawResult = true;
            // Not `evt.result ?? ''`: a turn that failed before it started has
            // no `result` at all and names the reason only in `errors`, which
            // is how a dead session used to reach the ledger explaining nothing.
            text = resultText(evt);
            isError = evt.is_error;
          }
        },
        onSessionInvalid: ({ staleSessionId, result }) => {
          // Wrapped rather than written as a bare `result` line so no future
          // reader mistakes a suppressed failure for the turn's real outcome.
          logStream.write(
            JSON.stringify({ type: 'helm_session_reset', staleSessionId, suppressed: result }) +
              '\n',
          );
          // Before the retry, deliberately: if the second attempt is aborted or
          // fails too, the agent is still un-bricked for the next turn. The
          // retry is the nicety; this line is the fix.
          session.clear();
          sessionId = null;
          console.warn(
            `[helm] agent ${agentId}: session ${staleSessionId} no longer exists — starting fresh`,
          );
        },
        onLog: () => {
          /* stdout already captured via onEvent; stderr is debug-only */
        },
        onSessionId: (sid) => {
          if (sid !== sessionId) {
            sessionId = sid;
            session.set(sid);
          }
        },
      });
      if (!sawResult && signal.aborted) {
        // The caller cancelled (browser refresh, Stop). The adapter SIGTERMs the
        // child and resolves normally, so this is the only place that knows the
        // turn was cut short rather than finished — and the console's history
        // replay needs the ledger to say so.
        isError = true;
        text = 'The turn was interrupted before it produced a result.';
        markRunInterrupted(runId, { code, harness });
        return { runId, text, sessionId, code, isError, harness };
      }
      if (!sawResult && code !== 0) {
        // The CLI died without ever emitting a `result` — a bad flag, a
        // malformed settings file, a missing binary on PATH. `isError` is only
        // ever set from a result event, so without this the ledger would record
        // such a run as `ok` and the remote's import smoke turn would pass on
        // an agent that can never run.
        isError = true;
        // The tail is persisted in the ledger and shown in the console, and an
        // MCP server that dies at start-up may have echoed its environment.
        const secrets = listAgentMcpServers(agentId).flatMap((s) => mcpSecretValues(s.config));
        const why = stderrTail ? scrubSecrets(stderrTail, secrets).trim() : '';
        text = `claude exited with code ${code} before producing a result${why ? `: ${why}` : ''}`;
      }
      markRunFinished(runId, { code, isError, text, harness });
      return { runId, text, sessionId, code, isError, harness };
    } catch (err) {
      markRunErrored(runId, err instanceof Error ? err.message : String(err), harness);
      throw err;
    } finally {
      // Awaited on purpose: the SSE route emits `end` once this promise settles
      // and the console immediately refetches history, which reads this file.
      // An un-awaited end() could leave the `result` line still in the buffer.
      await new Promise<void>((resolve) => logStream.end(resolve));
    }
  });
}
