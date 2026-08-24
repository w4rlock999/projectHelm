import { describe, expect, it } from 'vitest';
import { budgetVerdict } from './runs.ts';

// The budget decision is split out as a pure function precisely so this matrix
// can be checked without a database, a daemon, or waiting an hour.

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

function verdict(over: Partial<Parameters<typeof budgetVerdict>[0]> = {}) {
  return budgetVerdict({
    limit: 2,
    countInWindow: 0,
    oldestStartedAt: null,
    now: NOW,
    windowMs: HOUR,
    ...over,
  });
}

describe('budgetVerdict', () => {
  it('allows everything when no limit is set', () => {
    expect(verdict({ limit: null, countInWindow: 9_999 })).toEqual({ allowed: true });
  });

  it('allows up to the limit and refuses at it', () => {
    expect(verdict({ countInWindow: 0 }).allowed).toBe(true);
    expect(verdict({ countInWindow: 1 }).allowed).toBe(true);
    expect(verdict({ countInWindow: 2 }).allowed).toBe(false);
  });

  it('refuses when already over the limit', () => {
    // Can happen if the limit was lowered while runs were in the window.
    expect(verdict({ countInWindow: 5 }).allowed).toBe(false);
  });

  it('reports when the oldest run ages out of the window', () => {
    // Oldest run started 50 minutes ago, so a slot frees in 10.
    const r = verdict({ countInWindow: 2, oldestStartedAt: NOW - 50 * 60_000 });
    expect(r).toEqual({ allowed: false, retryAfterMs: 10 * 60_000 });
  });

  it('never reports a negative retry', () => {
    // The oldest run is already older than the window (it aged out between the
    // count and this call); clamp rather than promising a time in the past.
    const r = verdict({ countInWindow: 2, oldestStartedAt: NOW - 2 * HOUR });
    expect(r).toEqual({ allowed: false, retryAfterMs: 0 });
  });

  it('falls back to a full window when the oldest run is unknown', () => {
    const r = verdict({ countInWindow: 2, oldestStartedAt: null });
    expect(r).toEqual({ allowed: false, retryAfterMs: HOUR });
  });

  it('is rolling, not clock-hour: two runs at :59 do not free slots at :00', () => {
    // The failure a clock-hour reset would allow: 2 runs just before the hour
    // boundary, then 2 more just after — four turns in two minutes.
    const justBefore = NOW - 60_000;
    const r = verdict({ countInWindow: 2, oldestStartedAt: justBefore });
    expect(r.allowed).toBe(false);
  });
});
