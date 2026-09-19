import { z } from 'zod';

// The harness fingerprint: what Claude Code *actually* loaded for one turn,
// read from the `system/init` event it emits before the first API call.
//
// Helm has never owned the harness — the CLI inherits the host's ~/.claude
// (skills, plugins, MCP servers, settings), so the same agent can run with a
// different toolset on the laptop and on the VPS without anything in helm
// noticing. The fingerprint makes that visible: it is stored on every run and
// on the agent, returned by the remote's import smoke turn, and diffed at the
// ship seam. It stores names and statuses only — never configuration, and
// never anything that could carry a secret.
//
// This module is pure: no I/O, no database.

export const McpServerStatusSchema = z.object({
  name: z.string(),
  status: z.string(),
});

export const HarnessFingerprintSchema = z.object({
  /** `claude_code_version` — null when the CLI predates the field. */
  claudeVersion: z.string().nullable(),
  /** The *resolved* model id (an alias like `sonnet` is expanded by the CLI). */
  model: z.string().nullable(),
  permissionMode: z.string().nullable(),
  /** Built-in tools plus `mcp__<server>__<tool>` entries. Varies by CLI version. */
  tools: z.array(z.string()).default([]),
  /** Skill names; bundled CLI skills appear here too, so this varies by version. */
  skills: z.array(z.string()).default([]),
  plugins: z.array(z.object({ name: z.string(), source: z.string().optional() })).default([]),
  /** One entry per configured MCP server with its connection status. */
  mcpServers: z.array(McpServerStatusSchema).default([]),
  agents: z.array(z.string()).default([]),
  slashCommands: z.array(z.string()).default([]),
  /** Where the CLI keeps auto-memory for this cwd; shows whose ~/.claude was inherited. */
  memoryPaths: z.record(z.string(), z.string()).optional(),
  /** Epoch milliseconds when the init event was observed. */
  capturedAt: z.number().int(),
});
export type HarnessFingerprint = z.infer<typeof HarnessFingerprintSchema>;

// Loose readers: a real init event carries many more keys than we keep, and a
// future CLI may rename or drop any of them. The fingerprint must never be the
// reason a turn fails, so every accessor degrades to null/[] instead of throwing.

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    : [];
}

/**
 * Build a fingerprint from a `system/init` event. Accepts the raw parsed JSON
 * line, so callers do not need the event typed first.
 */
export function fingerprintFromInit(
  evt: Record<string, unknown>,
  now = Date.now(),
): HarnessFingerprint {
  const memory = evt.memory_paths;
  const memoryPaths =
    typeof memory === 'object' && memory !== null
      ? Object.fromEntries(
          Object.entries(memory as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === 'string',
          ),
        )
      : undefined;

  return {
    claudeVersion: str(evt.claude_code_version),
    model: str(evt.model),
    permissionMode: str(evt.permissionMode),
    tools: strings(evt.tools),
    skills: strings(evt.skills),
    plugins: records(evt.plugins)
      .map((p) => ({ name: str(p.name), source: str(p.source) ?? undefined }))
      .filter((p): p is { name: string; source: string | undefined } => p.name !== null)
      .map((p) => (p.source === undefined ? { name: p.name } : { name: p.name, source: p.source })),
    mcpServers: records(evt.mcp_servers)
      .map((s) => ({ name: str(s.name), status: str(s.status) ?? 'unknown' }))
      .filter((s): s is { name: string; status: string } => s.name !== null),
    agents: strings(evt.agents),
    slashCommands: strings(evt.slash_commands),
    ...(memoryPaths && Object.keys(memoryPaths).length > 0 ? { memoryPaths } : {}),
    capturedAt: now,
  };
}

// ── diff ────────────────────────────────────────────────────────────────────

/**
 * What helm *declared* for an agent and therefore expects the CLI to have
 * loaded. Empty in H0/H1 (helm declares nothing yet); the library increment
 * fills it from the agent's assigned MCP servers, skills and plugins.
 */
export interface ExpectedHarness {
  mcpServers?: string[];
  skills?: string[];
  plugins?: string[];
  permissionMode?: string | null;
}

/**
 * Problems with an observed fingerprint, as sentences. Empty means the harness
 * loaded everything helm declared.
 *
 * Only declared items are checked: the bundled skill list, the built-in tool
 * inventory and the auto-installed `agents-md` plugin all vary with the CLI
 * version, and treating those as drift would refuse every ship after an
 * upgrade. Extra items are the caller's business (warn, never refuse).
 */
export function harnessDiff(expected: ExpectedHarness, observed: HarnessFingerprint): string[] {
  const problems: string[] = [];

  const byName = new Map(observed.mcpServers.map((s) => [s.name, s.status]));
  for (const name of expected.mcpServers ?? []) {
    const status = byName.get(name);
    if (status === undefined) problems.push(`mcp server "${name}" was not loaded`);
    else if (status !== 'connected') problems.push(`mcp server "${name}" is ${status}`);
  }

  const skills = new Set(observed.skills);
  for (const name of expected.skills ?? []) {
    if (!skills.has(name)) problems.push(`skill "${name}" was not discovered`);
  }

  const plugins = new Set(observed.plugins.map((p) => p.name));
  for (const name of expected.plugins ?? []) {
    if (!plugins.has(name)) problems.push(`plugin "${name}" was not loaded`);
  }

  if (
    expected.permissionMode &&
    observed.permissionMode !== null &&
    observed.permissionMode !== expected.permissionMode
  ) {
    problems.push(
      `permission mode is ${observed.permissionMode}, expected ${expected.permissionMode}`,
    );
  }

  return problems;
}
