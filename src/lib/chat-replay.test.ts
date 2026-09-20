import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  createTurnBuilder,
  finishTurn,
  INTERRUPTED_TEXT,
  messageIds,
  NO_TRANSCRIPT_TEXT,
  replayRun,
  type LoggedLine,
} from './chat-replay.ts';
import type { AnthropicStreamEvent, ClaudeEvent, ClaudeResultEvent } from '#/server/adapter/types';

// The reducer is the one place where a streamed bubble and a replayed bubble
// are defined, so its fixtures are the shapes the CLI actually emits — see the
// counts and samples in the ndjson logs under .helm/agents/<id>/logs.

const SID = 'session-a';

function stream(event: AnthropicStreamEvent): ClaudeEvent {
  return { type: 'stream_event', event, session_id: SID, uuid: 'u' };
}

const init = (session_id = SID): ClaudeEvent =>
  ({
    type: 'system',
    subtype: 'init',
    cwd: '/w',
    session_id,
    model: 'sonnet',
    tools: [],
    permissionMode: 'default',
  }) as ClaudeEvent;

const messageStart = () =>
  stream({
    type: 'message_start',
    message: { id: 'm', model: 'sonnet', role: 'assistant', usage: {} },
  });
const textStart = (index: number) =>
  stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
const textDelta = (index: number, text: string) =>
  stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const thinkingStart = (index: number) =>
  stream({
    type: 'content_block_start',
    index,
    content_block: { type: 'thinking', thinking: '' } as unknown as { type: 'text'; text: string },
  });
const thinkingDelta = (index: number) =>
  stream({
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking: 'hmm' } as unknown as {
      type: 'text_delta';
      text: string;
    },
  });
const toolStart = (index: number, id: string, name = 'Bash') =>
  stream({
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  });
const toolDelta = (index: number, partial_json: string) =>
  stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
const blockStop = (index: number) => stream({ type: 'content_block_stop', index });

const result = (over: Partial<ClaudeResultEvent> = {}): ClaudeResultEvent => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  session_id: SID,
  duration_ms: 1200,
  num_turns: 1,
  total_cost_usd: 0.0123,
  ...over,
});

const OK = { status: 'ok', exitCode: 0, resultText: null };
const RUN = {
  id: 'run-1',
  source: 'chat',
  prompt: 'ledger prompt',
  status: 'ok',
  exitCode: 0,
  resultText: 'r',
};

function build(events: LoggedLine[]) {
  const b = createTurnBuilder();
  for (const e of events) applyEvent(b, e);
  return b;
}

/** A realistic multi-step turn: think, say, call a tool; then think, call; then say. */
const MULTI_STEP: LoggedLine[] = [
  init(),
  messageStart(),
  thinkingStart(0),
  thinkingDelta(0),
  blockStop(0),
  textStart(1),
  textDelta(1, 'Let me '),
  textDelta(1, 'look.'),
  blockStop(1),
  toolStart(2, 'toolu_1'),
  toolDelta(2, '{"command":'),
  toolDelta(2, '"ls"}'),
  blockStop(2),
  // Tool result comes back as a `user` event, then a new message with indices from 0.
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] }, session_id: SID },
  messageStart(),
  thinkingStart(0),
  blockStop(0),
  toolStart(1, 'toolu_2', 'Read'),
  toolDelta(1, '{"file":"x"}'),
  blockStop(1),
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] }, session_id: SID },
  messageStart(),
  textStart(0),
  textDelta(0, 'All good.'),
  blockStop(0),
  result(),
];

describe('applyEvent', () => {
  it('keeps every block of a multi-message turn, in order, skipping thinking', () => {
    const b = build(MULTI_STEP);
    expect(b.segments).toEqual([
      { type: 'text', text: 'Let me look.' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        status: 'done',
        inputJson: '{"command":"ls"}',
      },
      { type: 'tool_use', id: 'toolu_2', name: 'Read', status: 'done', inputJson: '{"file":"x"}' },
      { type: 'text', text: 'All good.' },
    ]);
    expect(b.sawBlocks).toBe(true);
  });

  it('routes deltas by slot after the index reset, not by raw index', () => {
    // Message 1 puts text at index 1; message 2 puts text at index 0. A raw-index
    // reducer would append "All good." to the wrong block or overwrite slot 0.
    const b = build([
      messageStart(),
      textStart(1),
      textDelta(1, 'first'),
      messageStart(),
      textStart(0),
      textDelta(0, 'second'),
    ]);
    expect(b.segments.map((s) => s.type === 'text' && s.text)).toEqual(['first', 'second']);
  });

  it('ignores deltas for blocks without a slot (thinking) and unknown indices', () => {
    const b = build([messageStart(), thinkingStart(0), thinkingDelta(0), textDelta(7, 'nope')]);
    expect(b.segments).toEqual([]);
  });

  it('ignores subagent traffic tagged with parent_tool_use_id', () => {
    const child = { ...textStart(0), parent_tool_use_id: 'toolu_parent' } as ClaudeEvent;
    const b = build([messageStart(), toolStart(0, 'toolu_parent', 'Agent'), child]);
    expect(b.segments).toHaveLength(1);
    expect(b.segments[0]!.type).toBe('tool_use');
  });

  it('reports whether anything visible changed', () => {
    const b = createTurnBuilder();
    expect(applyEvent(b, init())).toBe(false);
    expect(applyEvent(b, messageStart())).toBe(false);
    expect(applyEvent(b, textStart(0))).toBe(true);
    expect(applyEvent(b, textDelta(0, 'x'))).toBe(true);
    expect(
      applyEvent(b, { type: 'rate_limit_event', rate_limit_info: {}, session_id: SID, uuid: 'u' }),
    ).toBe(false);
    expect(applyEvent(b, result())).toBe(true);
  });

  it('records the session id from init, and the last init wins after a reset', () => {
    const b = build([
      init('stale'),
      messageStart(),
      textStart(0),
      textDelta(0, 'doomed partial'),
      {
        type: 'helm_session_reset',
        staleSessionId: 'stale',
        suppressed: result({ is_error: true }),
      },
      { type: 'helm_notice', notice: 'session_reset', text: 'Session expired; starting over.' },
      init('fresh'),
      messageStart(),
      textStart(0),
      textDelta(0, 'real answer'),
      result({ session_id: 'fresh' }),
    ]);
    expect(b.sessionId).toBe('fresh');
    expect(b.notices).toEqual(['Session expired; starting over.']);
    // The doomed attempt's blocks are gone; only the retry's remain.
    expect(b.segments).toEqual([{ type: 'text', text: 'real answer' }]);
  });

  it('falls back to the session id on result when no init was seen', () => {
    const b = build([result({ session_id: 'from-result' })]);
    expect(b.sessionId).toBe('from-result');
  });
});

