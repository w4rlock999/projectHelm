import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

// SSH tunnel manager: every remote operation goes through
// `ssh -N -L <ephemeralLocalPort>:127.0.0.1:<helmPort> <sshTarget>`. Using the
// system ssh (not a JS ssh lib) means the user's ~/.ssh/config, keys, and
// agent all just work, and we ship no native deps. Tunnels are opened on
// demand, shared between concurrent calls, kept alive ~60s idle, then reaped.
// Mirrors the gateway-poller registry pattern (runtime/gateways.ts):
// globalThis-keyed so HMR / repeated imports don't leak ssh processes.

const IDLE_TTL_MS = 60_000;
const REAP_INTERVAL_MS = 15_000;
const READY_TIMEOUT_MS = 10_000;

/** The subset of a `remotes` row the tunnel layer needs. */
export interface TunnelTarget {
  id: string;
  sshTarget: string;
  helmPort: number;
}

interface TunnelHandle {
  proc: ChildProcess | null;
  localPort: number;
  lastUsedAt: number;
  /** Resolves when the forwarded port accepts connections; rejects on ssh failure. */
  ready: Promise<void>;
  stderrTail: string[];
}

const tunnels: Map<string, TunnelHandle> =
  (globalThis as any).__helmTunnels ?? ((globalThis as any).__helmTunnels = new Map());

/** Split 'user@host[:port]' into the ssh destination and an optional -p port. */
export function parseSshTarget(sshTarget: string): { destination: string; port?: number } {
  const m = /^(.+):(\d+)$/.exec(sshTarget);
  if (m) return { destination: m[1], port: Number(m[2]) };
  return { destination: sshTarget };
}

/** Ask the OS for a free loopback port (tiny TOCTOU window — acceptable). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Retry-connect to the forwarded port until it accepts or the deadline passes. */
async function waitForPort(handle: TunnelHandle): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (handle.proc && handle.proc.exitCode !== null) {
      throw new Error(sshFailureMessage(handle));
    }
    const connected = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port: handle.localPort, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.end();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
    });
    if (connected) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(sshFailureMessage(handle, 'ssh tunnel did not come up within 10s'));
}

function sshFailureMessage(handle: TunnelHandle, prefix = 'ssh tunnel failed'): string {
  const tail = handle.stderrTail.join(' | ').trim();
  return tail ? `${prefix}: ${tail}` : prefix;
}

function openTunnel(remote: TunnelTarget): TunnelHandle {
  const handle: TunnelHandle = {
    proc: null,
    localPort: 0,
    lastUsedAt: Date.now(),
    ready: Promise.resolve(),
    stderrTail: [],
  };

  handle.ready = (async () => {
    handle.localPort = await freePort();
    const { destination, port: sshPort } = parseSshTarget(remote.sshTarget);
    const args = [
      '-N',
      // Fail fast on auth problems instead of hanging on a password prompt.
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ConnectTimeout=10',
      // Detect a dead connection within ~30s so stale tunnels don't linger.
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=2',
      '-L',
      `127.0.0.1:${handle.localPort}:127.0.0.1:${remote.helmPort}`,
      ...(sshPort ? ['-p', String(sshPort)] : []),
      destination,
    ];
    const proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    handle.proc = proc;
    proc.stderr?.on('data', (chunk: Buffer) => {
      // Keep only the last few lines — ssh stderr is noisy, and the tail is
      // what the console surfaces as the remote's error status.
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) handle.stderrTail.push(line.trim());
      }
      handle.stderrTail.splice(0, Math.max(0, handle.stderrTail.length - 5));
    });
    proc.on('close', () => {
      if (tunnels.get(remote.id) === handle) tunnels.delete(remote.id);
    });
    await waitForPort(handle);
  })();

  // Registered before `ready` resolves so concurrent calls share this attempt.
  tunnels.set(remote.id, handle);
  ensureReaper();
  return handle;
}

/**
 * Run `fn` against the local end of a live tunnel to `remote`, opening (or
 * reusing) one as needed. Errors from ssh surface with the stderr tail.
 */
export async function withTunnel<T>(
  remote: TunnelTarget,
  fn: (localPort: number) => Promise<T>,
): Promise<T> {
  let handle = tunnels.get(remote.id);
  if (!handle || (handle.proc && handle.proc.exitCode !== null)) {
    handle = openTunnel(remote);
  }
  handle.lastUsedAt = Date.now();
  try {
    await handle.ready;
  } catch (err) {
    // A failed attempt must not poison the registry — the next call retries.
    if (tunnels.get(remote.id) === handle) tunnels.delete(remote.id);
    throw err;
  }
  handle.lastUsedAt = Date.now();
  return fn(handle.localPort);
}

/** Kill the tunnel for a remote (e.g. when it's removed from the registry). */
export function teardownTunnel(remoteId: string): void {
  const handle = tunnels.get(remoteId);
  if (!handle) return;
  tunnels.delete(remoteId);
  handle.proc?.kill('SIGTERM');
}

function ensureReaper(): void {
  const g = globalThis as { __helmTunnelReaper?: ReturnType<typeof setInterval> };
  if (g.__helmTunnelReaper) return;
  g.__helmTunnelReaper = setInterval(() => {
    const now = Date.now();
    for (const [id, handle] of tunnels) {
      if (now - handle.lastUsedAt > IDLE_TTL_MS) {
        tunnels.delete(id);
        handle.proc?.kill('SIGTERM');
      }
    }
  }, REAP_INTERVAL_MS);
  // Never keep the process alive just to reap tunnels.
  g.__helmTunnelReaper.unref?.();
}
