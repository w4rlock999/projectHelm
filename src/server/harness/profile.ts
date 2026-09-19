import { z } from 'zod';

// The harness profile: the part of an agent's Claude Code configuration that
// has a CLI flag. Pure — no I/O, no database — so the resolve/flag matrix is
// unit-testable and the bundle format can share the schema.
//
// Everything here is *owned by argv*. Nothing in this profile is ever written
// into the rendered `--settings` file (render.ts), because flags beat settings
// and two owners for one knob is how a value silently disagrees with itself.

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * `plan` and `bypassPermissions` are excluded on purpose: plan mode makes a
 * headless heartbeat a no-op that writes nothing, and bypass is refused by the
 * CLI when running as root — which is exactly what the VPS daemon is.
 * `default` in `-p` mode denies anything outside `--allowedTools`.
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'dontAsk'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Per-agent profile. Every field is nullable and defaults to null: null means
 * "inherit the fleet default", and a fleet default of null means "let the CLI
 * decide" (no flag is emitted). Strict, so a typo'd key is an error rather
 * than a silently ignored setting — and so a bundle cannot smuggle a key.
 */
export const HarnessProfileSchema = z.strictObject({
  effort: z.enum(EFFORTS).nullable().default(null),
  permissionMode: z.enum(PERMISSION_MODES).nullable().default(null),
  maxTurns: z.number().int().min(1).max(10_000).nullable().default(null),
  /** A model alias or id the CLI may fall back to when the primary is overloaded. */
  fallbackModel: z.string().trim().min(1).max(200).nullable().default(null),
});
export type HarnessProfile = z.infer<typeof HarnessProfileSchema>;

export const EMPTY_PROFILE: HarnessProfile = {
  effort: null,
  permissionMode: null,
  maxTurns: null,
  fallbackModel: null,
};

/**
 * Field-wise `agent ?? fleetDefault ?? null`. Either side may be absent (an
 * agent that never set a profile has `harness = null` in the database).
 */
export function resolveHarnessProfile(
  agent: Partial<HarnessProfile> | null | undefined,
  fleetDefaults: Partial<HarnessProfile> | null | undefined,
): HarnessProfile {
  const pick = <K extends keyof HarnessProfile>(k: K): HarnessProfile[K] =>
    (agent?.[k] ?? fleetDefaults?.[k] ?? null) as HarnessProfile[K];
  return {
    effort: pick('effort'),
    permissionMode: pick('permissionMode'),
    maxTurns: pick('maxTurns'),
    fallbackModel: pick('fallbackModel'),
  };
}

/**
 * Thrown for a profile the CLI would refuse at spawn. Caught at the write
 * surfaces (tRPC, REST) so the operator sees it when they set the value, not
 * as a failed heartbeat at 3am. Checked against the *effective* profile,
 * because a fleet default can collide with an agent's model too.
 */
export class HarnessProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessProfileError';
  }
}

/**
 * `--fallback-model X --model X` is refused by the CLI, and a CLI that dies
 * parsing its argv emits no result — so this would trip the "exited before
 * producing a result" path on every turn.
 */
export function assertProfileRunnable(profile: HarnessProfile, effectiveModel: string): void {
  if (profile.fallbackModel !== null && profile.fallbackModel === effectiveModel) {
    throw new HarnessProfileError(
      `fallback model "${profile.fallbackModel}" is the same as the agent's model — the CLI refuses that`,
    );
  }
}

/**
 * Everything the adapter needs to spawn an isolated `claude`. Built by
 * `agentRuntime` (agents.ts) from the resolved profile and the rendered file
 * paths; the adapter never touches the database or the filesystem itself.
 */
export interface HarnessArgv {
  /** `--settings <file>`: the rendered per-agent settings.json. */
  settingsFile: string;
  /** `--mcp-config <file>`: the rendered per-agent mcp.json (with --strict-mcp-config). */
  mcpConfigFile: string;
  /** One `--plugin-dir` each. Empty in H1. */
  pluginDirs: string[];
  profile: HarnessProfile;
  /** Assigned MCP server names — each becomes an `mcp__<name>` allow-list entry. Empty in H1. */
  mcpServerNames: string[];
  /** Whether any skill was rendered into `workspace/.claude/skills` (adds `Skill` to the allow-list). */
  hasSkills: boolean;
}

/**
 * The isolation and profile flags, in a fixed order so an argv is comparable
 * across runs and machines. Nothing is emitted for a null profile field: the
 * CLI's own default applies, and the fingerprint records what that was.
 */
export function harnessFlags(h: HarnessArgv): string[] {
  const args: string[] = [];
  // Only the project scope: the user's ~/.claude settings, skills and plugins
  // are the host's, not the agent's. The project scope is the workspace's
  // `.claude/`, which render.ts wipes before every spawn.
  args.push('--setting-sources', 'project');
  args.push('--settings', h.settingsFile);
  // Strict: the host's ~/.claude.json MCP servers must not leak in.
  args.push('--strict-mcp-config', '--mcp-config', h.mcpConfigFile);
  for (const dir of h.pluginDirs) args.push('--plugin-dir', dir);
  const p = h.profile;
  if (p.effort !== null) args.push('--effort', p.effort);
  if (p.maxTurns !== null) args.push('--max-turns', String(p.maxTurns));
  if (p.fallbackModel !== null) args.push('--fallback-model', p.fallbackModel);
  if (p.permissionMode !== null) args.push('--permission-mode', p.permissionMode);
  return args;
}

/**
 * The tool names the harness itself adds to the agent's allow-list: `Skill`
 * when skills are rendered (the Skill tool is how a skill is invoked) and one
 * `mcp__<server>` per assigned MCP server (a whole-server grant; the CLI
 * exposes each of its tools as `mcp__<server>__<tool>`).
 */
export function harnessAllowedTools(h: HarnessArgv): string[] {
  const extra: string[] = [];
  if (h.hasSkills) extra.push('Skill');
  for (const name of h.mcpServerNames) extra.push(`mcp__${name}`);
  return extra;
}
