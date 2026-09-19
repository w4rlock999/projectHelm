import { describe, expect, it } from 'vitest';
import { fingerprintFromInit, harnessDiff, HarnessFingerprintSchema } from './fingerprint.ts';

// Verbatim shape of a `system/init` event from claude 2.1.277 (values trimmed).
// It is both the parsing fixture and a lock on which fields we depend on.
const INIT_2_1_277 = {
  type: 'system',
  subtype: 'init',
  cwd: '/x/.helm/agents/e540a895/workspace',
  session_id: '5c2bc703-94b1-4e3a-acae-6c8b7c536307',
  tools: ['Task', 'Bash', 'Edit', 'Read', 'Skill', 'mcp__fetch__fetch'],
  mcp_servers: [{ name: 'fetch', status: 'connected' }],
  model: 'claude-sonnet-5',
  permissionMode: 'default',
  slash_commands: ['deep-research', 'code-review:code-review'],
  terminal_slash_commands: ['doctor'],
  apiKeySource: 'none',
  claude_code_version: '2.1.277',
  output_style: 'default',
  agents: ['claude', 'Explore', 'general-purpose', 'Plan'],
  skills: ['deep-research', 'design', 'dataviz'],
  plugins: [
    {
      name: 'code-review',
      path: '/Users/x/.claude/plugins/cache/claude-plugins-official/code-review/c447c3207a42',
      source: 'code-review@claude-plugins-official',
    },
  ],
  capabilities: ['interrupt_receipt_v1'],
  analytics_disabled: false,
  uuid: 'e3ab57aa-001c-4b0a-bdc3-3e42441a11d7',
  memory_paths: { auto: '/Users/x/.claude/projects/-x-workspace/memory/' },
  fast_mode_state: 'off',
};

describe('fingerprintFromInit', () => {
  it('keeps names and statuses from a real init event, and nothing else', () => {
    const fp = fingerprintFromInit(INIT_2_1_277, 1_700_000_000_000);
    expect(fp).toEqual({
      claudeVersion: '2.1.277',
      model: 'claude-sonnet-5',
      permissionMode: 'default',
      tools: ['Task', 'Bash', 'Edit', 'Read', 'Skill', 'mcp__fetch__fetch'],
      skills: ['deep-research', 'design', 'dataviz'],
      plugins: [{ name: 'code-review', source: 'code-review@claude-plugins-official' }],
      mcpServers: [{ name: 'fetch', status: 'connected' }],
      agents: ['claude', 'Explore', 'general-purpose', 'Plan'],
      slashCommands: ['deep-research', 'code-review:code-review'],
      memoryPaths: { auto: '/Users/x/.claude/projects/-x-workspace/memory/' },
      capturedAt: 1_700_000_000_000,
    });
    // The plugin *path* is a host-local detail and must not travel.
    expect(JSON.stringify(fp)).not.toContain('/plugins/cache/');
  });

  it('round-trips through its own schema', () => {
    const fp = fingerprintFromInit(INIT_2_1_277);
    expect(HarnessFingerprintSchema.parse(JSON.parse(JSON.stringify(fp)))).toEqual(fp);
  });

  it('degrades to empty arrays and nulls for an older CLI', () => {
    const fp = fingerprintFromInit({ type: 'system', subtype: 'init', model: 'sonnet' }, 1);
    expect(fp).toEqual({
      claudeVersion: null,
      model: 'sonnet',
      permissionMode: null,
      tools: [],
      skills: [],
      plugins: [],
      mcpServers: [],
      agents: [],
      slashCommands: [],
      capturedAt: 1,
    });
  });

  it('never throws on junk in a field', () => {
    const fp = fingerprintFromInit(
      { tools: 'Bash', plugins: [null, 3, { source: 'x' }], mcp_servers: [{ name: 'a' }] },
      1,
    );
    expect(fp.tools).toEqual([]);
    expect(fp.plugins).toEqual([]);
    expect(fp.mcpServers).toEqual([{ name: 'a', status: 'unknown' }]);
  });
});

describe('harnessDiff', () => {
  const observed = fingerprintFromInit(INIT_2_1_277, 1);

  it('is empty when nothing was declared — bundled extras are never drift', () => {
    expect(harnessDiff({}, observed)).toEqual([]);
  });

  it('is empty when everything declared was loaded', () => {
    expect(
      harnessDiff(
        {
          mcpServers: ['fetch'],
          skills: ['dataviz'],
          plugins: ['code-review'],
          permissionMode: 'default',
        },
        observed,
      ),
    ).toEqual([]);
  });

  it('names each missing or failed item', () => {
    const problems = harnessDiff(
      {
        mcpServers: ['fetch', 'github'],
        skills: ['notes'],
        plugins: ['helm'],
        permissionMode: 'acceptEdits',
      },
      { ...observed, mcpServers: [{ name: 'fetch', status: 'failed' }] },
    );
    expect(problems).toEqual([
      'mcp server "fetch" is failed',
      'mcp server "github" was not loaded',
      'skill "notes" was not discovered',
      'plugin "helm" was not loaded',
      'permission mode is default, expected acceptEdits',
    ]);
  });

  it('does not flag permission mode when the CLI did not report one', () => {
    expect(
      harnessDiff({ permissionMode: 'acceptEdits' }, { ...observed, permissionMode: null }),
    ).toEqual([]);
  });
});
