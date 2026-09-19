import { describe, expect, it } from 'vitest';
import {
  appendTail,
  buildClaudeArgs,
  createAttemptSink,
  eventDisposition,
  isSessionNotFoundResult,
  resultText,
  runClaude,
  sessionResetNotice,
  type ClaudeAttempt,
} from './claude.ts';
import type { AdapterContext, ClaudeEvent, ClaudeResultEvent } from './types.ts';

// The seam here exists so the recovery *sequence* — at most one retry, the
// second attempt without --resume, the doomed result withheld from the UI — can
// be checked without a `claude` binary (cf. sweepRecallOrphans' `deleter`).

const STALE = 'f80f8a4a-6169-49c3-92c9-8167c4fa159c';

/**
 * Verbatim from a real failure log. Kept exact on purpose: it is simultaneously
 * the regression case and a lock on the shape of `ClaudeResultEvent` — note the
 * absent `result` and `usage`, which the old type declared as required.
 */
const PRUNED_SESSION_RESULT: ClaudeResultEvent = {
  type: 'result',
  subtype: 'error_during_execution',
  duration_ms: 0,
  duration_api_ms: 0,
  is_error: true,
  num_turns: 0,
  session_id: STALE,
  total_cost_usd: 0,
  errors: [`No conversation found with session ID: ${STALE}`],
  result_index: 0,
};

const OK_RESULT: ClaudeResultEvent = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'all done',
  session_id: 'fresh-session',
  duration_ms: 1200,
  num_turns: 2,
  total_cost_usd: 0.04,
};

function ctx(over: Partial<AdapterContext> = {}) {
  const events: ClaudeEvent[] = [];
  const invalidated: Array<{ staleSessionId: string; result: ClaudeResultEvent }> = [];
  const context: AdapterContext = {
    agent: {
      id: 'agent-1',
      workspaceDir: '/tmp/helm-test-workspace',
      claudeSessionId: STALE,
    },
    prompt: 'can you make an agent for me? just asking',
    signal: new AbortController().signal,
    onEvent: (evt) => events.push(evt),
    onLog: () => {},
    onSessionId: () => {},
    onSessionInvalid: (info) => invalidated.push(info),
    ...over,
  };
  return { context, events, invalidated };
}

/** Records every attempt and answers from a script, one entry per call. */
function attempts(script: Array<{ code: number | null; sessionInvalid?: ClaudeResultEvent }>) {
  const calls: Array<{ resume: string | null }> = [];
  const fn: ClaudeAttempt = (_ctx, { resume }) => {
    calls.push({ resume });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    return Promise.resolve({ code: next.code, sessionInvalid: next.sessionInvalid ?? null });
  };
  return { calls, fn };
}

describe('isSessionNotFoundResult', () => {
  it('matches the CLI payload for a pruned session', () => {
    expect(isSessionNotFoundResult(PRUNED_SESSION_RESULT)).toBe(true);
  });

  it('is case-insensitive about the message', () => {
    expect(
      isSessionNotFoundResult({
        ...PRUNED_SESSION_RESULT,
        errors: ['no CONVERSATION found with SESSION id: x'],
      }),
    ).toBe(true);
  });

  it('ignores an unrelated zero-turn failure', () => {
    // The whole point of matching the message rather than the shape: clearing a
    // live session id here would throw away a real conversation.
    expect(
      isSessionNotFoundResult({ ...PRUNED_SESSION_RESULT, errors: ['MCP server crashed'] }),
    ).toBe(false);
  });

  it('ignores a failure with no errors array, and any success', () => {
    expect(
      isSessionNotFoundResult({
        ...PRUNED_SESSION_RESULT,
        errors: undefined,
        result: 'the tool failed',
      }),
    ).toBe(false);
    expect(isSessionNotFoundResult(OK_RESULT)).toBe(false);
  });

  it('ignores non-result events', () => {
    expect(
      isSessionNotFoundResult({
        type: 'system',
        subtype: 'init',
        cwd: '/tmp',
        session_id: STALE,
        model: 'sonnet',
        tools: [],
        permissionMode: 'default',
      }),
    ).toBe(false);
  });
});