describe('finishTurn', () => {
  it('uses the result event when there is one', () => {
    const b = build(MULTI_STEP);
    expect(finishTurn(b, { status: 'running', exitCode: null, resultText: null })).toMatchObject({
      complete: true,
      cost: 0.0123,
      durationMs: 1200,
    });
    expect(finishTurn(b, OK).error).toBeUndefined();
  });

  it('explains a failed result from errors[] when result text is absent', () => {
    // The pruned-session shape: error_during_execution, no `result`, reason in `errors`.
    const b = build([
      result({
        subtype: 'error_during_execution',
        is_error: true,
        result: undefined,
        errors: ['No conversation found with session ID: dead'],
        num_turns: 0,
        total_cost_usd: 0,
      }),
    ]);
    const out = finishTurn(b, OK);
    expect(out.complete).toBe(true);
    expect(out.error).toBe('No conversation found with session ID: dead');
  });

  it('without a result, the ledger status decides', () => {
    const b = build([messageStart(), textStart(0), textDelta(0, 'partial')]);
    expect(
      finishTurn(b, { status: 'interrupted', exitCode: null, resultText: null }),
    ).toMatchObject({
      complete: true,
      error: INTERRUPTED_TEXT,
      segments: [{ type: 'text', text: 'partial' }],
    });
    expect(finishTurn(b, { status: 'error', exitCode: 1, resultText: 'spawn failed' }).error).toBe(
      'spawn failed',
    );
    expect(finishTurn(b, { status: 'ok', exitCode: 2, resultText: null }).error).toBe(
      'The turn ended without a result (claude exited 2).',
    );
    expect(finishTurn(b, { status: 'running', exitCode: null, resultText: null })).toMatchObject({
      complete: false,
    });
  });

  it('rebuilds segments from assistant blocks when there were no partial events', () => {
    const b = build([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'sonnet',
          usage: {},
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: 'Hi.' },
          ],
        },
        session_id: SID,
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'sonnet',
          usage: {},
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
        },
        session_id: SID,
      },
      result(),
    ]);
    expect(finishTurn(b, OK).segments).toEqual([
      { type: 'text', text: 'Hi.' },
      { type: 'tool_use', id: 't1', name: 'Bash', status: 'done', inputJson: '{"command":"ls"}' },
    ]);
  });
});

describe('replayRun', () => {
  it('pairs the full prompt from helm_meta with the reduced assistant bubble', () => {
    const lines: LoggedLine[] = [
      {
        type: 'helm_meta',
        source: 'chat',
        prompt: 'the whole prompt, untruncated',
        runId: 'run-1',
      },
      ...MULTI_STEP,
    ];
    const { messages, sessionId } = replayRun(RUN, lines);
    expect(sessionId).toBe(SID);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      id: 'run-1:user',
      role: 'user',
      text: 'the whole prompt, untruncated',
    });
    expect(messages[1]).toMatchObject({
      id: 'run-1:assistant',
      role: 'assistant',
      complete: true,
      cost: 0.0123,
    });
    expect(messageIds('run-1')).toEqual({ user: 'run-1:user', assistant: 'run-1:assistant' });
  });

  it('badges prompts that did not come from the console', () => {
    const { messages } = replayRun({ ...RUN, source: 'heartbeat:hb-1' }, [init(), result()]);
    expect(messages[0]).toMatchObject({
      role: 'user',
      source: 'heartbeat:hb-1',
      text: 'ledger prompt',
    });
    expect(replayRun(RUN, [result()]).messages[0]).not.toHaveProperty('source');
  });

  it('falls back to the ledger when the log is gone', () => {
    const ok = replayRun({ ...RUN, resultText: 'summary text' }, null);
    expect(ok.sessionId).toBeNull();
    expect(ok.messages[0]).toMatchObject({ text: 'ledger prompt' });
    expect(ok.messages[1]).toMatchObject({
      complete: true,
      notices: [NO_TRANSCRIPT_TEXT],
      segments: [{ type: 'text', text: 'summary text' }],
    });

    const failed = replayRun({ ...RUN, status: 'error', resultText: 'boom' }, null);
    expect(failed.messages[1]).toMatchObject({ complete: true, error: 'boom', segments: [] });

    const cut = replayRun({ ...RUN, status: 'interrupted', resultText: null }, null);
    expect(cut.messages[1]).toMatchObject({ error: INTERRUPTED_TEXT });

    const running = replayRun({ ...RUN, status: 'running', resultText: null }, null);
    expect(running.messages[1]).toMatchObject({ complete: false });
  });
});
