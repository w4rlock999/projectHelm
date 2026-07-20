import { z } from 'zod';

// The one-line pairing string printed by `pnpm remote:init` and pasted into
// the local console: `helm-connect:` + base64url JSON. Versioned so a future
// shape change fails decode loudly instead of mis-parsing.

export const CONNECT_CODE_PREFIX = 'helm-connect:';

export const ConnectCodeSchema = z.object({
  v: z.literal(1),
  sshUser: z.string().min(1),
  host: z.string().min(1),
  sshPort: z.number().int().positive(),
  helmPort: z.number().int().positive(),
  token: z.string().min(1),
});
export type ConnectCodeV1 = z.infer<typeof ConnectCodeSchema>;

export function encodeConnectCode(code: ConnectCodeV1): string {
  return CONNECT_CODE_PREFIX + Buffer.from(JSON.stringify(code)).toString('base64url');
}

export function decodeConnectCode(input: string): ConnectCodeV1 {
  const trimmed = input.trim();
  if (!trimmed.startsWith(CONNECT_CODE_PREFIX)) {
    throw new Error(`connect code must start with "${CONNECT_CODE_PREFIX}"`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(trimmed.slice(CONNECT_CODE_PREFIX.length), 'base64url').toString('utf8'),
    );
  } catch {
    throw new Error('connect code payload is not valid base64url JSON');
  }
  const result = ConnectCodeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('connect code has an unsupported version or unexpected shape');
  }
  return result.data;
}
