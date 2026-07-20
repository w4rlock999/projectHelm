import { RemoteInfoSchema, type RemoteInfo } from '../remote-info.ts';
import { withTunnel, type TunnelTarget } from './tunnel.ts';

// HTTP client for a remote daemon, always through the SSH tunnel. Every
// failure is classified so the console can show a useful status instead of a
// bare stack trace.

export type RemoteErrorKind = 'ssh' | 'auth' | 'unreachable' | 'http' | 'protocol';

export class RemoteError extends Error {
  constructor(
    public readonly kind: RemoteErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

/**
 * The pairing handshake: GET /api/remote/info with the pairing token.
 * Validates the response against RemoteInfoSchema — shape skew (version
 * mismatch across the seam) fails loudly as kind 'protocol'.
 */
export async function fetchRemoteInfo(
  remote: TunnelTarget & { token: string },
): Promise<RemoteInfo> {
  let result: RemoteInfo;
  try {
    result = await withTunnel(remote, async (localPort) => {
      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${localPort}/api/remote/info`, {
          headers: { authorization: `Bearer ${remote.token}` },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        // Tunnel is up but nothing answers on the far side — daemon down.
        throw new RemoteError(
          'unreachable',
          `helm daemon not responding on the remote (port ${remote.helmPort}): ${String(err)}`,
        );
      }
      if (res.status === 401) {
        throw new RemoteError('auth', 'remote rejected the pairing token (401) — was it rotated?');
      }
      if (!res.ok) {
        throw new RemoteError('http', `remote returned HTTP ${res.status}`);
      }
      const body = await res.json().catch(() => {
        throw new RemoteError('protocol', 'remote returned non-JSON — not a helm daemon?');
      });
      const parsed = RemoteInfoSchema.safeParse(body);
      if (!parsed.success) {
        throw new RemoteError(
          'protocol',
          'remote info has an unexpected shape — helm version skew between local and remote?',
        );
      }
      return parsed.data;
    });
  } catch (err) {
    if (err instanceof RemoteError) throw err;
    // Anything the tunnel layer threw is an ssh-level failure.
    throw new RemoteError('ssh', err instanceof Error ? err.message : String(err));
  }
  return result;
}
