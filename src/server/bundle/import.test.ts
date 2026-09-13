import { describe, expect, it } from 'vitest';
import { BundleError, toolContentHash, type BundleDb } from './format.ts';
import { resolveToolImports } from './import.ts';

// Tool resolution is insert-or-reuse-or-FAIL, never an upsert: updating a shared
// library tool would re-materialize every other local agent that has it
// assigned, so a shipped bundle could silently rewrite unrelated agents.

const ID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ID_B = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';

type BundledTool = BundleDb['tools'][number];

function bundled(over: Partial<BundledTool> = {}): BundledTool {
  const t = {
    id: ID_A,
    name: 'scrape',
    description: 'scrapes',
    interpreter: 'bash' as const,
    source: 'echo hi',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
  return { ...t, contentHash: toolContentHash(t) };
}

function local(over: Partial<{ id: string; name: string; interpreter: string; source: string }>) {
  return { id: ID_B, name: 'scrape', interpreter: 'bash', source: 'echo hi', ...over };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof BundleError ? err.code : `not-a-BundleError:${String(err)}`;
  }
  return undefined;
}

describe('resolveToolImports', () => {
  it('creates a tool that does not exist locally', () => {
    const plan = resolveToolImports([bundled({})], []);
    expect(plan.create).toHaveLength(1);
    expect(plan.reuse).toHaveLength(0);
    // The bundle's id is preserved when free, so ship -> recall -> ship is a
    // true round-trip.
    expect(plan.idMap.get(ID_A)).toBe(ID_A);
  });

  it('reuses an identical local tool', () => {
    const plan = resolveToolImports([bundled({})], [local({})]);
    expect(plan.create).toHaveLength(0);
    expect(plan.reuse).toEqual([{ id: ID_B, name: 'scrape' }]);
    expect(plan.idMap.get(ID_A)).toBe(ID_B);
  });

  it('mints a fresh id when the bundle id is already taken by a different tool', () => {
    const plan = resolveToolImports([bundled({})], [local({ id: ID_A, name: 'other' })]);
    expect(plan.create).toHaveLength(1);
    expect(plan.idMap.get(ID_A)).not.toBe(ID_A);
  });

  it('fails on a same-name tool with different source, naming both hashes', () => {
    expect(codeOf(() => resolveToolImports([bundled({})], [local({ source: 'echo bye' })]))).toBe(
      'tool-conflict',
    );
  });

  it('fails when the local library has two tools with that name', () => {
    // tools.name has no unique index, so this really can happen.
    const dupes = [local({ id: ID_B }), local({ id: '3f2504e0-4f89-41d3-9a0c-0305e82c3303' })];
    expect(codeOf(() => resolveToolImports([bundled({})], dupes))).toBe('tool-conflict');
  });

  // The bundle could otherwise declare a hash matching a local tool while
  // carrying different source, forcing a reuse-and-discard.
  it('recomputes the hash rather than trusting the declared one', () => {
    const lying = { ...bundled({}), contentHash: 'f'.repeat(64) };
    expect(codeOf(() => resolveToolImports([lying], []))).toBe('integrity');
  });

  it('ignores description drift when deciding to reuse', () => {
    const plan = resolveToolImports(
      [bundled({ description: 'totally different docs' })],
      [local({})],
    );
    expect(plan.reuse).toHaveLength(1);
  });

  it('never returns a bundled tool without a mapping', () => {
    const plan = resolveToolImports([bundled({}), bundled({ id: ID_B, name: 'other' })], []);
    expect(plan.idMap.size).toBe(2);
  });
});
