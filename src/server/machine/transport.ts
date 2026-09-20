import { spawn } from 'node:child_process';

// How helm runs a script on a machine — this one, or a remote over the system
// ssh. Two channels exist on purpose: HTTP through the tunnel answers questions
// (facts, probes, status); this changes things (recipes, upgrade, restart, a box
// with no daemon yet). The script travels on stdin (`bash -s -- <args>`), so
// nothing is copied to the remote and nothing depends on the remote checkout.
//
// Nothing here is reachable from an HTTP handler with caller-supplied argv.
// `helm remote exec` spawns ssh from the CLI process itself; the server only
// ever runs registered recipes with regex-validated arguments (P2).

export interface ExecResult {
  code: number | null;
  /** Last TAIL_LINES lines of each stream. */
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutMs: number;
  /** Streamed lines, for a live log. */
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export interface Transport {
  readonly label: string;
  /** Run `script` under `bash -s -- args…`, script on stdin. Never throws for a non-zero exit. */
  exec(script: string, args: string[], opts: ExecOptions): Promise<ExecResult>;
}

/** The subset of a remotes row the ssh layer needs (also what tunnel.ts uses). */
export interface SshTarget {
  sshTarget: string;
  sshIdentityFile?: string | null;
}

/**
 * `user@host[:port]` — what addRemote accepts on the manual path. A destination
 * is the last ssh argv and follows `--`, but a value like `-oProxyCommand=…`
 * must still be impossible to store, so the shape is checked at the write.
 * A bare ssh-config alias (`my-vps`) is allowed: it is what the connect-code
 * path never produces but an operator's ~/.ssh/config legitimately might.
 */
export const SSH_TARGET_RE = /^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+(:\d{1,5})?$/;

const TAIL_LINES = 40;

/** Split 'user@host[:port]' into the ssh destination and an optional -p port. */
export function parseSshTarget(sshTarget: string): { destination: string; port?: number } {
  const m = /^(.+):(\d+)$/.exec(sshTarget);
  if (m) return { destination: m[1], port: Number(m[2]) };
  return { destination: sshTarget };
}

/**
 * The ssh options every helm connection uses — the tunnel and exec alike —
 * WITHOUT the destination, so callers can add `-N -L …` or a command. Pure.
 */
export function sshBaseArgs(remote: SshTarget): string[] {
  const { port } = parseSshTarget(remote.sshTarget);
  const args = [
    // Fail fast on auth problems instead of hanging on a password prompt.
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    // Detect a dead connection within ~30s so stale sessions don't linger.
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
  ];
  if (remote.sshIdentityFile) {
    // IdentitiesOnly: a saved key means *this* key, not whatever the agent
    // offers first (which is how a 'too many authentication failures' happens).
    args.push('-i', remote.sshIdentityFile, '-o', 'IdentitiesOnly=yes');
  }
  if (port) args.push('-p', String(port));
  return args;
}

/** POSIX single-quote wrap: safe for any string, including quotes and `$`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The remote command for `bash -s` with quoted positional args. */
export function bashStdinCommand(args: string[]): string {
  return ['bash', '-s', '--', ...args.map(shellQuote)].join(' ');
}

function tail(lines: string[]): string {
  return lines.slice(-TAIL_LINES).join('\n');
}

function run(file: string, argv: string[], script: string, opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    // Own process group: a timeout must take the script's children with it
    // (`sleep`, `apt-get`, an npm child) — otherwise they keep the pipes open
    // and `close` never fires. Same rule as the adapter's claude spawn.
    const proc = spawn(file, argv, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (proc.pid) process.kill(-proc.pid, sig);
        else proc.kill(sig);
      } catch {
        try {
          proc.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;
    const collect = (stream: 'stdout' | 'stderr', into: string[]) => {
      let buf = '';
      return (chunk: Buffer) => {
        buf += chunk.toString();
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const line of parts) {
          into.push(line);
          if (into.length > TAIL_LINES * 4) into.splice(0, into.length - TAIL_LINES * 2);
          opts.onLine?.(stream, line);
        }
      };
    };
    proc.stdout.on('data', collect('stdout', out));
    proc.stderr.on('data', collect('stderr', err));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5_000).unref?.();
    }, opts.timeoutMs);
    proc.on('error', (e) => {
      err.push(String(e));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdoutTail: tail(out), stderrTail: tail(err), timedOut });
    });
    proc.stdin.on('error', () => {
      /* the child exited before reading the script — reported via close */
    });
    proc.stdin.end(script);
  });
}

/** This machine: `bash -s -- args…`, argv passed directly (no quoting needed). */
export function localTransport(): Transport {
  return {
    label: 'local',
    exec: (script, args, opts) => run('bash', ['-s', '--', ...args], script, opts),
  };
}

/** A remote over the system ssh. The remote command is a quoted `bash -s -- args…`. */
export function sshTransport(remote: SshTarget): Transport {
  const { destination } = parseSshTarget(remote.sshTarget);
  return {
    label: `ssh ${remote.sshTarget}`,
    exec: (script, args, opts) =>
      run('ssh', [...sshBaseArgs(remote), '--', destination, bashStdinCommand(args)], script, opts),
  };
}
