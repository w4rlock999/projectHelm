import { spawn } from 'node:child_process';
import type {
  AdapterContext,
  AgentAdapter,
  ClaudeEvent,
  ClaudeResultEvent,
  HelmNoticeEvent,
} from './types.ts';

const DEFAULT_MODEL = 'sonnet';

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

/** One `claude -p` process, streamed. */
export const spawnClaudeAttempt: ClaudeAttempt = (ctx, { resume }) => {
  const proc = spawn('claude', buildClaudeArgs(ctx.agent, resume), {
    cwd: ctx.agent.workspaceDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: ctx.env ? { ...process.env, ...ctx.env } : process.env,
  });

  proc.stdin.write(ctx.prompt);
  proc.stdin.end();

  const onAbort = () => {
    if (!proc.killed) proc.kill('SIGTERM');
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

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => ctx.onLog('stderr', chunk));

  return new Promise((resolve, reject) => {
    proc.on('error', (err) => {
      ctx.signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    proc.on('close', (code) => {
      ctx.signal.removeEventListener('abort', onAbort);
      resolve({ code, sessionInvalid: sink.sessionInvalid });
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
): Promise<{ code: number | null }> {
  const attempt = opts.attempt ?? spawnClaudeAttempt;
  const stale = ctx.agent.claudeSessionId ?? null;

  const first = await attempt(ctx, { resume: stale });
  if (!first.sessionInvalid || stale === null) return { code: first.code };

  if (ctx.signal.aborted) {
    // Not recovering, so the withheld failure is all this turn produced —
    // forward it rather than swallowing it entirely.
    ctx.onEvent(first.sessionInvalid);
    return { code: first.code };
  }

  // Clearing happens in the caller's handler, before the retry: if attempt two
  // is aborted or fails too, the agent must still be un-bricked for next time.
  ctx.onSessionInvalid({ staleSessionId: stale, result: first.sessionInvalid });
  ctx.onEvent(sessionResetNotice(stale));

  const second = await attempt(ctx, { resume: null });
  return { code: second.code };
}
