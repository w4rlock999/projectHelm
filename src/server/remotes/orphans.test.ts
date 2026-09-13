import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Remote } from '../../db/schema.ts';

// The sweep against a real SQLite database, with the remote delete injected so
// no tunnel or daemon is involved. Same throwaway-root technique as
// bundle/roundtrip.test.ts: paths.ts derives helmRoot from cwd at module load,
// so every helm module here must be imported dynamically, after the chdir.

let root: string;
let originalCwd: string;
let m: {
  db: typeof import('../../db/index.ts');
  schema: typeof import('../../db/schema.ts');
  orphans: typeof import('./orphans.ts');
};

const REMOTE_ID = 'c0ffee00-0000-4000-8000-000000000001';
const AGENT_ID = 'a9e77000-0000-4000-8000-000000000002';

beforeAll(async () => {
  originalCwd = process.cwd();
  root = mkdtempSync(path.join(tmpdir(), 'helm-orphans-'));
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
    db: await import('../../db/index.ts'),
    schema: await import('../../db/schema.ts'),
    orphans: await import('./orphans.ts'),
  };
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  m.db.db.delete(m.schema.recallOrphans).run();
  m.db.db.delete(m.schema.remotes).run();
  m.db.db
    .insert(m.schema.remotes)
    .values({
      id: REMOTE_ID,
      name: 'vps',
      sshTarget: 'helm@example.test',
      helmPort: 5555,
      token: 'helm_rt_test',
    })
    .run();
});

/** A deleter that answers however the test needs, and counts its calls. */
function deleter(answer: { ok: boolean; error?: string } | Error) {
  const calls: { remote: Remote; agentId: string }[] = [];
  return {
    calls,
    fn: async (remote: Remote, agentId: string) => {
      calls.push({ remote, agentId });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe('recall orphans', () => {
  it('records an orphan and lists it as pending', () => {
    m.orphans.recordRecallOrphan(AGENT_ID, REMOTE_ID, 'connection reset');

    const pending = m.orphans.pendingOrphans();
    expect(pending).toHaveLength(1);
    expect(pending[0].agentId).toBe(AGENT_ID);
    expect(pending[0].lastError).toBe('connection reset');
  });

  it('keeps one row per (agent, remote) when the same failure repeats', () => {
    m.orphans.recordRecallOrphan(AGENT_ID, REMOTE_ID, 'first');
    m.orphans.recordRecallOrphan(AGENT_ID, REMOTE_ID, 'second');

    const pending = m.orphans.pendingOrphans();
    expect(pending).toHaveLength(1);
    // The row tracks the latest attempt, not a history of them.
    expect(pending[0].lastError).toBe('second');
  });

  it('clears the row once the remote confirms the delete', async () => {
    m.orphans.recordRecallOrphan(AGENT_ID, REMOTE_ID, 'connection reset');
    const d = deleter({ ok: true });

    const result = await m.orphans.sweepRecallOrphans({ deleter: d.fn });

    expect(result).toEqual({ cleared: 1, kept: 0 });
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0].agentId).toBe(AGENT_ID);
    expect(m.orphans.pendingOrphans()).toHaveLength(0);
  });

  it('keeps the row and records why when the remote refuses', async () => {
    m.orphans.recordRecallOrphan(AGENT_ID, REMOTE_ID, 'connection reset');
    const d = deleter({ ok: false, error: 'not being recalled (deployState=null)' });

    const result = await m.orphans.sweepRecallOrphans({ deleter: d.fn });

    // A refusal means the remote no longer considers it recalling — deleting a
    // live agent there has no undo, so this waits for a human.
    expect(result).toEqual({ cleared: 0, kept: 1 });
    expect(m.orphans.pendingOrphans()[0].lastError).toContain('not being recalled');
  });

  it('keeps the row when the remote is unreachable', async () => {
    m.orphans.recordRecallOrphan(AGENT_ID, REMOTE_ID, 'connection reset');
    const d = deleter(new Error('ssh tunnel failed: Connection refused'));

    const result = await m.orphans.sweepRecallOrphans({ deleter: d.fn });

    expect(result).toEqual({ cleared: 0, kept: 1 });
    expect(m.orphans.pendingOrphans()[0].lastError).toContain('Connection refused');
  });

  it('keeps the row — and never calls the remote — once it is unregistered', async () => {
    m.orphans.recordRecallOrphan(AGENT_ID, REMOTE_ID, 'connection reset');
    m.db.db.delete(m.schema.remotes).run();
    const d = deleter({ ok: true });

    const result = await m.orphans.sweepRecallOrphans({ deleter: d.fn });

    // The row is now the only evidence a copy exists at all.
    expect(result).toEqual({ cleared: 0, kept: 1 });
    expect(d.calls).toHaveLength(0);
    expect(m.orphans.pendingOrphans()[0].lastError).toContain('no longer registered');
  });

  it('sweeps only the named remote when one is given', async () => {
    const otherRemote = 'c0ffee00-0000-4000-8000-000000000003';
    const otherAgent = 'a9e77000-0000-4000-8000-000000000004';
    m.db.db
      .insert(m.schema.remotes)
      .values({
        id: otherRemote,
        name: 'other',
        sshTarget: 'helm@other.test',
        helmPort: 5555,
        token: 'helm_rt_other',
      })
      .run();
    m.orphans.recordRecallOrphan(AGENT_ID, REMOTE_ID, 'x');
    m.orphans.recordRecallOrphan(otherAgent, otherRemote, 'x');
    const d = deleter({ ok: true });

    const result = await m.orphans.sweepRecallOrphans({ remoteId: REMOTE_ID, deleter: d.fn });

    expect(result).toEqual({ cleared: 1, kept: 0 });
    expect(d.calls.map((c) => c.agentId)).toEqual([AGENT_ID]);
    expect(m.orphans.pendingOrphans().map((o) => o.agentId)).toEqual([otherAgent]);
  });

  it('does nothing and touches no remote when there are no orphans', async () => {
    const d = deleter({ ok: true });
    expect(await m.orphans.sweepRecallOrphans({ deleter: d.fn })).toEqual({ cleared: 0, kept: 0 });
    expect(d.calls).toHaveLength(0);
  });
});
