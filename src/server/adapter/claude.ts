import { spawn, type ChildProcess } from 'node:child_process';
import { harnessFlags } from '../harness/profile.ts';
import type {
  AdapterContext,
  AgentAdapter,
  ClaudeEvent,
  ClaudeResultEvent,
  HelmNoticeEvent,
} from './types.ts';

export const DEFAULT_MODEL = 'sonnet';

// Tools pre-granted when an agent doesn't declare its own allow-list.
// In `-p` mode, Claude Code cannot ask interactively — so anything NOT in
// --allowedTools is denied and surfaces as an "X needs permission" message
// in the assistant's response. This default is the safe-non-destructive set
// (file IO scoped to workspace cwd + web access). Bash is intentionally
// excluded — agents that need shell exec must opt in via their allowedTools.
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
];

export const claudeAdapter: AgentAdapter = {
  type: 'claude-code',
  execute(ctx) {
    return runClaude(ctx);
  },
};

/**
 * Argv for one attempt.
 *
 * `resume` is the **only** source of `--resume` — deliberately not
 * `agent.claudeSessionId`, so the recovery attempt is structurally incapable of
 * resuming the session that just turned out to be missing.
 *
 * Model, allow-list and every profile knob live **only** here, never in the
 * rendered `--settings` file: flags beat settings, and one owner per knob is
 * what keeps the argv in the run log a complete statement of the spawn.
 */
export function buildClaudeArgs(agent: AdapterContext['agent'], resume: string | null): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (resume) args.push('--resume', resume);
  const allowedTools =
    agent.allowedTools && agent.allowedTools.length > 0
      ? agent.allowedTools
      : DEFAULT_ALLOWED_TOOLS;
  args.push('--allowedTools', allowedTools.join(','));
  args.push('--model', agent.model ?? DEFAULT_MODEL);
  // Isolation from the host's ~/.claude plus the effective profile. Absent
  // only in unit tests; agentRuntime always supplies it.
  if (agent.harness) args.push(...harnessFlags(agent.harness));
  return args;
}

/**
 * The CLI's "that transcript is gone" result: `--resume` named a session Claude
 * Code no longer has, so it refused before running a single turn.
 *
 *     {"type":"result","subtype":"error_during_execution","is_error":true,
 *      "num_turns":0,"errors":["No conversation found with session ID: …"]}
 *
 * Matched on the error *message* rather than structurally (subtype + zero turns
 * + zero cost) on purpose. The structural match also catches unrelated startup
 * failures — a bad `--model`, a malformed allow-list — and clearing a *live*
 * session id on one of those would throw away a real conversation. If the CLI
 * ever rewords this, recovery degrades to the old behaviour rather than to
 * something worse.
 */
export function isSessionNotFoundResult(evt: ClaudeEvent): boolean {
  return (
    evt.type === 'result' &&
    evt.is_error === true &&
    Array.isArray(evt.errors) &&
    evt.errors.some((e) => /no conversation found with session id/i.test(String(e)))
  );
}

/**
 * Where one streamed event goes. Pure, so the suppression rule is testable
 * without a child process.
 *
 * `forwardedAny` is the safety interlock for the retry: it proves the model
 * never produced anything, hence ran no tools, so re-sending the identical
 * prompt cannot double a side effect. A mid-conversation failure that happens
 * to mention a session id is forwarded like any other failure.
 */
export function eventDisposition(args: {
  /** Did this attempt pass `--resume`? */
  resumed: boolean;
  /** Has any event already reached `ctx.onEvent` on this attempt? */
  forwardedAny: boolean;
  event: ClaudeEvent;
}): 'forward' | 'session-invalid' {
  const { resumed, forwardedAny, event } = args;
  return resumed && !forwardedAny && isSessionNotFoundResult(event) ? 'session-invalid' : 'forward';
}

