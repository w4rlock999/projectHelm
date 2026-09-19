import { readFileSync, statSync } from 'node:fs';
import type { ChatMessage } from '../components/chat/MessageBubble.tsx';
import { replayRun, type LoggedLine } from '../lib/chat-replay.ts';
import { paths, SHARED_SESSION_KEY } from './paths.ts';
import { listSessionRuns } from './runs.ts';
import type { Run } from '../db/schema.ts';

// The console's memory. Before this, a browser refresh emptied the chat even
// though Claude's session carried on — the transcript was on disk the whole
// time, in the ndjson logs `run.ts` writes and nothing read back. This module
// reads them back: the ledger says which runs make up the shared session, the
// log says what each one showed, and the reducer in src/lib/chat-replay.ts
// turns that into the same bubbles the live stream produced.

export interface HistoryTurn {
  runId: string;
  source: string;
  status: string;
  /** Epoch ms — tRPC has no transformer, so Dates would arrive as strings. */
  startedAt: number;
  endedAt: number | null;
  /** The Claude session this turn ran in, or null when the log never said. */
  sessionId: string | null;
  messages: ChatMessage[];
}

/**
 * Above this the log is not replayed, only summarised from the ledger. A long
 * multi-tool turn is ~600 KB; anything near this size is an agent that ran
 * away, and reading it on every console load would punish the wrong party.
 */
export const MAX_LOG_BYTES = 25 * 1024 * 1024;

/**
 * The run's log as parsed lines, or null when it cannot be replayed: missing
 * (the run predates logging, or someone tidied the directory) or oversized.
 * Lines that fail to parse are skipped — a torn last line from a process that
 * died mid-write must not take the whole turn with it.
 */
export function readRunLog(agentId: string, runId: string): LoggedLine[] | null {
  const file = paths.agentLogFile(agentId, runId);
  let raw: string;
  try {
    if (statSync(file).size > MAX_LOG_BYTES) return null;
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines: LoggedLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as LoggedLine);
    } catch {
      /* torn or foreign line */
    }
  }
  return lines;
}

// A finished run's log is immutable, so its replay is too. Bounded so a fleet
// of chatty agents cannot grow it without limit; insertion order doubles as
// LRU-enough eviction. In-flight runs are never cached — their bubble is
// still changing, and caching it would freeze "thinking…" forever.
const TERMINAL = new Set(['ok', 'error', 'interrupted']);
const MEMO_LIMIT = 500;
const memo = new Map<string, HistoryTurn>();

function turnFor(run: Run): HistoryTurn {
  const cached = memo.get(run.id);
  if (cached) return cached;
  const { messages, sessionId } = replayRun(run, readRunLog(run.agentId, run.id));
  const turn: HistoryTurn = {
    runId: run.id,
    source: run.source,
    status: run.status,
    startedAt: run.startedAt.getTime(),
    endedAt: run.endedAt?.getTime() ?? null,
    sessionId,
    messages,
  };
  if (TERMINAL.has(run.status)) {
    if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value!);
    memo.set(run.id, turn);
  }
  return turn;
}

/**
 * The agent's console conversation, oldest first: every turn that ran in the
 * shared session — typed here, fired by a 'main' heartbeat, or relayed from
 * Telegram under sessionScope='agent'. Per-chat sessions are a different
 * conversation and are not included.
 */
export function listHistory(
  agentId: string,
  opts: { limit?: number; before?: number } = {},
): { turns: HistoryTurn[]; hasMore: boolean } {
  const { runs, hasMore } = listSessionRuns(agentId, SHARED_SESSION_KEY, opts);
  return { turns: runs.map(turnFor), hasMore };
}
