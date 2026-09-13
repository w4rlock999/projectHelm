import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { BundleError, CAPS } from './format.ts';

// Filesystem half of the bundle: building the staging mirror, and validating a
// tree that came out of an untrusted archive.

export interface StageCounts {
  files: number;
  bytes: number;
}

/** Decide whether a source path is included, given its path relative to the root. */
export type StageFilter = (relPath: string, entry: { isDir: boolean }) => boolean;

/**
 * Mirror `srcDir` into `destDir`, applying `filter`.
 *
 * Files are hardlinked where possible and copied otherwise, which is why
 * staging a large data plane costs essentially nothing — and why the staging
 * directory has to live under `.helm/` (a hardlink cannot cross filesystems).
 *
 * Note the consequence: a staged file IS the live file, so a concurrently
 * running agent could mutate it between staging and archiving. In the ship flow
 * the agent is already deactivated, which closes that window.
 */
export function stageTree(
  srcDir: string,
  destDir: string,
  filter: StageFilter,
  warnings: string[],
): StageCounts {
  const counts: StageCounts = { files: 0, bytes: 0 };
  if (!existsSync(srcDir)) return counts;

  const walk = (rel: string) => {
    const abs = rel ? path.join(srcDir, rel) : srcDir;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;

      // Skip anything that isn't a plain file or directory. A symlink in a
      // bundle has no legitimate use and is the write-through primitive an
      // attacker wants, so exclude it at the source too, not just on import.
      if (entry.isSymbolicLink()) {
        warnings.push(`skipped symlink ${childRel}`);
        continue;
      }
      if (!entry.isDirectory() && !entry.isFile()) {
        warnings.push(`skipped non-regular file ${childRel}`);
        continue;
      }
      // A control character in a filename would break the `tar -t` line
      // protocol the import side relies on.
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(entry.name)) {
        warnings.push(`skipped file with a control character in its name: ${childRel}`);
        continue;
      }

      if (!filter(childRel, { isDir: entry.isDirectory() })) continue;

      if (entry.isDirectory()) {
        mkdirSync(path.join(destDir, childRel), { recursive: true });
        walk(childRel);
        continue;
      }

      const srcPath = path.join(srcDir, childRel);
      const size = lstatSync(srcPath).size;
      counts.files++;
      counts.bytes += size;
      if (counts.bytes > CAPS.maxUncompressedBytes) {
        throw new BundleError(
          'too-large',
          `bundle would exceed ${Math.round(CAPS.maxUncompressedBytes / 1e6)}MB — ` +
            `retry with --without-data`,
        );
      }

      const destPath = path.join(destDir, childRel);
      mkdirSync(path.dirname(destPath), { recursive: true });
      try {
        linkSync(srcPath, destPath);
      } catch {
        // EXDEV / EPERM — fall back to a copy.
        copyFileSync(srcPath, destPath);
      }
    }
  };
  mkdirSync(destDir, { recursive: true });
  walk('');
  return counts;
}

/**
 * Second safety belt: walk an extracted tree and reject anything the archive
 * listing could not rule out.
 *
 * The listing check (tar.ts) protects against bad *names*; this protects against
 * bad *inodes*, which a name cannot express. bsdtar and GNU tar disagree about
 * how aggressively they block symlink and hardlink entries, so we rely on
 * neither and check ourselves.
 */
export function validateExtractedTree(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      const st = lstatSync(abs);

      if (st.isSymbolicLink()) {
        throw new BundleError('unsafe-path', `bundle contains a symlink (${rel}) — refusing`);
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile()) {
        throw new BundleError(
          'unsafe-path',
          `bundle contains a non-regular file (${rel}) — refusing`,
        );
      }
      // A hardlink entry pointing outside the tree is the other classic tar
      // escape. Bundles never contain hardlinks by construction.
      if (st.nlink !== 1) {
        throw new BundleError('unsafe-path', `bundle contains a hardlinked file (${rel})`);
      }
      if (st.size > CAPS.maxSingleFileBytes) {
        throw new BundleError('too-large', `bundle file ${rel} is over the single-file cap`);
      }
      files++;
      bytes += st.size;
      if (bytes > CAPS.maxUncompressedBytes) {
        throw new BundleError('too-large', 'bundle expands past the uncompressed cap');
      }
    }
  };
  walk(root);
  return { files, bytes };
}

/**
 * Normalize modes rather than trusting the archive's. Nothing in a bundle is
 * legitimately executable: `workspace/tools/` is re-materialized (and chmod
 * 755'd) by tools.ts on import, and an executable bit on a data-plane artifact
 * is only ever a liability.
 */
export function normalizeModes(root: string): void {
  const walk = (dir: string) => {
    chmodSync(dir, 0o755);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) chmodSync(abs, 0o644);
    }
  };
  walk(root);
}

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