/** The chat-visible marker that history was dropped and this turn started over. */
export function sessionResetNotice(staleSessionId: string): HelmNoticeEvent {
  return {
    type: 'helm_notice',
    notice: 'session_reset',
    text: 'Previous session expired — starting a fresh conversation.',
    session_id: staleSessionId,
  };
}

/**
 * What the run ledger should record for a result event.
 *
 * A failed turn often has no `result` at all and states the reason only in
 * `errors` — which is why a dead-session failure used to land in the ledger as
 * `status=error` with empty text, explaining nothing to `helm agent runs`.
 */
export function resultText(evt: ClaudeResultEvent): string {
  if (evt.result && evt.result.trim()) return evt.result;
  const errors = (evt.errors ?? []).filter(Boolean);
  if (errors.length > 0) return errors.join('; ');
  return evt.is_error ? `claude exited with ${evt.subtype}` : '';
}

export interface AttemptResult {
  code: number | null;
  /**
   * Set when this attempt died solely because `--resume` named a pruned
   * session. The result event was withheld from `ctx.onEvent` and is handed
   * back here instead.
   */
  sessionInvalid: ClaudeResultEvent | null;
  /**
   * The last few KB of stderr. A CLI that dies at argv/config parse (an unknown
   * `--effort`, a `--settings` file with a JSON error, a bad `--model`) writes
   * the reason here and exits non-zero without emitting a single stream-json
   * event — so this is the only explanation such a run will ever have.
   */
  stderrTail?: string;
}

/** Upper bound on the stderr kept per attempt. */
export const STDERR_TAIL_BYTES = 8 * 1024;

/** Keep the *end* of a stream, bounded. */
export function appendTail(tail: string, chunk: string, limit = STDERR_TAIL_BYTES): string {
  const joined = tail + chunk;
  return joined.length > limit ? joined.slice(joined.length - limit) : joined;
}

export type ClaudeAttempt = (
  ctx: AdapterContext,
  opts: { resume: string | null },
) => Promise<AttemptResult>;

export interface RunClaudeOptions {
  /**
   * Seam for unit tests, so the recovery sequence can be exercised without a
   * `claude` binary (cf. sweepRecallOrphans' `deleter`).
   * Production callers pass nothing.
   */
  attempt?: ClaudeAttempt;
}

/**
 * Routes one attempt's events, owning the `forwardedAny` / `sessionInvalid`
 * state that `eventDisposition` decides against.
 *
 * Split out of the spawn so the suppression *wiring* — not merely the decision
 * — can be exercised without a child process.
 */
export function createAttemptSink(ctx: AdapterContext, resume: string | null) {
  let forwardedAny = false;
  let withheld: ClaudeResultEvent | null = null;

  return {
    accept(evt: ClaudeEvent): void {
      if (evt.type === 'system' && evt.subtype === 'init') {
        ctx.onSessionId(evt.session_id);
      }
      if (eventDisposition({ resumed: resume !== null, forwardedAny, event: evt }) === 'forward') {
        forwardedAny = true;
        ctx.onEvent(evt);
      } else {
        withheld = evt as ClaudeResultEvent;
      }
    },
    get sessionInvalid(): ClaudeResultEvent | null {
      return withheld;
    },
  };
}

/** How long a SIGTERM'd process group gets before SIGKILL. */
export const KILL_GRACE_MS = 5_000;

// Live `claude` process groups, so a daemon that exits with turns in flight
// takes its children with it. Each spawn is its own process group (see
// `detached` below), which is what makes the whole tree killable but also
// means the shell's SIGINT/SIGHUP to the daemon's group no longer reaches them.
const liveGroups: Set<ChildProcess> =
  (globalThis as any).__helmClaudeGroups ?? ((globalThis as any).__helmClaudeGroups = new Set());
if (!(globalThis as any).__helmClaudeExitHook) {
  (globalThis as any).__helmClaudeExitHook = true;
  process.once('exit', () => {
    for (const p of liveGroups) killGroup(p, 'SIGKILL');
  });
}

