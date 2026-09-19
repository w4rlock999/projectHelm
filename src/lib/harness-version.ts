// Version comparison for the two things that must agree across the ship seam:
// helm itself and the Claude Code CLI. Client-safe (no node imports) so the
// Remotes page can render the same verdict the ship preflight refuses on.

/** `'2.1.277'` → `'2.1'`. Null in, null out. */
export function majorMinor(v: string | null | undefined): string | null {
  if (!v) return null;
  const parts = v.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : v;
}

export type SkewLevel = 'same' | 'patch' | 'minor' | 'unknown';

export interface Skew {
  level: SkewLevel;
  /** Human sentence for the UI / preflight log; null when `same`. */
  message: string | null;
}

/**
 * How far apart two versions of one component are.
 *
 * - `same`    identical
 * - `patch`   same major.minor, different patch — a warning
 * - `minor`   different major.minor — ship refuses
 * - `unknown` one side could not report a version (e.g. `claude` not found) — ship refuses
 *
 * The policy is major.minor equality, the same rule helm has always applied to
 * its own version: patch releases are frequent and compatible, a minor bump is
 * where flags and event shapes change.
 */
export function versionSkew(component: string, local: string | null, remote: string | null): Skew {
  if (!local || !remote) {
    const side = !remote ? 'remote' : 'local';
    return {
      level: 'unknown',
      message: `the ${side} could not report its ${component} version`,
    };
  }
  if (local === remote) return { level: 'same', message: null };
  if (majorMinor(local) === majorMinor(remote)) {
    return {
      level: 'patch',
      message: `remote runs ${component} ${remote}, local is ${local} (patch drift)`,
    };
  }
  return {
    level: 'minor',
    message: `remote runs ${component} ${remote}, local is ${local} — upgrade one before shipping`,
  };
}

export function claudeSkew(local: string | null, remote: string | null): Skew {
  return versionSkew('claude-code', local, remote);
}

export function helmSkew(local: string | null, remote: string | null): Skew {
  return versionSkew('helm', local, remote);
}
