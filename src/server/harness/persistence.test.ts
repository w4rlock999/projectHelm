import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprintFromInit } from './fingerprint.ts';

// The fingerprint's two homes — `runs.harness` and `agents.last_harness` —
// against a real SQLite database migrated with the checked-in migrations.
//
// Same fixture discipline as bundle/roundtrip.test.ts: paths.ts derives
// helmRoot from process.cwd() at module load, so chdir first and import every
// helm module dynamically afterwards.

let root: string;
let originalCwd: string;
type Mods = {
  db: typeof import('../../db/index.ts');
  schema: typeof import('../../db/schema.ts');
  agents: typeof import('../agents.ts');
  runs: typeof import('../runs.ts');
  remoteInfo: typeof import('../remote-info.ts');
};
let m: Mods;

beforeAll(async () => {
  originalCwd = process.cwd();
  root = mkdtempSync(path.join(tmpdir(), 'helm-harness-'));
  mkdirSync(path.join(root, '.helm'), { recursive: true });
  process.chdir(root);

  const Database = (await import('better-sqlite3')).default;
  const sqlite = new Database(path.join(root, '.helm', 'db.sqlite'));
  const migrationsDir = path.join(originalCwd, 'drizzle');
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
  sqlite.close();

  m = {
    db: await import('../../db/index.ts'),
    schema: await import('../../db/schema.ts'),
    agents: await import('../agents.ts'),
    runs: await import('../runs.ts'),
    remoteInfo: await import('../remote-info.ts'),
  };
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

const INIT = {
  type: 'system',
  subtype: 'init',
  claude_code_version: '2.1.277',
  model: 'claude-sonnet-5',
  permissionMode: 'default',
  tools: ['Bash', 'Read'],
  skills: ['dataviz'],
  plugins: [{ name: 'code-review', path: '/host/only', source: 'code-review@official' }],
  mcp_servers: [{ name: 'fetch', status: 'connected' }],
  agents: ['Explore'],
  slash_commands: ['simplify'],
  memory_paths: { auto: '/home/x/.claude/projects/slug/memory/' },
};

describe('harness fingerprint persistence', () => {
  it('is written to the run and to the agent, and reads back identically', () => {
    const agent = m.agents.createAgent({ name: 'fp', systemPrompt: 'You are fp.' });
    const fp = fingerprintFromInit(INIT, 1_700_000_000_000);

    const { runId } = m.runs.reserveRun(agent.id, { source: 'manual', prompt: 'ping' });
    m.runs.markRunStarted(runId);
    m.runs.markRunFinished(runId, { code: 0, isError: false, text: 'ok', harness: fp });
    m.agents.updateAgentLastHarness(agent.id, fp);

    const run = m.runs.listRuns(agent.id, 1)[0];
    expect(run.harness).toEqual(fp);
    expect(m.agents.loadAgent(agent.id)?.lastHarness).toEqual(fp);
  });

  it('stays null when the CLI never reached init, on both the finished and the errored path', () => {
    const agent = m.agents.createAgent({ name: 'fp2', systemPrompt: 'You are fp2.' });

    const a = m.runs.reserveRun(agent.id, { source: 'manual', prompt: 'x' }).runId;
    m.runs.markRunStarted(a);
    m.runs.markRunFinished(a, { code: 1, isError: true, text: 'died' });

    const b = m.runs.reserveRun(agent.id, { source: 'manual', prompt: 'y' }).runId;
    m.runs.markRunStarted(b);
    m.runs.markRunErrored(b, 'spawn ENOENT');

    for (const r of m.runs.listRuns(agent.id, 2)) expect(r.harness).toBeNull();
    expect(m.agents.loadAgent(agent.id)?.lastHarness).toBeNull();
  });
});

describe('RemoteInfoSchema compatibility', () => {
  it('still parses an M-remote-2 handshake with none of the H0 fields', () => {
    // Locks the optionality rule: a required field here breaks `ping` against
    // an older daemon, and ping is how the operator *sees* version skew.
    const m2 = {
      helmVersion: '0.1.0',
      headless: true,
      harnesses: [{ type: 'claude-code', version: '2.1.270', authOk: true }],
      agentCount: 1,
      uptimeSec: 5,
      bundleFormats: [1],
      paused: false,
      deployedAgentCount: 0,
    };
    expect(m.remoteInfo.RemoteInfoSchema.safeParse(m2).success).toBe(true);
  });

  it('parses the H0 handshake this daemon now emits', async () => {
    const info = await m.remoteInfo.getRemoteInfo();
    expect(m.remoteInfo.RemoteInfoSchema.safeParse(info).success).toBe(true);
    expect(info.helmBuild).toBeTypeOf('string');
    expect(info.harnesses[0].runtimes).toBeDefined();
    // Machine parity P0: the facts ride on the same handshake.
    expect(info.machine?.appDir).toBeTypeOf('string');
    // Migrated by hand, so drizzle's bookkeeping table does not exist here.
    expect(info.schemaVersion).toBeUndefined();
  });
});
