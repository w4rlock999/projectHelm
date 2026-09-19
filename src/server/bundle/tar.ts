import { spawn } from 'node:child_process';
import { openSync, readSync, closeSync, statSync, statfsSync } from 'node:fs';
import { BundleError, CAPS, isSafeBundleMemberName, normalizeMemberName } from './format.ts';

// The only place in the codebase that spawns `tar`.
//
// We shell out rather than add a JS tar library, matching the same call the
// tunnel layer makes about `ssh`: the system binary is battle-tested, works with
// whatever the OS provides, and ships no native deps. It also keeps extraction
// validation in TypeScript where it is testable, rather than trusting a
// library's own path handling (the class of bug that has repeatedly produced
// path-traversal CVEs in JS tar extractors).
//
// The archive is always built from a *staging mirror*, never from the live tree.
// That is what lets every invocation use one trivially portable argv: no
// --exclude (the biggest bsdtar/GNU divergence — pattern anchoring and operand
// ordering differ), no -T/--files-from, no --transform. Every include/exclude
// decision lives in a walk function in fs.ts instead.

const TAR_TIMEOUT_MS = 10 * 60_000;

/**
 * Flags used below and safe on both bsdtar and GNU tar:
 *   -c / -x / -t   POSIX
 *   -z             universal
 *   -f <path>      POSIX; always a real file, never `-`
 *   -C <dir>       POSIX; single occurrence, before the operand
 *   --no-same-owner  present in both; matters when the daemon runs as root
 * Nothing outside that intersection is used.
 */
function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      // COPYFILE_DISABLE stops Apple's bsdtar emitting an AppleDouble `._name`
      // sidecar beside every member whose file carries extended attributes —
      // which, on macOS, is most of them, the staging directory included. Those
      // names are not in the bundle's top-level allowlist, so a remote rejects
      // the archive outright: shipping from any Mac died at the far end with
      // `unsafe member name: "._."`. Set for every tar call rather than guarded
      // by platform, because it is inert everywhere else.
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const stderr: string[] = [];
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) stderr.push(line.trim());
      }
      stderr.splice(0, Math.max(0, stderr.length - 5));
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new BundleError('tar', `tar timed out after ${TAR_TIMEOUT_MS / 1000}s`));
    }, TAR_TIMEOUT_MS);

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new BundleError(
          'tar',
          err.code === 'ENOENT'
            ? 'tar not found on PATH — helm requires a system tar to ship or receive agents'
            : `tar failed to start: ${err.message}`,
        ),
      );
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const tail = stderr.join(' | ');
      reject(new BundleError('tar', `tar exited ${code}${tail ? `: ${tail}` : ''}`));
    });
  });
}

/** Archive the *contents* of `stageDir` into `outFile`. */
export async function createTarball(stageDir: string, outFile: string): Promise<void> {
  await runTar(['-c', '-z', '-f', outFile, '-C', stageDir, '.']);
}

/**
 * List an archive's members without extracting. This is the first of two safety
 * belts: it runs before a single inode is created, so `../../etc/cron.d/x` or an
 * absolute path never reaches the filesystem.
 */
export async function listTarball(file: string): Promise<string[]> {
  const names: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('tar', ['-t', '-f', file, '-z'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: string[] = [];
    let buf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) names.push(l);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) stderr.push(line.trim());
      }
      stderr.splice(0, Math.max(0, stderr.length - 5));
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new BundleError('tar', 'tar -t timed out'));
    }, TAR_TIMEOUT_MS);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new BundleError('tar', `tar failed to start: ${String(err)}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) names.push(buf);
      if (code === 0) return resolve();
      reject(new BundleError('tar', `tar -t exited ${code}: ${stderr.join(' | ')}`));
    });
  });
  return names;
}

/** Extract into `destDir`, which must already exist and be a quarantine dir. */
export async function extractTarball(file: string, destDir: string): Promise<void> {
  await runTar(['-x', '-z', '-f', file, '-C', destDir, '--no-same-owner']);
}

/**
 * Cheap pre-extraction guards against a gzip bomb.
 *
 * The ISIZE trailer is mod 2^32, so this is a filter rather than a proof — the
 * post-extraction byte sum in fs.ts is the real ceiling. Its value here is
 * stopping an obvious bomb from filling the VPS disk before that sum can be
 * computed.
 */
export function assertGzipSane(file: string, helmRoot: string): void {
  const size = statSync(file).size;
  if (size > CAPS.maxCompressedBytes) {
    throw new BundleError('too-large', `bundle is ${size} bytes, over the transfer cap`);
  }
  if (size < 18) throw new BundleError('malformed', 'bundle is too small to be a gzip archive');

  const fd = openSync(file, 'r');
  try {
    const magic = Buffer.alloc(2);
    readSync(fd, magic, 0, 2, 0);
    if (magic[0] !== 0x1f || magic[1] !== 0x8b) {
      throw new BundleError('malformed', 'bundle is not a gzip archive');
    }
    const trailer = Buffer.alloc(4);
    readSync(fd, trailer, 0, 4, size - 4);
    const isize = trailer.readUInt32LE(0);
    if (isize > CAPS.maxUncompressedBytes) {
      throw new BundleError(
        'too-large',
        `bundle expands to ~${Math.round(isize / 1e6)}MB, over the cap`,
      );
    }
    try {
      const fsStat = statfsSync(helmRoot);
      const free = fsStat.bavail * fsStat.bsize;
      // 3x: the archive, the extracted tree, and the installed copy.
      if (free < isize * 3) {
        throw new BundleError(
          'too-large',
          `not enough free disk to unpack this bundle (~${Math.round(isize / 1e6)}MB needs ${Math.round((isize * 3) / 1e6)}MB free)`,
        );
      }
    } catch (err) {
      if (err instanceof BundleError) throw err;
      // statfs is unavailable on some platforms; the byte-sum cap still applies.
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Validate an archive's listing. Returns the normalized member names.
 * Throws before anything is extracted if any name is unsafe.
 */
export function validateMemberNames(rawNames: string[]): string[] {
  const names: string[] = [];
  for (const raw of rawNames) {
    const n = normalizeMemberName(raw);
    if (n === null) continue;
    if (!isSafeBundleMemberName(n)) {
      throw new BundleError(
        'unsafe-path',
        `bundle contains an unsafe member name: ${JSON.stringify(n)}`,
      );
    }
    names.push(n);
  }
  if (names.length > CAPS.maxMembers) {
    throw new BundleError('too-large', `bundle has ${names.length} members, over the cap`);
  }
  for (const required of ['manifest.json', 'db.json']) {
    if (!names.includes(required)) {
      throw new BundleError('malformed', `bundle is missing ${required}`);
    }
  }
  return names;
}
