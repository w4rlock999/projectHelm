import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateExtractedTree } from './fs.ts';
import { BundleError } from './format.ts';
import { createTarball, extractTarball, listTarball, validateMemberNames } from './tar.ts';

// This is the one test that exercises the real system tar, so it is what would
// catch a bsdtar/GNU divergence in the argv we chose. It also builds a
// deliberately hostile archive and asserts we refuse it.

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'helm-tar-test-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Member names read straight from the tar headers of a .tgz — deliberately not
 * via any `tar` binary, since the platform's own tar is what hides AppleDouble
 * members on macOS. 512-byte blocks; name is the first 100 bytes, size is the
 * octal field at offset 124.
 */
function tarHeaderNames(file: string): string[] {
  const buf = gunzipSync(readFileSync(file));
  const names: string[] = [];
  for (let off = 0; off + 512 <= buf.length;) {
    const name = buf
      .subarray(off, off + 100)
      .toString('utf8')
      .replace(/\0.*$/, '');
    if (!name) break; // two zero blocks end the archive
    const size = parseInt(
      buf
        .subarray(off + 124, off + 136)
        .toString('utf8')
        .replace(/\0.*$/, '')
        .trim() || '0',
      8,
    );
    names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe('tar round-trip', () => {
  it('archives a staging tree and restores it byte-for-byte', async () => {
    const stage = path.join(root, 'stage');
    mkdirSync(path.join(stage, 'workspace', 'docs'), { recursive: true });
    mkdirSync(path.join(stage, 'data', 'sessions', 'shared'), { recursive: true });
    writeFileSync(path.join(stage, 'manifest.json'), '{"bundleVersion":1}');
    writeFileSync(path.join(stage, 'db.json'), '{"agent":{}}');
    writeFileSync(path.join(stage, 'workspace', 'notes.md'), 'hello\n');
    writeFileSync(path.join(stage, 'workspace', 'docs', 'CLAUDE.md'), 'nested survives\n');
    writeFileSync(path.join(stage, 'data', 'sessions', 'shared', 'store.db'), 'sqlite');

    const tgz = path.join(root, 'bundle.tgz');
    await createTarball(stage, tgz);

    const names = validateMemberNames(await listTarball(tgz));
    expect(names).toContain('manifest.json');
    expect(names).toContain('db.json');
    expect(names).toContain('workspace/notes.md');
    // A nested CLAUDE.md is agent-authored content and must survive; only the
    // top-level managed one is excluded (by the staging filter, not by tar).
    expect(names).toContain('workspace/docs/CLAUDE.md');

    const out = path.join(root, 'out');
    mkdirSync(out, { recursive: true });
    await extractTarball(tgz, out);

    expect(readFileSync(path.join(out, 'workspace', 'notes.md'), 'utf8')).toBe('hello\n');
    expect(readFileSync(path.join(out, 'db.json'), 'utf8')).toBe('{"agent":{}}');
    expect(validateExtractedTree(out).files).toBe(5);
  });

  it('emits no AppleDouble sidecars, even when members carry xattrs', async () => {
    // The failure this guards: on macOS, bsdtar writes an AppleDouble `._name`
    // member beside every file carrying extended attributes — and on a Mac,
    // `.helm` files carry com.apple.provenance. Those names are not in the
    // bundle's top-level allowlist, so every ship from a Mac died at the remote
    // with `unsafe member name: "._."`.
    //
    // The names are read straight out of the tar headers rather than via
    // `listTarball`, because bsdtar *reabsorbs* AppleDouble members when it
    // lists: on macOS `tar -t` shows a clean archive whether or not the sidecars
    // are there, while GNU tar on the receiving end sees all of them. Listing
    // with the platform's own tar is exactly the oracle that hid this bug.
    const stage = path.join(root, 'xattr-stage');
    mkdirSync(path.join(stage, 'workspace'), { recursive: true });
    writeFileSync(path.join(stage, 'manifest.json'), '{"bundleVersion":1}');
    writeFileSync(path.join(stage, 'db.json'), '{"agent":{}}');
    writeFileSync(path.join(stage, 'workspace', 'notes.md'), 'hello\n');
    if (process.platform === 'darwin') {
      for (const target of [stage, path.join(stage, 'db.json')]) {
        execFileSync('xattr', ['-w', 'com.apple.provenance', 'x', target]);
      }
    }

    const tgz = path.join(root, 'xattr.tgz');
    await createTarball(stage, tgz);

    const names = tarHeaderNames(tgz);
    expect(names).toContain('./db.json');
    expect(names.filter((n) => n.split('/').some((p) => p.startsWith('._')))).toEqual([]);
    // Note the raw headers also contain bsdtar's own `PaxHeader/...` entries.
    // Those are metadata every tar consumes rather than presents as members —
    // GNU tar only warns about the unknown keywords — so they are not checked
    // here; the round-trip test above covers what the validator actually sees.
  });
});

describe('hostile archives', () => {
  it('rejects a traversal member before extracting anything', async () => {
    // Built with the system tar directly so the name is genuinely in the
    // archive — this is what a malicious sender would send.
    const evil = path.join(root, 'evil');
    mkdirSync(path.join(evil, 'sub'), { recursive: true });
    writeFileSync(path.join(evil, 'sub', 'pwned'), 'x');
    const tgz = path.join(root, 'evil.tgz');
    execFileSync('tar', ['-c', '-z', '-f', tgz, '-C', evil, '--', 'sub/../sub/pwned'], {
      stdio: 'ignore',
    });

    const names = await listTarball(tgz);
    // Assert the *reason*: this archive also lacks a manifest, and a bare
    // BundleError check would pass for that instead of for the traversal.
    let code: string | undefined;
    try {
      validateMemberNames(names);
    } catch (err) {
      code = err instanceof BundleError ? err.code : undefined;
    }
    expect(code).toBe('unsafe-path');
  });

  it('rejects an archive with no manifest', async () => {
    const bare = path.join(root, 'bare');
    mkdirSync(path.join(bare, 'workspace'), { recursive: true });
    writeFileSync(path.join(bare, 'workspace', 'a.txt'), 'a');
    const tgz = path.join(root, 'bare.tgz');
    await createTarball(bare, tgz);
    await expect(async () => validateMemberNames(await listTarball(tgz))).rejects.toThrowError(
      /missing manifest\.json/,
    );
  });

  // A symlink is the write-through primitive an attacker wants, and bsdtar and
  // GNU disagree about how aggressively they block it — so we never rely on tar
  // and check the extracted inodes ourselves.
  it('rejects a symlink in an extracted tree', () => {
    const tree = path.join(root, 'symlinked');
    mkdirSync(path.join(tree, 'workspace'), { recursive: true });
    writeFileSync(path.join(tree, 'manifest.json'), '{}');
    symlinkSync('/etc/passwd', path.join(tree, 'workspace', 'passwd'));
    expect(() => validateExtractedTree(tree)).toThrowError(/symlink/);
  });
});
