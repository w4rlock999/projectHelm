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

export interface RemoteCallOpts {
  method?: string;
  path: string;
  body?: BodyInit;
  headers?: Record<string, string>;
  /**
   * Hard ceiling on the whole call. Right for a handshake, wrong for a
   * transfer: omit it for uploads and rely on `stallMs` instead, so a healthy
   * 20-minute push over a slow link succeeds while a dead one still dies fast.
   */
  timeoutMs?: number;
  /**
   * Abort if the response has not begun within this long. Paired with ssh's own
   * ServerAliveInterval/CountMax (set in tunnel.ts), which drops the tunnel
   * within ~30s of a dead link and makes the fetch error out on its own.
   */
  stallMs?: number;
  signal?: AbortSignal;
  /** Streaming bodies require this on undici. */
  duplex?: 'half';
}

/**
 * One authenticated request to a remote daemon through its SSH tunnel, with the
 * failure taxonomy applied. Every remote call should go through here so timeout
 * policy is per-call rather than a magic literal.
 */
export async function remoteFetch(
  remote: TunnelTarget & { token: string },
  o: RemoteCallOpts,
): Promise<Response> {
  try {
    return await withTunnel(remote, async (localPort) => {
      const signals: AbortSignal[] = [];
      if (o.signal) signals.push(o.signal);
      if (o.timeoutMs) signals.push(AbortSignal.timeout(o.timeoutMs));
      else if (o.stallMs) signals.push(AbortSignal.timeout(o.stallMs));

      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${localPort}${o.path}`, {
          method: o.method ?? 'GET',
          headers: { authorization: `Bearer ${remote.token}`, ...(o.headers ?? {}) },
          body: o.body,
          signal: signals.length ? AbortSignal.any(signals) : undefined,
          // @ts-expect-error — undici-only, required for a stream body.
          duplex: o.duplex,
        });
      } catch (err) {
        throw new RemoteError(
          'unreachable',
          `helm daemon not responding on the remote (port ${remote.helmPort}): ${String(err)}`,
        );
      }
      if (res.status === 401) {
        throw new RemoteError('auth', 'remote rejected the pairing token (401) — was it rotated?');
      }
      if (res.status === 403) {
        throw new RemoteError(
          'auth',
          'remote refused: this operation needs the pairing token, not an agent token',
        );
      }
      return res;
    });
  } catch (err) {
    if (err instanceof RemoteError) throw err;
    throw new RemoteError('ssh', err instanceof Error ? err.message : String(err));
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
  const res = await remoteFetch(remote, { path: '/api/remote/info', timeoutMs: 10_000 });
  if (!res.ok) throw new RemoteError('http', `remote returned HTTP ${res.status}`);

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
}

/** Pause or resume a remote daemon (operator-only on the far side). */
export async function setRemotePaused(
  remote: TunnelTarget & { token: string },
  paused: boolean,
  reason?: string,
): Promise<{ paused: boolean; since: string | null; reason: string | null }> {
  const res = await remoteFetch(remote, {
    method: 'POST',
    path: paused ? '/api/remote/pause' : '/api/remote/resume',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reason ? { reason } : {}),
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new RemoteError('http', `remote returned HTTP ${res.status}`);
  return (await res.json()) as { paused: boolean; since: string | null; reason: string | null };
}
