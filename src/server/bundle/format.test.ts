import { describe, expect, it } from 'vitest';
import { mcpContentHash } from '../library/mcp-schema.ts';
import {
  BundleDbSchema,
  BundleEnvelopeSchema,
  isSafeBundleMemberName,
  isUntravelledWorkspacePath,
  normalizeMemberName,
  toolContentHash,
} from './format.ts';

describe('isUntravelledWorkspacePath', () => {
  it('names the top-level cwd configuration the CLI would load', () => {
    for (const p of [
      '.claude',
      '.claude/settings.json',
      '.claude/skills/x/SKILL.md',
      '.mcp.json',
      'CLAUDE.local.md',
    ]) {
      expect(isUntravelledWorkspacePath(p), p).toBe(true);
    }
  });

  it('leaves the agent-authored rest alone, nested look-alikes included', () => {
    for (const p of [
      'notes.md',
      'docs/.claude/settings.json',
      'src/CLAUDE.local.md',
      'CLAUDE.md',
    ]) {
      expect(isUntravelledWorkspacePath(p), p).toBe(false);
    }
  });
});

// isSafeBundleMemberName is the security boundary: it runs over the archive
// listing before a single inode is created, so everything it lets through will
// be written to disk.

describe('normalizeMemberName', () => {
  it('absorbs the harmless bsdtar/GNU differences', () => {
    expect(normalizeMemberName('./workspace/a.txt')).toBe('workspace/a.txt');
    expect(normalizeMemberName('workspace/')).toBe('workspace');
    expect(normalizeMemberName('./')).toBe(null);
    expect(normalizeMemberName('.')).toBe(null);
  });
});

describe('isSafeBundleMemberName', () => {
  it('accepts the bundle layout', () => {
    for (const n of [
      'manifest.json',
      'db.json',
      'workspace',
      'workspace/notes.md',
      'workspace/docs/CLAUDE.md',
      'data/store/artifacts/x.bin',
      'data/sessions/shared/store.db',
      'data/sessions/3f2504e0-4f89-41d3-9a0c-0305e82c3301/store.db',
    ]) {
      expect(isSafeBundleMemberName(n), n).toBe(true);
    }
  });

  it('rejects traversal and absolute paths', () => {
    for (const n of [
      '../etc/passwd',
      'workspace/../../etc/passwd',
      '/etc/passwd',
      'C:/windows/system32',
      'workspace\\..\\evil',
      './',
    ]) {
      expect(isSafeBundleMemberName(n), n).toBe(false);
    }
  });

  it('rejects anything outside the known top-level entries', () => {
    expect(isSafeBundleMemberName('logs/run.ndjson')).toBe(false);
    expect(isSafeBundleMemberName('.ssh/authorized_keys')).toBe(false);
    expect(isSafeBundleMemberName('evil.sh')).toBe(false);
  });

  // A newline would split a `tar -t` line, letting a crafted archive smuggle a
  // second name past the listing check.
  it('rejects control characters in names', () => {
    expect(isSafeBundleMemberName('workspace/a\nb.txt')).toBe(false);
    expect(isSafeBundleMemberName('workspace/a\u0000b.txt')).toBe(false);
  });

  it('requires a session-store key to be "shared" or a uuid', () => {
    expect(isSafeBundleMemberName('data/sessions/shared/store.db')).toBe(true);
    expect(isSafeBundleMemberName('data/sessions/not-a-uuid/store.db')).toBe(false);
  });

  it('treats the payload files as files, not directories', () => {
    expect(isSafeBundleMemberName('manifest.json/evil')).toBe(false);
    expect(isSafeBundleMemberName('db.json/evil')).toBe(false);
  });
});

describe('toolContentHash', () => {
  const base = { interpreter: 'bash', source: 'echo hi' };

  it('is stable', () => {
    expect(toolContentHash(base)).toBe(toolContentHash({ ...base }));
  });

  // Documentation drift must not fail an import; only what runs counts.
  it('ignores name and description', () => {
    expect(toolContentHash({ ...base, name: 'x', description: 'y' } as never)).toBe(
      toolContentHash(base),
    );
  });

  it('changes when the interpreter or source changes', () => {
    expect(toolContentHash({ ...base, interpreter: 'node' })).not.toBe(toolContentHash(base));
    expect(toolContentHash({ ...base, source: 'echo bye' })).not.toBe(toolContentHash(base));
  });

  it('does not collide when the fields are concatenated ambiguously', () => {
    expect(toolContentHash({ interpreter: 'bash', source: 'x' })).not.toBe(
      toolContentHash({ interpreter: 'bash\nx', source: '' }),
    );
  });
});

describe('BundleEnvelopeSchema', () => {
  // The point of the loose envelope: a v1 helm must be able to read a v3 bundle
  // well enough to say "upgrade", rather than emitting validation noise.
  it('parses a future bundle it cannot otherwise understand', () => {
    const parsed = BundleEnvelopeSchema.safeParse({
      bundleVersion: 3,
      helmVersion: '9.9.9',
      somethingNew: { nested: true },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.bundleVersion).toBe(3);
  });

  it('rejects a non-bundle', () => {
    expect(BundleEnvelopeSchema.safeParse({ hello: 'world' }).success).toBe(false);
  });
});

const AGENT = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  name: 'Test',
  systemPrompt: 'hi',
  allowedTools: null,
  model: null,
  claudeSessionId: null,
  sessionScope: 'chat',
  sessionRecall: 'none',
  harness: null,
  createdAt: 1_700_000_000,
};
const EMPTY = {
  agent: AGENT,
  tools: [],
  agentToolIds: [],
  mcpServers: [],
  agentMcpServerIds: [],
  gateways: [],
  chats: [],
  heartbeats: [],
};

