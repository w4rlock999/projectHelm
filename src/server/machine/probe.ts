import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import { paths } from '../paths.ts';

// What this machine is and what it has — the observed side of every machine
// parity comparison. Pure probing: no database, and nothing here throws on a
// missing binary (a probe that fails is a fact, not an error).
//
// Every probe runs with `machineEnv()`. In P0 that is process.env; P1 prepends
// helm's own prefix (.helm/machine/venv/bin, .helm/node_modules/.bin) so the
// probe sees exactly what a spawned agent sees.

const execFileAsync = promisify(execFile);

/** The env every probe (and, from P1, every spawned agent) runs under. */
export function machineEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  return out;
}

/** First version-looking token of `<bin> <args>` stdout, or null when it cannot run. */
export async function versionOf(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 5_000, env: machineEnv() });
    return (/\d+[^\s]*/.exec(stdout.trim())?.[0] ?? stdout.trim()) || null;
  } catch {
    return null;
  }
}

/** Whether `bin` resolves on PATH. */
export async function onPath(bin: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      timeout: 5_000,
      env: machineEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of `bin` on PATH, or null. */
export async function pathOf(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      process.platform === 'win32' ? 'where' : 'which',
      [bin],
      {
        timeout: 5_000,
        env: machineEnv(),
      },
    );
    return stdout.trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

export const MachineFactsSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  /** From /etc/os-release on Linux (`ubuntu` 24.04, `debian` 12); absent elsewhere. */
  distro: z.object({ id: z.string(), version: z.string().nullable() }).optional(),
  /** Numeric uid the daemon runs as; -1 where the platform has none. */
  uid: z.number().int(),
  root: z.boolean(),
  /** `sudo -n true` succeeded. False when sudo is absent or would prompt. */
  sudo: z.boolean(),
  /** The daemon's cwd — the app dir recipes `cd` into, and the parent of `.helm`. */
  appDir: z.string(),
  /** Absolute node binary the daemon itself runs on. */
  nodeBin: z.string(),
  /** Absolute pnpm on the daemon's PATH, or null (recipes cannot assume a login shell). */
  pnpmBin: z.string().nullable(),
  /** Whether helm's own prefixes exist (P1 fills them; P0 reports them absent). */
  prefixes: z.object({
    venv: z.boolean(),
    npmModules: z.boolean(),
    browsers: z.array(z.string()),
  }),
});
export type MachineFacts = z.infer<typeof MachineFactsSchema>;

function readOsRelease(): MachineFacts['distro'] {
  if (process.platform !== 'linux') return undefined;
  try {
    const text = readFileSync('/etc/os-release', 'utf8');
    const get = (k: string) => new RegExp(`^${k}=("?)(.*?)\\1$`, 'm').exec(text)?.[2] ?? null;
    const id = get('ID');
    if (!id) return undefined;
    return { id, version: get('VERSION_ID') };
  } catch {
    return undefined;
  }
}

async function probeSudo(root: boolean): Promise<boolean> {
  if (root) return true;
  try {
    await execFileAsync('sudo', ['-n', 'true'], { timeout: 5_000, env: machineEnv() });
    return true;
  } catch {
    return false;
  }
}

function currentUid(): number {
  try {
    return typeof process.getuid === 'function' ? process.getuid() : -1;
  } catch {
    return -1;
  }
}

async function probeMachine(): Promise<MachineFacts> {
  const uid = currentUid();
  const root = uid === 0;
  const [sudo, pnpmBin] = await Promise.all([probeSudo(root), pathOf('pnpm')]);
  return {
    platform: process.platform,
    arch: process.arch,
    distro: readOsRelease(),
    uid,
    root,
    sudo,
    appDir: process.cwd(),
    nodeBin: process.execPath,
    pnpmBin,
    prefixes: {
      venv: existsSync(`${paths.helmRoot}/machine/venv/bin`),
      npmModules: existsSync(`${paths.helmRoot}/node_modules`),
      browsers: [],
    },
  };
}

// Memoized with a TTL like the claude probe: facts change when someone
// provisions, not per request. `clearMachineProbe()` is called when a provision
// run finishes so the next check is fresh, and by tests.
const PROBE_TTL_MS = 60_000;
let facts: { at: number; value: Promise<MachineFacts> } | undefined;

export function machineFacts(): Promise<MachineFacts> {
  const now = Date.now();
  if (!facts || now - facts.at > PROBE_TTL_MS) facts = { at: now, value: probeMachine() };
  return facts.value;
}

/** Forget the memoized facts so the next call re-probes. */
export function clearMachineProbe(): void {
  facts = undefined;
}

/** Hostname, for the check report's "user" row and the ops log header. */
export function machineLabel(): string {
  return `${os.hostname()} (${process.platform}/${process.arch})`;
}
