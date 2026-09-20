import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  effectiveRequires,
  LibraryNameSchema,
  McpServerConfigSchema,
  McpServerInputSchema,
  mcpContentHash,
  missingRuntimes,
  REDACTED,
  redactMcpConfig,
  resolveRedacted,
  scrubSecrets,
  toClaudeMcpEntry,
  type McpServerConfig,
} from './mcp-schema.ts';

const stdio: McpServerConfig = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-fetch'],
  env: { API_KEY: 'sk-live-123456' },
};
const http: McpServerConfig = {
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  headers: { Authorization: 'Bearer abcdef' },
};

describe('LibraryNameSchema', () => {
  it('accepts what mcp.json and an mcp__ prefix can carry', () => {
    for (const n of ['fetch', 'my-server', 'a_b', 'x1', 'a'.repeat(64)]) {
      expect(LibraryNameSchema.safeParse(n).success, n).toBe(true);
    }
  });
  it('rejects paths, case, spaces and overlength', () => {
    for (const n of ['../x', 'Fetch', 'my server', '-lead', '', 'a'.repeat(65)]) {
      expect(LibraryNameSchema.safeParse(n).success, n).toBe(false);
    }
  });
});

describe('McpServerConfigSchema', () => {
  it('constrains a stdio command to the runtime enum', () => {
    expect(McpServerConfigSchema.safeParse({ ...stdio, command: 'bash' }).success).toBe(false);
    expect(McpServerConfigSchema.safeParse({ ...stdio, command: '/usr/bin/env' }).success).toBe(
      false,
    );
    expect(McpServerConfigSchema.safeParse({ ...stdio, command: 'uvx' }).success).toBe(true);
  });
  it('is strict on both branches', () => {
    expect(McpServerConfigSchema.safeParse({ ...stdio, cwd: '/' }).success).toBe(false);
    expect(McpServerConfigSchema.safeParse({ ...http, command: 'npx' }).success).toBe(false);
  });
  it('requires UPPER_SNAKE env keys and a real URL', () => {
    expect(McpServerConfigSchema.safeParse({ ...stdio, env: { 'bad key': 'x' } }).success).toBe(
      false,
    );
    expect(McpServerConfigSchema.safeParse({ ...http, url: 'not a url' }).success).toBe(false);
  });
  it('defaults args/env/headers so a minimal input parses', () => {
    const p = McpServerConfigSchema.parse({ transport: 'stdio', command: 'node' });
    expect(p).toEqual({ transport: 'stdio', command: 'node', args: [], env: {} });
  });
});

describe('effectiveRequires', () => {
  it('always includes the stdio command, sorted and de-duplicated', () => {
    expect(effectiveRequires(stdio, ['uvx', 'npx'])).toEqual(['npx', 'uvx']);
    expect(effectiveRequires(stdio)).toEqual(['npx']);
    expect(effectiveRequires(http)).toEqual([]);
  });
  it('is applied by the input schema default', () => {
    const p = McpServerInputSchema.parse({ name: 'f', description: 'd', config: stdio });
    expect(effectiveRequires(p.config, p.requires)).toEqual(['npx']);
  });
});

describe('mcpContentHash', () => {
  it('is stable across key order', () => {
    const a = { config: stdio, requires: ['npx' as const] };
    const b = {
      config: { env: stdio.env, args: stdio.args, command: 'npx', transport: 'stdio' } as const,
      requires: ['npx' as const],
    };
    expect(mcpContentHash(a)).toBe(mcpContentHash(b));
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('changes with a secret: a different token is a different server', () => {
    const other = { ...stdio, env: { API_KEY: 'sk-live-other' } };
    expect(mcpContentHash({ config: other, requires: ['npx'] })).not.toBe(
      mcpContentHash({ config: stdio, requires: ['npx'] }),
    );
  });
  it('changes with requires', () => {
    expect(mcpContentHash({ config: stdio, requires: ['npx', 'uvx'] })).not.toBe(
      mcpContentHash({ config: stdio, requires: ['npx'] }),
    );
  });
});

describe('redaction', () => {
  it('replaces every env/header value and nothing else', () => {
    expect(redactMcpConfig(stdio)).toEqual({ ...stdio, env: { API_KEY: REDACTED } });
    expect(redactMcpConfig(http)).toEqual({ ...http, headers: { Authorization: REDACTED } });
  });
  it('resolves a marker to the stored value and keeps a typed-over value', () => {
    const incoming: McpServerConfig = {
      ...stdio,
      env: { API_KEY: REDACTED, NEW: 'plain' },
    };
    expect(resolveRedacted(incoming, stdio)).toEqual({
      ...stdio,
      env: { API_KEY: 'sk-live-123456', NEW: 'plain' },
    });
  });
  it('refuses a marker with nothing stored behind it', () => {
    expect(() => resolveRedacted({ ...stdio, env: { API_KEY: REDACTED } }, null)).toThrow(
      /no value is stored/,
    );
    // A transport switch has nothing to carry over either.
    expect(() => resolveRedacted({ ...http, headers: { Authorization: REDACTED } }, stdio)).toThrow(
      /no value is stored/,
    );
  });
  it('scrubs secret values out of captured text', () => {
    expect(scrubSecrets('error: sk-live-123456 rejected', ['sk-live-123456'])).toBe(
      'error: <redacted> rejected',
    );
  });
});

describe('toClaudeMcpEntry', () => {
  it('emits the CLI shape and omits empty env/headers', () => {
    expect(toClaudeMcpEntry(stdio)).toEqual({
      type: 'stdio',
      command: 'npx',
      args: stdio.args,
      env: stdio.env,
    });
    expect(toClaudeMcpEntry({ ...http, headers: {} })).toEqual({ type: 'http', url: http.url });
  });
});

describe('missingRuntimes', () => {
  it('names what the machine lacks', () => {
    const have = { node: '22.0.0', python3: null, npx: true, uvx: false };
    expect(missingRuntimes(['node', 'npx', 'python3', 'uvx'], have)).toEqual(['python3', 'uvx']);
    expect(missingRuntimes([], have)).toEqual([]);
  });
});
