import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// Pure and path-free, so a static import is safe before the chdir.
import { NO_TRANSCRIPT_TEXT } from '../lib/chat-replay.ts';

// The console's history against a real SQLite ledger and real log files. The
// ledger half is where the session filter lives — a wrong filter would show a
// per-chat Telegram conversation in the console, or hide a heartbeat turn that
// Claude does remember. Same throwaway-root technique as session-store.test.ts:
// paths.ts derives helmRoot from cwd at module load, so every helm module is
// imported dynamically, after the chdir.

let root: string;
let originalCwd: string;
let m: {
  db: typeof import('../db/index.ts');
  schema: typeof import('../db/schema.ts');
  runs: typeof import('./runs.ts');
  history: typeof import('./history.ts');
  paths: typeof import('./paths.ts');
};

const AGENT_ID = 'a9e77000-0000-4000-8000-000000000201';
const CHAT_KEY = 'cffa7000-0000-4000-8000-000000000202';

beforeAll(async () => {
  originalCwd = process.cwd();
  root = mkdtempSync(path.join(tmpdir(), 'helm-history-'));
  mkdirSync(path.join(root, '.helm'), { recursive: true });
  process.chdir(root);

  const Database = (await import('better-sqlite3')).default;
  const sqlite = new Database(path.join(root, '.helm', 'db.sqlite'));
  for (const file of readdirSync(path.join(originalCwd, 'drizzle'))
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(path.join(originalCwd, 'drizzle', file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) sqlite.exec(stmt);
  }
  sqlite.close();

  m = {
    db: await import('../db/index.ts'),
    schema: await import('../db/schema.ts'),
    runs: await import('./runs.ts'),
    history: await import('./history.ts'),
    paths: await import('./paths.ts'),
  };
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  const { db } = m.db;
  const { agents, runs } = m.schema;
  db.delete(runs).run();
  db.delete(agents).run();
  db.insert(agents).values({ id: AGENT_ID, name: 'tester', systemPrompt: 'be brief' }).run();
  rmSync(m.paths.paths.agentLogsDir(AGENT_ID), { recursive: true, force: true });
});

let seq = 0;
function insertRun(over: {
  id?: string;
  sessionKey?: string | null;
  status?: string;
  source?: string;
  startedAt: number;
  prompt?: string;
  resultText?: string | null;
}) {
  const id = over.id ?? `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  m.db.db
    .insert(m.schema.runs)
    .values({
      id,
      agentId: AGENT_ID,
      source: over.source ?? 'chat',
      sessionKey: over.sessionKey === undefined ? 'shared' : over.sessionKey,
      status: over.status ?? 'ok',
      prompt: over.prompt ?? `prompt ${id}`,
      resultText: over.resultText ?? null,
      startedAt: new Date(over.startedAt),
      endedAt: new Date(over.startedAt + 1000),
    })
    .run();
  return id;
}

function writeLog(runId: string, lines: unknown[]) {
  mkdirSync(m.paths.paths.agentLogsDir(AGENT_ID), { recursive: true });
  writeFileSync(
    m.paths.paths.agentLogFile(AGENT_ID, runId),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const sec = (n: number) => T0 + n * 1000;

describe('listSessionRuns', () => {
  it('returns the shared session oldest-first, including pre-migration rows, excluding refusals and other sessions', () => {
    insertRun({ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: sec(3) });
    insertRun({ id: 'aaaaaaaa-0000-4000-8000-000000000002', startedAt: sec(1), sessionKey: null });
    insertRun({
      id: 'aaaaaaaa-0000-4000-8000-000000000003',
      startedAt: sec(2),
      source: 'heartbeat:hb',
    });
    insertRun({ startedAt: sec(4), sessionKey: CHAT_KEY, source: 'telegram:5001' });
    insertRun({ startedAt: sec(5), status: 'refused' });

    const { runs, hasMore } = m.runs.listSessionRuns(AGENT_ID, 'shared');
    expect(hasMore).toBe(false);
    expect(runs.map((r) => r.id)).toEqual([
      'aaaaaaaa-0000-4000-8000-000000000002',
      'aaaaaaaa-0000-4000-8000-000000000003',
      'aaaaaaaa-0000-4000-8000-000000000001',
    ]);
  });

  it('pages backwards from `before` and reports whether older turns exist', () => {
    for (let i = 0; i < 5; i++) insertRun({ startedAt: sec(i) });

    const latest = m.runs.listSessionRuns(AGENT_ID, 'shared', { limit: 2 });
    expect(latest.hasMore).toBe(true);
    expect(latest.runs.map((r) => r.startedAt.getTime())).toEqual([sec(3), sec(4)]);

    const older = m.runs.listSessionRuns(AGENT_ID, 'shared', {
      limit: 2,
      before: latest.runs[0]!.startedAt.getTime(),
    });
    expect(older.hasMore).toBe(true);
    expect(older.runs.map((r) => r.startedAt.getTime())).toEqual([sec(1), sec(2)]);

    const oldest = m.runs.listSessionRuns(AGENT_ID, 'shared', {
      limit: 2,
      before: older.runs[0]!.startedAt.getTime(),
    });
    expect(oldest.hasMore).toBe(false);
    expect(oldest.runs.map((r) => r.startedAt.getTime())).toEqual([sec(0)]);
  });
});

describe('reserveRun', () => {
  it('records the session key, defaulting to the shared session', () => {
    const shared = m.runs.reserveRun(AGENT_ID, { source: 'chat', prompt: 'hi' });
    const chat = m.runs.reserveRun(AGENT_ID, {
      source: 'telegram:5001',
      prompt: 'hi',
      sessionKey: CHAT_KEY,
    });
    expect(m.runs.getRun(shared.runId)?.sessionKey).toBe('shared');
    expect(m.runs.getRun(chat.runId)?.sessionKey).toBe(CHAT_KEY);
  });

  it('marks an aborted turn interrupted rather than ok', () => {
    const { runId } = m.runs.reserveRun(AGENT_ID, { source: 'chat', prompt: 'hi' });
    m.runs.markRunStarted(runId);
    m.runs.markRunInterrupted(runId, { code: null });
    const row = m.db.db.select().from(m.schema.runs).where(eq(m.schema.runs.id, runId)).get();
    expect(row?.status).toBe('interrupted');
    expect(row?.endedAt).not.toBeNull();
  });
});

describe('listHistory', () => {
  const init = (session_id: string) => ({
    type: 'system',
    subtype: 'init',
    cwd: '/w',
    session_id,
    model: 'sonnet',
    tools: [],
    permissionMode: 'default',
  });
  const text = (t: string) => [
    {
      type: 'stream_event',
      event: { type: 'message_start', message: {} },
      session_id: 's',
      uuid: 'u',
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      session_id: 's',
      uuid: 'u',
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
      session_id: 's',
      uuid: 'u',
    },
  ];
  const result = (session_id: string) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    session_id,
    duration_ms: 10,
    num_turns: 1,
    total_cost_usd: 0.01,
  });

  it('replays each turn from its log, with the full prompt and its session id', () => {
    const a = insertRun({ startedAt: sec(1), prompt: 'truncated…' });
    writeLog(a, [
      { type: 'helm_meta', source: 'chat', prompt: 'the full prompt', runId: a },
      init('session-1'),
      ...text('Hello.'),
      result('session-1'),
    ]);
    const b = insertRun({ startedAt: sec(2), source: 'heartbeat:hb-1' });
    writeLog(b, [
      { type: 'helm_meta', source: 'heartbeat:hb-1', prompt: 'tick', runId: b },
      init('session-2'),
      ...text('Tock.'),
      result('session-2'),
    ]);

    const { turns, hasMore } = m.history.listHistory(AGENT_ID);
    expect(hasMore).toBe(false);
    expect(turns.map((t) => t.runId)).toEqual([a, b]);
    expect(turns[0]).toMatchObject({
      source: 'chat',
      status: 'ok',
      startedAt: sec(1),
      endedAt: sec(1) + 1000,
      sessionId: 'session-1',
    });
    expect(turns[0]!.messages[0]).toEqual({
      id: `${a}:user`,
      role: 'user',
      text: 'the full prompt',
    });
    expect(turns[0]!.messages[1]).toMatchObject({
      id: `${a}:assistant`,
      complete: true,
      cost: 0.01,
      segments: [{ type: 'text', text: 'Hello.' }],
    });
    // Heartbeat turn: badged prompt, different session id (a divider's cue).
    expect(turns[1]!.messages[0]).toMatchObject({ source: 'heartbeat:hb-1', text: 'tick' });
    expect(turns[1]!.sessionId).toBe('session-2');
  });

  it('falls back to the ledger when a log is missing, and survives a torn line', () => {
    insertRun({ startedAt: sec(1), prompt: 'no log', resultText: 'summary' });
    const torn = insertRun({ startedAt: sec(2) });
    mkdirSync(m.paths.paths.agentLogsDir(AGENT_ID), { recursive: true });
    writeFileSync(
      m.paths.paths.agentLogFile(AGENT_ID, torn),
      [
        JSON.stringify(init('s-torn')),
        ...text('partial').map((l) => JSON.stringify(l)),
        '{"type":"res',
      ].join('\n'),
    );

    const { turns } = m.history.listHistory(AGENT_ID);
    expect(turns[0]!.sessionId).toBeNull();
    expect(turns[0]!.messages[0]).toMatchObject({ text: 'no log' });
    expect(turns[0]!.messages[1]).toMatchObject({
      complete: true,
      segments: [{ type: 'text', text: 'summary' }],
      notices: [NO_TRANSCRIPT_TEXT],
    });
    // The torn tail is skipped; what parsed is shown; status `ok` with no
    // result reads as "ended without a result".
    expect(turns[1]!.sessionId).toBe('s-torn');
    expect(turns[1]!.messages[1]).toMatchObject({
      complete: true,
      segments: [{ type: 'text', text: 'partial' }],
      error: 'The turn ended without a result.',
    });
  });

  it('does not cache an in-flight turn', () => {
    const id = insertRun({ startedAt: sec(1), status: 'running' });
    writeLog(id, [init('s'), ...text('thinking hard')]);
    expect(m.history.listHistory(AGENT_ID).turns[0]!.messages[1]).toMatchObject({
      complete: false,
    });

    m.runs.markRunFinished(id, { code: 0, isError: false, text: 'done' });
    writeLog(id, [init('s'), ...text('thinking hard'), result('s')]);
    expect(m.history.listHistory(AGENT_ID).turns[0]!.messages[1]).toMatchObject({
      complete: true,
      cost: 0.01,
    });
  });
});