describe('eventDisposition', () => {
  const event = PRUNED_SESSION_RESULT;

  it('withholds the failure when a resumed attempt produced nothing else', () => {
    expect(eventDisposition({ resumed: true, forwardedAny: false, event })).toBe('session-invalid');
  });

  it('forwards it when the attempt never passed --resume', () => {
    expect(eventDisposition({ resumed: false, forwardedAny: false, event })).toBe('forward');
  });

  it('forwards it once anything has already streamed', () => {
    // The no-double-side-effects interlock: if the model produced output it may
    // have run tools, so the prompt must not be replayed.
    expect(eventDisposition({ resumed: true, forwardedAny: true, event })).toBe('forward');
  });

  it('forwards ordinary results', () => {
    expect(eventDisposition({ resumed: true, forwardedAny: false, event: OK_RESULT })).toBe(
      'forward',
    );
  });
});

describe('buildClaudeArgs', () => {
  const agent = { id: 'a', workspaceDir: '/w', claudeSessionId: STALE };

  it('resumes only what it is told to, ignoring the agent row', () => {
    expect(buildClaudeArgs(agent, STALE)).toContain('--resume');
    // Structural guarantee that the recovery attempt starts clean even though
    // the agent still carries the dead id.
    expect(buildClaudeArgs(agent, null)).not.toContain('--resume');
  });

  it('falls back to the default tools and model', () => {
    const args = buildClaudeArgs(agent, null);
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--allowedTools') + 1]).toContain('Read');
    expect(buildClaudeArgs({ ...agent, allowedTools: [], model: 'opus' }, null)).toContain('opus');
  });
});

describe('appendTail', () => {
  it('keeps the end of the stream within the limit', () => {
    expect(appendTail('', 'abc', 8)).toBe('abc');
    expect(appendTail('abcdef', 'ghij', 8)).toBe('cdefghij');
    expect(appendTail('', 'x'.repeat(20), 8)).toBe('x'.repeat(8));
  });
});

describe('runClaude stderr tail', () => {
  it('hands back the attempt that actually ran', async () => {
    // A CLI that dies parsing its flags emits no stream-json at all; this tail
    // is then the only explanation the run ledger will ever have (run.ts).
    const { context } = ctx({ agent: { id: 'a', workspaceDir: '/w', claudeSessionId: null } });
    const fn: ClaudeAttempt = () =>
      Promise.resolve({ code: 1, sessionInvalid: null, stderrTail: 'error: unknown option' });
    expect(await runClaude(context, { attempt: fn })).toEqual({
      code: 1,
      stderrTail: 'error: unknown option',
    });
  });

  it('reports the retry’s tail after a session recovery, not the doomed attempt’s', async () => {
    const { context } = ctx();
    const tails = ['first', 'second'];
    const fn: ClaudeAttempt = (_c, { resume }) =>
      Promise.resolve({
        code: resume ? 1 : 0,
        sessionInvalid: resume ? PRUNED_SESSION_RESULT : null,
        stderrTail: tails.shift(),
      });
    expect(await runClaude(context, { attempt: fn })).toEqual({ code: 0, stderrTail: 'second' });
  });
});

describe('resultText', () => {
  it('prefers the result text', () => {
    expect(resultText(OK_RESULT)).toBe('all done');
  });

  it('falls back to errors[] so the ledger explains a failure', () => {
    expect(resultText(PRUNED_SESSION_RESULT)).toBe(
      `No conversation found with session ID: ${STALE}`,
    );
  });

  it('never leaves a failure blank', () => {
    expect(resultText({ ...PRUNED_SESSION_RESULT, errors: [] })).toBe(
      'claude exited with error_during_execution',
    );
  });
});