/**
 * Signal the child's whole process group — the CLI and every stdio MCP server
 * it spawned. A SIGTERM to the CLI alone leaves those servers running on a
 * cancelled turn (and, on the VPS, until systemd tears the cgroup down).
 */
function killGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    // Not a group leader (Windows, or the group already gone): fall back.
    try {
      proc.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

/** One `claude -p` process, streamed. */
export const spawnClaudeAttempt: ClaudeAttempt = (ctx, { resume }) => {
  const proc = spawn('claude', buildClaudeArgs(ctx.agent, resume), {
    cwd: ctx.agent.workspaceDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: ctx.env ? { ...process.env, ...ctx.env } : process.env,
    // Own process group, so an abort can kill the CLI *and* the MCP servers
    // it started. Not unref'd: the daemon still waits on it.
    detached: process.platform !== 'win32',
  });
  liveGroups.add(proc);

  proc.stdin.write(ctx.prompt);
  proc.stdin.end();

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    killGroup(proc, 'SIGTERM');
    killTimer = setTimeout(() => killGroup(proc, 'SIGKILL'), KILL_GRACE_MS);
    killTimer.unref?.();
  };
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  // A signal that is *already* aborted never fires the listener, so without
  // this the child of a cancelled turn would run on unkillable.
  if (ctx.signal.aborted) onAbort();

  const sink = createAttemptSink(ctx, resume);

  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    ctx.onLog('stdout', chunk);
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let evt: ClaudeEvent;
      try {
        evt = JSON.parse(line) as ClaudeEvent;
      } catch {
        continue;
      }
      sink.accept(evt);
    }
  });

  let stderrTail = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    ctx.onLog('stderr', chunk);
    stderrTail = appendTail(stderrTail, chunk);
  });

  const settle = () => {
    ctx.signal.removeEventListener('abort', onAbort);
    if (killTimer) clearTimeout(killTimer);
    liveGroups.delete(proc);
  };
  return new Promise((resolve, reject) => {
    proc.on('error', (err) => {
      settle();
      reject(err);
    });
    proc.on('close', (code) => {
      settle();
      resolve({ code, sessionInvalid: sink.sessionInvalid, stderrTail });
    });
  });
};

/**
 * Run one turn, recovering once from a Claude session that no longer exists.
 *
 * Claude Code prunes transcripts after `cleanupPeriodDays` (30 by default), so
 * any agent idle longer than that holds a `claudeSessionId` that `--resume`
 * cannot find. Before this, that was terminal: the CLI failed before emitting
 * `system/init`, so `onSessionId` never fired, the dead id was never replaced,
 * and *every* subsequent turn failed the same way.
 *
 * Straight-line rather than a loop, so there is no counter to get wrong: at
 * most one recovery, and the second attempt cannot report `sessionInvalid`
 * anyway because `eventDisposition` requires `resumed`.
 */
export async function runClaude(
  ctx: AdapterContext,
  opts: RunClaudeOptions = {},
): Promise<{ code: number | null; stderrTail?: string }> {
  const attempt = opts.attempt ?? spawnClaudeAttempt;
  const stale = ctx.agent.claudeSessionId ?? null;

  const first = await attempt(ctx, { resume: stale });
  if (!first.sessionInvalid || stale === null) {
    return { code: first.code, stderrTail: first.stderrTail };
  }

  if (ctx.signal.aborted) {
    // Not recovering, so the withheld failure is all this turn produced —
    // forward it rather than swallowing it entirely.
    ctx.onEvent(first.sessionInvalid);
    return { code: first.code, stderrTail: first.stderrTail };
  }

  // Clearing happens in the caller's handler, before the retry: if attempt two
  // is aborted or fails too, the agent must still be un-bricked for next time.
  ctx.onSessionInvalid({ staleSessionId: stale, result: first.sessionInvalid });
  ctx.onEvent(sessionResetNotice(stale));

  const second = await attempt(ctx, { resume: null });
  return { code: second.code, stderrTail: second.stderrTail };
}
