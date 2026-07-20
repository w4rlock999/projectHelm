import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { agents } from '../db/schema.ts';
import { HELM_VERSION } from '../version.ts';
import { config } from './config.ts';
import { readRemoteJson } from './remote-auth.ts';

// The pairing handshake payload served at GET /api/remote/info. The local
// helm validates responses against this same schema (the version/shape
// assertion at the seam — skew fails loudly, not mysteriously).

export const HarnessInfoSchema = z.object({
  type: z.string(),
  version: z.string().nullable(),
  authOk: z.boolean(),
});
export type HarnessInfo = z.infer<typeof HarnessInfoSchema>;

export const RemoteInfoSchema = z.object({
  helmVersion: z.string(),
  headless: z.boolean(),
  harnesses: z.array(HarnessInfoSchema),
  agentCount: z.number(),
  uptimeSec: z.number(),
});
export type RemoteInfo = z.infer<typeof RemoteInfoSchema>;

const execFileAsync = promisify(execFile);

// Memoized per process: `claude --version` is stable for the daemon's
// lifetime, and the handshake must stay cheap (no child process per ping).
let claudeInfo: Promise<HarnessInfo> | undefined;

function claudeHarnessInfo(): Promise<HarnessInfo> {
  claudeInfo ??= (async () => {
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 15_000 });
      const version = /\d+[^\s]*/.exec(stdout.trim())?.[0] ?? null;
      // Headless: authed iff the OAuth token env is present and remote:init's
      // `claude -p ping` smoke test passed. Local: the CLI resolving at all
      // implies a usable keychain login.
      const authOk = config.headless
        ? Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) && readRemoteJson()?.smokeOk === true
        : true;
      return { type: 'claude-code', version, authOk };
    } catch {
      return { type: 'claude-code', version: null, authOk: false };
    }
  })();
  return claudeInfo;
}

export async function getRemoteInfo(): Promise<RemoteInfo> {
  const agentCount = db.select().from(agents).where(eq(agents.isOperator, false)).all().length;
  return {
    helmVersion: HELM_VERSION,
    headless: config.headless,
    harnesses: [await claudeHarnessInfo()],
    agentCount,
    uptimeSec: Math.floor(process.uptime()),
  };
}