describe('BundleDbSchema', () => {
  it('accepts a minimal bundle', () => {
    expect(BundleDbSchema.safeParse(EMPTY).success).toBe(true);
  });

  // v2: the agent row is strict. A key this helm does not know might be one a
  // newer helm uses to change how the agent runs — refuse, never strip.
  it('rejects an unknown agent key instead of stripping it', () => {
    const bad = { ...EMPTY, agent: { ...AGENT, hooks: { PreToolUse: [] } } };
    expect(BundleDbSchema.safeParse(bad).success).toBe(false);
  });

  it('carries a harness profile and refuses one the daemon cannot run', () => {
    const ok = {
      ...EMPTY,
      agent: {
        ...AGENT,
        harness: { effort: 'high', permissionMode: 'dontAsk', maxTurns: 40, fallbackModel: null },
      },
    };
    expect(BundleDbSchema.safeParse(ok).success).toBe(true);
    const bypass = {
      ...EMPTY,
      agent: { ...AGENT, harness: { ...ok.agent.harness, permissionMode: 'bypassPermissions' } },
    };
    expect(BundleDbSchema.safeParse(bypass).success).toBe(false);
  });

  // Sessions cannot resume on another machine, so a bundle carrying one is
  // malformed rather than merely untidy.
  it('rejects a carried claude session id', () => {
    const bad = { ...EMPTY, agent: { ...AGENT, claudeSessionId: 'sess_123' } };
    expect(BundleDbSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an interpreter outside the allowlist', () => {
    const bad = {
      ...EMPTY,
      tools: [
        {
          id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
          name: 'evil',
          description: '',
          interpreter: 'ruby -e',
          source: 'x',
          contentHash: 'a'.repeat(64),
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    expect(BundleDbSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an agent_tools row pointing at a missing tool', () => {
    const bad = { ...EMPTY, agentToolIds: ['3f2504e0-4f89-41d3-9a0c-0305e82c3399'] };
    expect(BundleDbSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a 'chat' heartbeat with no chat id", () => {
    const bad = {
      ...EMPTY,
      heartbeats: [
        {
          id: '3f2504e0-4f89-41d3-9a0c-0305e82c3303',
          agentId: AGENT.id,
          name: 'hb',
          cron: '* * * * *',
          prompt: 'go',
          targetType: 'chat',
          targetChatId: null,
          enabled: true,
          lastRunAt: null,
          createdAt: 1,
        },
      ],
    };
    expect(BundleDbSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects rows belonging to a different agent', () => {
    const bad = {
      ...EMPTY,
      gateways: [
        {
          id: '3f2504e0-4f89-41d3-9a0c-0305e82c3304',
          agentId: '3f2504e0-4f89-41d3-9a0c-0305e82c3399',
          type: 'telegram',
          token: 't',
          pollOffset: 0,
          enabled: true,
          createdAt: 1,
        },
      ],
    };
    expect(BundleDbSchema.safeParse(bad).success).toBe(false);
  });
});

describe('BundleDbSchema — mcp servers (v3)', () => {
  const MCP_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3311';
  const config = {
    transport: 'stdio' as const,
    command: 'npx' as const,
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    env: { TOKEN: 'secret' },
  };
  const server = {
    id: MCP_ID,
    name: 'fetch',
    description: 'fetches',
    config,
    requires: ['npx' as const],
    contentHash: mcpContentHash({ config, requires: ['npx'] }),
    createdAt: 1,
    updatedAt: 1,
  };

  it('accepts a server and its join', () => {
    const ok = { ...EMPTY, mcpServers: [server], agentMcpServerIds: [MCP_ID] };
    expect(BundleDbSchema.safeParse(ok).success).toBe(true);
  });

  it('refuses a join that names a server the bundle does not carry', () => {
    const bad = { ...EMPTY, agentMcpServerIds: [MCP_ID] };
    expect(BundleDbSchema.safeParse(bad).success).toBe(false);
  });

  it('refuses two servers with one name — the mcp.json key', () => {
    const other = { ...server, id: '3f2504e0-4f89-41d3-9a0c-0305e82c3312' };
    expect(BundleDbSchema.safeParse({ ...EMPTY, mcpServers: [server, other] }).success).toBe(false);
  });

  it('constrains the command to the runtime enum: a bundle picks a runtime, never a binary', () => {
    const bad = { ...server, config: { ...config, command: '/bin/sh' } };
    expect(BundleDbSchema.safeParse({ ...EMPTY, mcpServers: [bad] }).success).toBe(false);
  });

  it('is strict about config keys the CLI would honour but helm does not render', () => {
    const bad = { ...server, config: { ...config, cwd: '/' } };
    expect(BundleDbSchema.safeParse({ ...EMPTY, mcpServers: [bad] }).success).toBe(false);
  });

  it('refuses a name that could not be an mcp.json key or an mcp__ prefix', () => {
    const bad = { ...server, name: '../x' };
    expect(BundleDbSchema.safeParse({ ...EMPTY, mcpServers: [bad] }).success).toBe(false);
  });
});
