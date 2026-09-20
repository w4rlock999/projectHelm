import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A real `claude -p` turn through runAgentTurn, against a throwaway .helm tree.
//
// Costs one tiny model call on the developer's subscription and needs a
// logged-in CLI, so it is opt-in: `HELM_LIVE=1 pnpm test -- live`. It is the
// only test that proves the fingerprint comes from the CLI that actually runs
// here, not from a fixture.

const live = process.env.HELM_LIVE === '1';

let root: string;
let originalCwd: string;
type Mods = {
  agents: typeof import('../agents.ts');
  run: typeof import('../run.ts');
  runs: typeof import('../runs.ts');
};
let m: Mods;

beforeAll(async () => {
  if (!live) return;
  originalCwd = process.cwd();
  root = mkdtempSync(path.join(tmpdir(), 'helm-live-'));
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
    agents: await import('../agents.ts'),
    run: await import('../run.ts'),
    runs: await import('../runs.ts'),
  };
});

afterAll(() => {
  if (!live) return;
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!live)('live harness fingerprint', () => {
  it('captures the CLI version and toolset from a real turn and stores it on the run and the agent', async () => {
    const agent = m.agents.createAgent({
      name: 'live-fp',
      systemPrompt: 'Reply with the single word ok and nothing else.',
    });
    const turn = await m.run.runAgentTurn(agent.id, 'reply ok', { source: 'manual' });

    expect(turn.isError).toBe(false);
    expect(turn.harness).not.toBeNull();
    expect(turn.harness!.claudeVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(turn.harness!.model).toMatch(/^claude-/);
    expect(turn.harness!.tools).toContain('Bash');
    expect(turn.harness!.skills.length).toBeGreaterThan(0);
    // Isolation (H1): nothing from this machine's ~/.claude leaked in. The
    // bundled skills remain (they ship with the CLI), but no user-scope MCP
    // server does, and the only plugin the CLI may load on its own is the
    // auto-installed agents-md.
    expect(turn.harness!.mcpServers).toEqual([]);
    for (const p of turn.harness!.plugins) expect(p.name).toBe('agents-md');
    expect(turn.harness!.permissionMode).toBe('default');

    const run = m.runs.listRuns(agent.id, 1)[0];
    expect(run.status).toBe('ok');
    expect(run.harness).toEqual(turn.harness);
    expect(m.agents.loadAgent(agent.id)?.lastHarness).toEqual(turn.harness);

    // The argv is in the run log next to the fingerprint it produced.
    const log = readFileSync(
      path.join(root, '.helm', 'agents', agent.id, 'logs', `${turn.runId}.ndjson`),
      'utf8',
    );
    const meta = JSON.parse(log.split('\n')[0]);
    expect(meta.type).toBe('helm_meta');
    expect(meta.argv).toContain('--allowedTools');
    expect(meta.argv).toContain('--strict-mcp-config');
    expect(meta.argv[meta.argv.indexOf('--setting-sources') + 1]).toBe('project');
    // The rendered files the argv points at exist.
    expect(existsSync(meta.argv[meta.argv.indexOf('--settings') + 1])).toBe(true);
    expect(existsSync(meta.argv[meta.argv.indexOf('--mcp-config') + 1])).toBe(true);
  }, 180_000);
});
