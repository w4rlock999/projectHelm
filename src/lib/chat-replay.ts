import type { ClaudeEvent, ClaudeResultEvent } from '#/server/adapter/types';
import type { AssistantSegment, ChatMessage } from '#/components/chat/MessageBubble';

// One reducer for both ways a turn reaches the console.
//
// Live, the SSE route forwards every `ClaudeEvent` as it happens; after a
// refresh, `src/server/history.ts` reads the very same events back from the
// run's ndjson log. Both feed this module, so a replayed bubble is identical to
// the one that was streamed — by construction, not by keeping two renderers in
// step. Node-free on purpose: it runs in the browser and on the server.

/** The first line `run.ts` writes to every run log. */
export interface HelmMetaLine {
  type: 'helm_meta';
  source: string;
  prompt: string;
  runId: string;
  argv?: string[];
}

/** Forensic line written when a `--resume` hit a pruned session. */
export interface HelmSessionResetLine {
  type: 'helm_session_reset';
  staleSessionId: string;
  suppressed: ClaudeResultEvent;
}

/** Anything that can appear on one line of a run log, or on the live stream. */
export type LoggedLine = ClaudeEvent | HelmMetaLine | HelmSessionResetLine;

export type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;

/** The subset of a ledger row the reducer needs to finish a turn. */
export interface LedgerOutcome {
  status: string;
  exitCode: number | null;
  resultText: string | null;
}

export interface TurnBuilder {
  segments: AssistantSegment[];
  notices: string[];
  /** From `system/init`; the last one wins so a reset-and-retry ends fresh. */
  sessionId: string | null;
  result: ClaudeResultEvent | null;
  /**
   * Content-block index → slot in `segments`, for the message currently
   * streaming. Claude restarts block indices at 0 for every message inside a
   * turn (each tool call ends one message and starts another), so keying
   * segments by the raw index made every message overwrite the last. The map
   * is reset on `message_start` and each new block takes the next free slot.
   */
  slotByIndex: Map<number, number>;
  /** Whether any partial-message block was seen; gates the fallback below. */
  sawBlocks: boolean;
  /** Whole blocks from `assistant` events — used only when no partials exist. */
  assistantBlocks: unknown[];
}

export function createTurnBuilder(): TurnBuilder {
  return {
    segments: [],
    notices: [],
    sessionId: null,
    result: null,
    slotByIndex: new Map(),
    sawBlocks: false,
    assistantBlocks: [],
  };
}

/** Stable ids shared by the live turn and its replay, so React keeps the DOM. */
export function messageIds(runId: string): { user: string; assistant: string } {
  return { user: `${runId}:user`, assistant: `${runId}:assistant` };
}

/**
 * Fold one event into the builder. Returns true when something visible
 * changed, so a live caller can skip a state update for the many events that
 * carry nothing the bubble shows (status pings, rate-limit notes, usage).
 */
export function applyEvent(b: TurnBuilder, evt: LoggedLine): boolean {
  // Subagent traffic (the Agent tool) streams through the same channel tagged
  // with the parent tool call. The parent's own tool_use badge covers it.
  if ((evt as { parent_tool_use_id?: string | null }).parent_tool_use_id) return false;

  switch (evt.type) {
    case 'stream_event': {
      const ev = evt.event;
      if (ev.type === 'message_start') {
        b.slotByIndex.clear();
        return false;
      }
      if (ev.type === 'content_block_start') {
        const block = ev.content_block;
        let next: AssistantSegment | undefined;
        if (block.type === 'text') {
          next = { type: 'text', text: '' };
        } else if (block.type === 'tool_use') {
          next = {
            type: 'tool_use',
            name: block.name,
            id: block.id,
            status: 'running',
            inputJson: '',
          };
        }
        // Thinking blocks (and anything new) take no slot; their deltas then
        // miss the map below and fall through harmlessly.
        if (!next) return false;
        b.slotByIndex.set(ev.index, b.segments.length);
        b.segments.push(next);
        b.sawBlocks = true;
        return true;
      }
      if (ev.type === 'content_block_delta') {
        const slot = b.slotByIndex.get(ev.index);
        const cur = slot === undefined ? undefined : b.segments[slot];
        if (!cur) return false;
        if (cur.type === 'text' && ev.delta.type === 'text_delta') {
          b.segments[slot!] = { ...cur, text: cur.text + ev.delta.text };
          return true;
        }
        if (cur.type === 'tool_use' && ev.delta.type === 'input_json_delta') {
          b.segments[slot!] = { ...cur, inputJson: (cur.inputJson ?? '') + ev.delta.partial_json };
          return true;
        }
        return false;
      }
      if (ev.type === 'content_block_stop') {
        const slot = b.slotByIndex.get(ev.index);
        const cur = slot === undefined ? undefined : b.segments[slot];
        if (cur?.type === 'tool_use' && cur.status !== 'done') {
          b.segments[slot!] = { ...cur, status: 'done' };
          return true;
        }
        return false;
      }
      return false;
    }
    case 'system':
      if (evt.subtype === 'init') b.sessionId = evt.session_id;
      return false;
    case 'helm_notice':
      b.notices.push(evt.text);
      if (evt.notice === 'session_reset') {
        // The retry re-runs the whole prompt; whatever the doomed attempt
        // streamed before dying would otherwise sit above the real answer.
        b.segments = [];
        b.slotByIndex.clear();
      }
      return true;
    case 'assistant':
      if (Array.isArray(evt.message?.content)) b.assistantBlocks.push(...evt.message.content);
      return false;
    case 'result':
      b.result = evt;
      b.sessionId ??= evt.session_id;
      return true;
    default:
      // helm_meta, helm_session_reset, user (tool results), rate_limit_event,
      // and whatever the CLI adds next: nothing the bubble renders.
      return false;
  }
}

