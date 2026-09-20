import { createHash } from 'node:crypto';
import { z } from 'zod';

// The MCP server library entry: what helm knows about a server so it can
// render it into an agent's isolated `--mcp-config` file (harness/render.ts)
// and grant `mcp__<name>` on the allow-list. Pure — no I/O, no database — so
// the bundle format, the routers and the tests share one definition.
//
// A server's `command` is argv of a model-free exec on whichever machine runs
// the agent, so it is constrained to a runtime enum exactly as tool shebangs
// are constrained to INTERPRETERS: a bundle can pick which *runtime* starts,
// never which binary.

export const RUNTIMES = ['node', 'npx', 'python3', 'uvx'] as const;
export type Runtime = (typeof RUNTIMES)[number];
export const RuntimeSchema = z.enum(RUNTIMES);

/**
 * A library name: also the key in mcp.json and the `mcp__<name>` prefix the
 * CLI gives the server's tools, so it is kept to the characters both accept.
 */
export const LIBRARY_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const LibraryNameSchema = z
  .string()
  .regex(LIBRARY_NAME_RE, 'name must be lowercase letters, digits, "-" or "_" (max 64)');

const EnvKey = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'env keys are UPPER_SNAKE_CASE');
const HeaderKey = z.string().regex(/^[A-Za-z0-9-]{1,100}$/, 'invalid header name');

/**
 * Strict on both branches: a key the CLI would honour but helm does not know
 * (e.g. `cwd`) must be refused rather than silently rendered into mcp.json.
 */
export const McpServerConfigSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('stdio'),
    command: RuntimeSchema,
    args: z.array(z.string().max(1000)).max(64).default([]),
    env: z.record(EnvKey, z.string().max(4000)).default({}),
  }),
  z.strictObject({
    transport: z.literal('http'),
    url: z.url(),
    headers: z.record(HeaderKey, z.string().max(4000)).default({}),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpServerInputSchema = z.object({
  name: LibraryNameSchema,
  description: z.string().trim().min(1).max(500),
  config: McpServerConfigSchema,
  /**
   * Runtimes the server needs on the machine. The stdio `command` is always
   * included by `effectiveRequires`; list more when the server shells out
   * (an `npx` package that spawns `python3`, say).
   */
  requires: z.array(RuntimeSchema).default([]),
});
export type McpServerInput = z.infer<typeof McpServerInputSchema>;

/** `requires` with the stdio command folded in, sorted and de-duplicated. */
export function effectiveRequires(config: McpServerConfig, requires: Runtime[] = []): Runtime[] {
  const set = new Set<Runtime>(requires);
  if (config.transport === 'stdio') set.add(config.command);
  return [...set].sort();
}

/**
 * Executable identity of a server, as `toolContentHash` is for a tool. Env
 * and headers are included on purpose: a different token is a different
 * server, and an import must not reuse a local entry whose credential differs.
 * `name` and `description` are excluded — documentation drift must not fail an
 * import.
 */
export function mcpContentHash(s: { config: McpServerConfig; requires: Runtime[] }): string {
  return createHash('sha256')
    .update(canonicalJson({ config: s.config, requires: [...s.requires].sort() }), 'utf8')
    .digest('hex');
}

/** JSON with object keys sorted at every level, so two equal values hash equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

// ── secrets ─────────────────────────────────────────────────────────────────

/**
 * What a read surface shows in place of an env or header value. Secrets are
 * plaintext at rest (same posture as `gateways.token`) and are rendered into
 * the 0600 mcp.json, but they never leave the daemon over an API, in CLI
 * output, or in a fingerprint.
 *
 * A write that carries this exact marker as a value means "keep what is
 * stored" — which is what lets a redacted read be edited and sent back.
 */
export const REDACTED = '<set>';

export type RedactedMcpServerConfig =
  | { transport: 'stdio'; command: Runtime; args: string[]; env: Record<string, string> }
  | { transport: 'http'; url: string; headers: Record<string, string> };

export function redactMcpConfig(config: McpServerConfig): RedactedMcpServerConfig {
  if (config.transport === 'stdio') {
    return {
      transport: 'stdio',
      command: config.command,
      args: config.args,
      env: Object.fromEntries(Object.keys(config.env).map((k) => [k, REDACTED])),
    };
  }
  return {
    transport: 'http',
    url: config.url,
    headers: Object.fromEntries(Object.keys(config.headers).map((k) => [k, REDACTED])),
  };
}

/**
 * Merge an incoming config over the stored one, resolving every `REDACTED`
 * value to the stored value of the same key. A marker for a key the stored
 * config does not have is an error: there is nothing to keep.
 */
export function resolveRedacted(
  incoming: McpServerConfig,
  stored: McpServerConfig | null,
): McpServerConfig {
  const fill = (next: Record<string, string>, prev: Record<string, string>, what: string) =>
    Object.fromEntries(
      Object.entries(next).map(([k, v]) => {
        if (v !== REDACTED) return [k, v];
        if (prev[k] === undefined) {
          throw new McpServerError(`${what} ${k} is "${REDACTED}" but no value is stored for it`);
        }
        return [k, prev[k]];
      }),
    );
  if (incoming.transport === 'stdio') {
    const prev = stored?.transport === 'stdio' ? stored.env : {};
    return { ...incoming, env: fill(incoming.env, prev, 'env') };
  }
  const prev = stored?.transport === 'http' ? stored.headers : {};
  return { ...incoming, headers: fill(incoming.headers, prev, 'header') };
}

/** The values that must never appear in an API response, log or stderr tail. */
export function mcpSecretValues(config: McpServerConfig): string[] {
  const vals = config.transport === 'stdio' ? config.env : config.headers;
  return Object.values(vals).filter((v) => v.length >= 6);
}

/** Replace every secret value in `text` (a stderr tail, say) before it is persisted. */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('<redacted>');
  return out;
}

// ── rendering ───────────────────────────────────────────────────────────────

/**
 * One entry of the `mcpServers` object Claude Code reads from `--mcp-config`.
 * Empty env/headers are omitted so the rendered file says only what is set.
 */
export function toClaudeMcpEntry(config: McpServerConfig): Record<string, unknown> {
  if (config.transport === 'stdio') {
    return {
      type: 'stdio',
      command: config.command,
      args: config.args,
      ...(Object.keys(config.env).length > 0 ? { env: config.env } : {}),
    };
  }
  return {
    type: 'http',
    url: config.url,
    ...(Object.keys(config.headers).length > 0 ? { headers: config.headers } : {}),
  };
}

/**
 * Thrown for an operator mistake at a write surface (a duplicate name, a
 * marker with nothing behind it). Callers turn it into a 400 / BAD_REQUEST.
 */
export class McpServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpServerError';
  }
}

/** Which of `required` this machine lacks, given a detected runtime set. */
export function missingRuntimes(
  required: Runtime[],
  have: { node: string | null; python3: string | null; npx: boolean; uvx: boolean },
): Runtime[] {
  return required.filter((r) => {
    if (r === 'node') return have.node === null;
    if (r === 'python3') return have.python3 === null;
    return have[r] !== true;
  });
}
