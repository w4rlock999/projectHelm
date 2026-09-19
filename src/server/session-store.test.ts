import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Both session stores against a real SQLite database. The persistence half is
// where a silent bug would live — a `clear()` that only reset the in-memory
// cache would look fine for one turn and re-brick the agent on the next
// process. Same throwaway-root technique as remotes/orphans.test.ts: paths.ts
// derives helmRoot from cwd at module load, so every helm module is imported
// dynamically, after the chdir.

let root: string;
let originalCwd: string;
let m: {
  db: typeof import('../db/index.ts');
  schema: typeof import('../db/schema.ts');
  run: typeof import('./run.ts');
  gateways: typeof import('./runtime/gateways.ts');
};

const AGENT_ID = 'a9e77000-0000-4000-8000-000000000101';
const GATEWAY_ID = 'c0ffee00-0000-4000-8000-000000000102';
const CHAT_ID = 'cffa7000-0000-4000-8000-000000000103';
const OTHER_CHAT_ID = 'cffa7000-0000-4000-8000-000000000104';
const LIVE = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  originalCwd = process.cwd();
  root = mkdtempSync(path.join(tmpdir(), 'helm-session-store-'));
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
    run: await import('./run.ts'),
    gateways: await import('./runtime/gateways.ts'),
  };
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  const { db } = m.db;
  const { agents, gateways, gatewaysChat } = m.schema;
  db.delete(gatewaysChat).run();
  db.delete(gateways).run();
  db.delete(agents).run();

  db.insert(agents)
    .values({ id: AGENT_ID, name: 'tester', systemPrompt: 'be brief', claudeSessionId: LIVE })
    .run();
  db.insert(gateways).values({ id: GATEWAY_ID, agentId: AGENT_ID, token: 'bot:test' }).run();
  for (const [id, chatId] of [
    [CHAT_ID, '5001'],
    [OTHER_CHAT_ID, '5002'],
  ]) {
    db.insert(gatewaysChat)
      .values({ id, gatewayId: GATEWAY_ID, chatId, claudeSessionId: LIVE })
      .run();
  }
});

function agentRow() {
  return m.db.db.select().from(m.schema.agents).where(eq(m.schema.agents.id, AGENT_ID)).get();
}

function chatRow(id: string) {
  return m.db.db.select().from(m.schema.gatewaysChat).where(eq(m.schema.gatewaysChat.id, id)).get();
}

describe('agentStore', () => {
  it('persists a new session id', () => {
    const store = m.run.agentStore({ id: AGENT_ID, claudeSessionId: null });
    store.set('fresh');
    expect(store.get()).toBe('fresh');
    expect(agentRow()?.claudeSessionId).toBe('fresh');
  });

  it('clear() forgets the id in the row, not just in memory', () => {
    const store = m.run.agentStore({ id: AGENT_ID, claudeSessionId: LIVE });
    store.clear();
    expect(store.get()).toBeNull();
    // The half that matters: a cache-only clear re-bricks the agent next boot.
    expect(agentRow()?.claudeSessionId).toBeNull();
  });
});

describe('chatStore', () => {
  it('persists a new session id', () => {
    const store = m.gateways.chatStore({ id: CHAT_ID, claudeSessionId: null });
    store.set('fresh');
    expect(store.get()).toBe('fresh');
    expect(chatRow(CHAT_ID)?.claudeSessionId).toBe('fresh');
  });

  it('clear() forgets only its own chat', () => {
    const store = m.gateways.chatStore({ id: CHAT_ID, claudeSessionId: LIVE });
    store.clear();
    expect(store.get()).toBeNull();
    expect(chatRow(CHAT_ID)?.claudeSessionId).toBeNull();
    // A stray `where` would silently reset every conversation on the bot.
    expect(chatRow(OTHER_CHAT_ID)?.claudeSessionId).toBe(LIVE);
    // And it must not touch the agent-scope session either.
    expect(agentRow()?.claudeSessionId).toBe(LIVE);
  });
});