describe('createAttemptSink', () => {
  const init: ClaudeEvent = {
    type: 'system',
    subtype: 'init',
    cwd: '/tmp',
    session_id: 'fresh-session',
    model: 'sonnet',
    tools: [],
    permissionMode: 'default',
  };

  it('withholds the pruned-session failure from onEvent and hands it back', () => {
    const { context, events } = ctx();
    const sink = createAttemptSink(context, STALE);

    sink.accept(PRUNED_SESSION_RESULT);

    expect(events).toEqual([]);
    expect(sink.sessionInvalid).toBe(PRUNED_SESSION_RESULT);
  });

  it('forwards a normal stream and withholds nothing', () => {
    const { context, events } = ctx();
    const sessions: string[] = [];
    context.onSessionId = (sid) => sessions.push(sid);
    const sink = createAttemptSink(context, null);

    sink.accept(init);
    sink.accept(OK_RESULT);

    expect(events).toEqual([init, OK_RESULT]);
    expect(sessions).toEqual(['fresh-session']);
    expect(sink.sessionInvalid).toBeNull();
  });

  it('forwards the failure once anything already streamed', () => {
    const { context, events } = ctx();
    const sink = createAttemptSink(context, STALE);

    sink.accept(init);
    sink.accept(PRUNED_SESSION_RESULT);

    expect(events).toEqual([init, PRUNED_SESSION_RESULT]);
    expect(sink.sessionInvalid).toBeNull();
  });
});

describe('runClaude session recovery', () => {
  it('retries once without --resume and reports the second attempt', async () => {
    const { context, invalidated } = ctx();
    const a = attempts([{ code: 1, sessionInvalid: PRUNED_SESSION_RESULT }, { code: 0 }]);

    await expect(runClaude(context, { attempt: a.fn })).resolves.toEqual({ code: 0 });

    expect(a.calls).toEqual([{ resume: STALE }, { resume: null }]);
    expect(invalidated).toEqual([{ staleSessionId: STALE, result: PRUNED_SESSION_RESULT }]);
  });

  it('never forwards the doomed attempt, only the notice', async () => {
    const { context, events } = ctx();
    const a = attempts([{ code: 1, sessionInvalid: PRUNED_SESSION_RESULT }, { code: 0 }]);

    await runClaude(context, { attempt: a.fn });

    // A forwarded $0.0000 failure result is exactly what marked the chat bubble
    // complete while it still said "thinking…".
    expect(events.some((e) => e.type === 'result')).toBe(false);
    expect(events).toEqual([sessionResetNotice(STALE)]);
  });

  it('does not retry when no session was resumed', async () => {
    const { context, invalidated } = ctx({
      agent: { id: 'a', workspaceDir: '/w', claudeSessionId: null },
    });
    const a = attempts([{ code: 1, sessionInvalid: PRUNED_SESSION_RESULT }]);

    await expect(runClaude(context, { attempt: a.fn })).resolves.toEqual({ code: 1 });
    expect(a.calls).toHaveLength(1);
    expect(invalidated).toHaveLength(0);
  });

  it('does not retry an ordinary failure', async () => {
    const { context, invalidated } = ctx();
    const a = attempts([{ code: 1 }]);

    await expect(runClaude(context, { attempt: a.fn })).resolves.toEqual({ code: 1 });
    expect(a.calls).toHaveLength(1);
    expect(invalidated).toHaveLength(0);
  });

  it('recovers at most once even if the retry reports the same failure', async () => {
    const { context } = ctx();
    const a = attempts([{ code: 1, sessionInvalid: PRUNED_SESSION_RESULT }]); // always

    await runClaude(context, { attempt: a.fn });

    expect(a.calls).toHaveLength(2);
  });

  it('skips the retry when the turn was aborted, and still surfaces the failure', async () => {
    const controller = new AbortController();
    const { context, events, invalidated } = ctx({ signal: controller.signal });
    const calls: Array<{ resume: string | null }> = [];
    const attempt: ClaudeAttempt = (_c, { resume }) => {
      calls.push({ resume });
      controller.abort();
      return Promise.resolve({ code: 1, sessionInvalid: PRUNED_SESSION_RESULT });
    };

    await expect(runClaude(context, { attempt })).resolves.toEqual({ code: 1 });

    expect(calls).toHaveLength(1);
    expect(invalidated).toHaveLength(0);
    // Withheld for a retry that never happened — hand it over rather than lose it.
    expect(events).toEqual([PRUNED_SESSION_RESULT]);
  });

  it('propagates a spawn failure without retrying', async () => {
    const { context } = ctx();
    let calls = 0;
    const attempt: ClaudeAttempt = () => {
      calls++;
      return Promise.reject(new Error('spawn claude ENOENT'));
    };

    await expect(runClaude(context, { attempt })).rejects.toThrow('ENOENT');
    expect(calls).toBe(1);
  });
});
