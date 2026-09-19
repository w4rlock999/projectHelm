import { describe, expect, it } from 'vitest';
import {
  assertProfileRunnable,
  EMPTY_PROFILE,
  harnessAllowedTools,
  harnessFlags,
  HarnessProfileSchema,
  resolveHarnessProfile,
  type HarnessArgv,
} from './profile.ts';

const argv = (over: Partial<HarnessArgv> = {}): HarnessArgv => ({
  settingsFile: '/h/settings.json',
  mcpConfigFile: '/h/mcp.json',
  pluginDirs: [],
  profile: { ...EMPTY_PROFILE },
  mcpServerNames: [],
  hasSkills: false,
  ...over,
});

describe('HarnessProfileSchema', () => {
  it('defaults every field to null', () => {
    expect(HarnessProfileSchema.parse({})).toEqual(EMPTY_PROFILE);
  });

  it('is strict: an unknown key is an error, not a silently ignored setting', () => {
    expect(HarnessProfileSchema.safeParse({ hooks: {} }).success).toBe(false);
    expect(HarnessProfileSchema.safeParse({ env: { ANTHROPIC_BASE_URL: 'x' } }).success).toBe(
      false,
    );
  });

  it('rejects modes the daemon cannot run under', () => {
    expect(HarnessProfileSchema.safeParse({ permissionMode: 'plan' }).success).toBe(false);
    expect(HarnessProfileSchema.safeParse({ permissionMode: 'bypassPermissions' }).success).toBe(
      false,
    );
    expect(HarnessProfileSchema.safeParse({ effort: 'turbo' }).success).toBe(false);
    expect(HarnessProfileSchema.safeParse({ maxTurns: 0 }).success).toBe(false);
  });
});

describe('resolveHarnessProfile', () => {
  it('prefers the agent, then the fleet default, then null', () => {
    const r = resolveHarnessProfile(
      { effort: 'low', permissionMode: null, maxTurns: null, fallbackModel: null },
      { effort: 'high', permissionMode: 'acceptEdits', maxTurns: 50, fallbackModel: null },
    );
    expect(r).toEqual({
      effort: 'low',
      permissionMode: 'acceptEdits',
      maxTurns: 50,
      fallbackModel: null,
    });
  });

  it('tolerates a missing side', () => {
    expect(resolveHarnessProfile(null, null)).toEqual(EMPTY_PROFILE);
    expect(resolveHarnessProfile(undefined, { effort: 'max' }).effort).toBe('max');
    expect(resolveHarnessProfile({ maxTurns: 3 }, undefined).maxTurns).toBe(3);
  });
});

describe('harnessFlags', () => {
  it('always emits the isolation flags, in a fixed order', () => {
    expect(harnessFlags(argv())).toEqual([
      '--setting-sources',
      'project',
      '--settings',
      '/h/settings.json',
      '--strict-mcp-config',
      '--mcp-config',
      '/h/mcp.json',
    ]);
  });

  it('emits a profile flag only for a non-null field', () => {
    const flags = harnessFlags(
      argv({
        pluginDirs: ['/h/plugins/a', '/h/plugins/b'],
        profile: { effort: 'xhigh', permissionMode: 'dontAsk', maxTurns: 12, fallbackModel: null },
      }),
    );
    expect(flags.slice(7)).toEqual([
      '--plugin-dir',
      '/h/plugins/a',
      '--plugin-dir',
      '/h/plugins/b',
      '--effort',
      'xhigh',
      '--max-turns',
      '12',
      '--permission-mode',
      'dontAsk',
    ]);
    expect(flags).not.toContain('--fallback-model');
  });
});

describe('harnessAllowedTools', () => {
  it('adds Skill only when skills are rendered, and one whole-server grant per MCP server', () => {
    expect(harnessAllowedTools(argv())).toEqual([]);
    expect(harnessAllowedTools(argv({ hasSkills: true }))).toEqual(['Skill']);
    expect(harnessAllowedTools(argv({ mcpServerNames: ['fetch', 'gh'] }))).toEqual([
      'mcp__fetch',
      'mcp__gh',
    ]);
  });
});

describe('assertProfileRunnable', () => {
  it('rejects a fallback model equal to the effective model', () => {
    expect(() =>
      assertProfileRunnable({ ...EMPTY_PROFILE, fallbackModel: 'sonnet' }, 'sonnet'),
    ).toThrowError(/same as the agent's model/);
    expect(() =>
      assertProfileRunnable({ ...EMPTY_PROFILE, fallbackModel: 'haiku' }, 'sonnet'),
    ).not.toThrow();
    expect(() => assertProfileRunnable(EMPTY_PROFILE, 'sonnet')).not.toThrow();
  });
});
