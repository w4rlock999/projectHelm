import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HarnessProfile } from './profile.ts';

// Render an agent's harness to disk: the files `claude` is pointed at by the
// isolation flags (profile.ts). Pure filesystem — no database — so the bundle
// importer can render into a quarantine directory before any row exists, and
// run.ts can re-render right before a spawn.
//
// Two trees are involved:
//
//   <agentDir>/harness/          helm-owned, NOT the agent's cwd, 0700
//     settings.json              --settings
//     mcp.json                   --strict-mcp-config --mcp-config
//     plugins/<name>/            --plugin-dir each (H2; emptied here)
//   <workspaceDir>/.claude/      the *project* setting source
//     skills/<name>/SKILL.md     discovered by the CLI in -p mode (H2)
//
// The workspace is agent-writable, and with `--setting-sources project` a
// `.claude/settings.json` the agent wrote there would be *the* settings source
// (hooks, `env.ANTHROPIC_BASE_URL`, `apiKeyHelper`…). So `.claude/` is wiped
// and rebuilt from helm's data on every render, and the exporter refuses to
// carry it (bundle/export.ts).

export interface RenderHarnessInput {
  harnessDir: string;
  workspaceDir: string;
  profile: HarnessProfile;
  /** H2. Empty in H1: mcp.json is `{ "mcpServers": {} }`. */
  mcpServers: unknown[];
  /** H2. Empty in H1: `.claude/skills/` is created empty. */
  skills: unknown[];
  /** H2. Empty in H1: `harness/plugins/` is emptied. */
  plugins: unknown[];
}

export interface RenderedHarness {
  settingsFile: string;
  mcpConfigFile: string;
  pluginDirs: string[];
  hasSkills: boolean;
  mcpServerNames: string[];
}

/**
 * Bound on how long the CLI waits for an MCP server to start before marking it
 * `failed` in `system/init`. Set here (as settings `env`) rather than in the
 * daemon's own environment, so it applies per spawn on every machine. Fifteen
 * seconds: enough for an `npx` cold start, short enough that a broken server
 * shows up in the import smoke turn rather than hanging it.
 */
export const MCP_TIMEOUT_MS = 15_000;

/**
 * Keys that have a CLI flag and must therefore NEVER appear in the rendered
 * settings file. Asserted by render.test.ts against the rendered output.
 */
export const ARGV_OWNED_SETTINGS_KEYS = [
  'model',
  'effort',
  'permissions',
  'allowedTools',
  'maxTurns',
  'fallbackModel',
] as const;

/** The settings.json body. Exported so the test can pin its shape. */
export function harnessSettingsJson(): Record<string, unknown> {
  return { env: { MCP_TIMEOUT: String(MCP_TIMEOUT_MS) } };
}

/**
 * Write the harness. Idempotent; safe to call with a turn *not* in flight for
 * this agent (run.ts calls it inside the per-agent chain for that reason —
 * wiping `.claude/` under a running CLI would be a race).
 */
export function renderHarnessFiles(input: RenderHarnessInput): RenderedHarness {
  const { harnessDir, workspaceDir } = input;

  // 1. The project setting source: wipe, then rebuild from helm's data.
  const dotClaude = path.join(workspaceDir, '.claude');
  rmSync(dotClaude, { recursive: true, force: true });
  mkdirSync(path.join(dotClaude, 'skills'), { recursive: true });
  // The other two files the CLI reads from the project directory. Neither is
  // helm-rendered, so their presence is agent-authored and they are removed.
  rmSync(path.join(workspaceDir, '.mcp.json'), { force: true });
  rmSync(path.join(workspaceDir, 'CLAUDE.local.md'), { force: true });

  // 2. The helm-owned tree. 0700/0600: mcp.json will carry MCP secrets in H2.
  mkdirSync(harnessDir, { recursive: true, mode: 0o700 });
  chmodSync(harnessDir, 0o700);

  const settingsFile = path.join(harnessDir, 'settings.json');
  writeSecret(settingsFile, JSON.stringify(harnessSettingsJson(), null, 2) + '\n');

  const mcpConfigFile = path.join(harnessDir, 'mcp.json');
  writeSecret(mcpConfigFile, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');

  const pluginsDir = path.join(harnessDir, 'plugins');
  mkdirSync(pluginsDir, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(pluginsDir)) {
    rmSync(path.join(pluginsDir, entry), { recursive: true, force: true });
  }

  return {
    settingsFile,
    mcpConfigFile,
    pluginDirs: [],
    hasSkills: false,
    mcpServerNames: [],
  };
}

function writeSecret(file: string, contents: string): void {
  writeFileSync(file, contents, { mode: 0o600 });
  chmodSync(file, 0o600);
}
