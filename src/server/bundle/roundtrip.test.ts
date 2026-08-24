import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A true export -> delete -> import round-trip against a real SQLite database.
//
// Runs against a throwaway .helm tree, not the developer's: paths.ts derives
// helmRoot from process.cwd() at module load, so chdir-ing before the first
// dynamic import relocates the entire data plane. Every helm module here must
// therefore be imported dynamically, after the chdir.

let root: string;
let originalCwd: string;
type Mods = {
  db: typeof import('../../db/index.ts');
  schema: typeof import('../../db/schema.ts');
  agents: typeof import('../agents.ts');
  paths: typeof import('../paths.ts');
  exportMod: typeof import('./export.ts');
  importMod: typeof import('./import.ts');
};
let m: Mods;

beforeAll(async () => {
  originalCwd = process.cwd();
  root = mkdtempSync(path.join(tmpdir(), 'helm-roundtrip-'));
  mkdirSync(path.join(root, '.helm'), { recursive: true });
  process.chdir(root);

  // Apply the real migrations directly. drizzle-kit is not used here because
  // drizzle.config.ts resolves both the schema and the database relative to
  // cwd, so running it from either directory would target the wrong one.
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
    paths: await import('../paths.ts'),
    exportMod: await import('./export.ts'),
    importMod: await import('./import.ts'),
  };
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('export -> import round-trip', () => {
  it('moves an agent, its workspace and its data plane', async () => {
    const agent = m.agents.createAgent({
      name: 'Round Trip',
      systemPrompt: 'You are a test agent.',
      model: 'sonnet',
    });

    // Agent-authored content in both planes.
    writeFileSync(path.join(m.paths.paths.agentWorkspaceDir(agent.id), 'notes.md'), 'kept\n');
    writeFileSync(
      path.join(m.paths.paths.agentStoreArtifactsDir(agent.id), 'memory.json'),
      '{"seen":42}',
    );
    // A session id must NOT survive a move.
    m.agents.updateAgentSessionId(agent.id, 'sess_local_only');

    const exported = await m.exportMod.exportAgentBundle(agent.id);
    expect(exported.manifest.agent.id).toBe(agent.id);
    expect(exported.manifest.contents.data).toBe(true);
    expect(exported.bytes).toBeGreaterThan(0);

    // Move semantics: the source goes away before the bundle is re-imported.
    m.agents.deleteAgent(agent.id);
    expect(m.agents.loadAgent(agent.id)).toBe(null);

    const result = await m.importMod.importAgentBundle(exported.path);
    expect(result.agentId).toBe(agent.id);

    const restored = m.agents.loadAgent(agent.id);
    expect(restored?.name).toBe('Round Trip');
    expect(restored?.systemPrompt).toBe('You are a test agent.');
    // Claude sessions live under ~/.claude on the source machine — a shipped
    // agent must start fresh rather than resume a session that isn't there.
    expect(restored?.claudeSessionId).toBe(null);
    expect(restored?.isOperator).toBe(false);
    expect(restored?.deployState).toBe(null);

    // Workspace content travels; CLAUDE.md is regenerated, not carried.
    const ws = m.paths.paths.agentWorkspaceDir(agent.id);
    expect(readFileSync(path.join(ws, 'notes.md'), 'utf8')).toBe('kept\n');
    expect(readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8')).toContain('You are a test agent.');
    // The managed block is re-rendered by tools.ts on import.
    expect(readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8')).toContain('Tools available to you');

    // Data plane travels — this is the only continuity a shipped agent has.
    expect(
      readFileSync(
        path.join(m.paths.paths.agentStoreArtifactsDir(agent.id), 'memory.json'),
        'utf8',
      ),
    ).toBe('{"seen":42}');
  });

  it('refuses to import over an agent that already exists', async () => {
    const agent = m.agents.createAgent({ name: 'Dup', systemPrompt: 'x' });
    const exported = await m.exportMod.exportAgentBundle(agent.id);

    // The agent is still present, so this is the conflict case.
    await expect(m.importMod.importAgentBundle(exported.path)).rejects.toThrowError(
      /already exists/,
    );
    // And the failure left the existing agent untouched.
    expect(m.agents.loadAgent(agent.id)?.name).toBe('Dup');
  });

  it('refuses to export the operator agent', async () => {
    const captain = m.db.db
      .insert(m.schema.agents)
      .values({
        id: '3f2504e0-4f89-41d3-9a0c-0305e82c3399',
        name: 'helmCaptain',
        systemPrompt: 'operator',
        isOperator: true,
      })
      .run();
    expect(captain).toBeDefined();
    await expect(
      m.exportMod.exportAgentBundle('3f2504e0-4f89-41d3-9a0c-0305e82c3399'),
    ).rejects.toThrowError(/singleton/);
  });

  it('omits the data plane with --without-data', async () => {
    const agent = m.agents.createAgent({ name: 'Lean', systemPrompt: 'x' });
    writeFileSync(
      path.join(m.paths.paths.agentStoreArtifactsDir(agent.id), 'big.bin'),
      'x'.repeat(1024),
    );
    const exported = await m.exportMod.exportAgentBundle(agent.id, { withData: false });
    expect(exported.manifest.contents.data).toBe(false);
    expect(exported.manifest.contents.dataFiles).toBe(0);
  });
});