/**
 * What to show for a failed turn. A failure often has no `result` and states
 * the reason only in `errors` — mirrors `resultText` in the claude adapter,
 * duplicated rather than imported because that module pulls in node builtins.
 */
export function failureText(evt: ClaudeResultEvent): string {
  const detail = evt.result?.trim() || (evt.errors ?? []).filter(Boolean).join('\n');
  return detail || `The turn failed (${evt.subtype}).`;
}

/**
 * Close the turn: the `result` event when there is one, otherwise the ledger's
 * verdict on why there isn't. Live callers pass a synthetic outcome for the
 * SSE `end`/`error`/abort cases; replay passes the run row.
 */
export function finishTurn(
  b: TurnBuilder,
  ledger: LedgerOutcome,
): Pick<AssistantMessage, 'segments' | 'notices' | 'complete' | 'cost' | 'durationMs' | 'error'> {
  const segments = b.sawBlocks ? b.segments : segmentsFromBlocks(b.assistantBlocks);
  const base = { segments, ...(b.notices.length ? { notices: b.notices } : {}) };

  if (b.result) {
    return {
      ...base,
      complete: true,
      cost: b.result.total_cost_usd,
      durationMs: b.result.duration_ms,
      ...(b.result.is_error ? { error: failureText(b.result) } : {}),
    };
  }
  switch (ledger.status) {
    case 'queued':
    case 'running':
      return { ...base, complete: false };
    case 'interrupted':
      return { ...base, complete: true, error: INTERRUPTED_TEXT };
    case 'error':
      return { ...base, complete: true, error: ledger.resultText?.trim() || 'The turn failed.' };
    default:
      return {
        ...base,
        complete: true,
        error:
          typeof ledger.exitCode === 'number' && ledger.exitCode !== 0
            ? `The turn ended without a result (claude exited ${ledger.exitCode}).`
            : 'The turn ended without a result.',
      };
  }
}

export const INTERRUPTED_TEXT = 'The turn was interrupted before it produced a result.';
export const NO_TRANSCRIPT_TEXT = 'Transcript unavailable — showing the ledger summary.';

/**
 * Fallback for a log with no partial-message events at all (a CLI run without
 * `--include-partial-messages`, say): rebuild segments from the whole blocks
 * that `assistant` events carry. Thinking is skipped, tool calls are done.
 */
function segmentsFromBlocks(blocks: unknown[]): AssistantSegment[] {
  const out: AssistantSegment[] = [];
  const seenTools = new Set<string>();
  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as {
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    };
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use' && typeof block.id === 'string') {
      if (seenTools.has(block.id)) continue;
      seenTools.add(block.id);
      out.push({
        type: 'tool_use',
        id: block.id,
        name: block.name ?? 'tool',
        status: 'done',
        inputJson: block.input === undefined ? '' : JSON.stringify(block.input),
      });
    }
  }
  return out;
}

export interface ReplayableRun {
  id: string;
  source: string;
  prompt: string;
  status: string;
  exitCode: number | null;
  resultText: string | null;
}

/**
 * Rebuild one turn's pair of bubbles from its ledger row and log lines.
 * `lines === null` means the log is gone (or too big to read): the ledger's
 * truncated prompt and result stand in, and the bubble says so.
 */
export function replayRun(
  run: ReplayableRun,
  lines: LoggedLine[] | null,
): { messages: ChatMessage[]; sessionId: string | null } {
  const ids = messageIds(run.id);
  const source = run.source === 'chat' ? {} : { source: run.source };

  if (lines === null) {
    const inFlight = run.status === 'queued' || run.status === 'running';
    const failed = run.status === 'error' || run.status === 'interrupted';
    const assistant: AssistantMessage = {
      id: ids.assistant,
      role: 'assistant',
      segments: !failed && run.resultText?.trim() ? [{ type: 'text', text: run.resultText }] : [],
      complete: !inFlight,
      notices: [NO_TRANSCRIPT_TEXT],
      ...(failed
        ? {
            error:
              run.status === 'interrupted'
                ? INTERRUPTED_TEXT
                : run.resultText?.trim() || 'The turn failed.',
          }
        : {}),
    };
    return {
      messages: [{ id: ids.user, role: 'user', text: run.prompt, ...source }, assistant],
      sessionId: null,
    };
  }

  const meta = lines.find((l): l is HelmMetaLine => l.type === 'helm_meta');
  const b = createTurnBuilder();
  for (const line of lines) applyEvent(b, line);
  const assistant: AssistantMessage = {
    id: ids.assistant,
    role: 'assistant',
    ...finishTurn(b, run),
  };
  return {
    messages: [
      { id: ids.user, role: 'user', text: meta?.prompt ?? run.prompt, ...source },
      assistant,
    ],
    sessionId: b.sessionId,
  };
}
