import { describe, expect, it } from 'vitest';
import { claudeSkew, helmSkew, majorMinor } from './harness-version.ts';

describe('majorMinor', () => {
  it('keeps the first two segments', () => {
    expect(majorMinor('2.1.277')).toBe('2.1');
    expect(majorMinor('0.1.0')).toBe('0.1');
  });

  it('passes through a version with fewer segments', () => {
    expect(majorMinor('2')).toBe('2');
  });

  it('is null for nothing', () => {
    expect(majorMinor(null)).toBeNull();
    expect(majorMinor('')).toBeNull();
    expect(majorMinor(undefined)).toBeNull();
  });
});

describe('claudeSkew', () => {
  it('is quiet when versions match', () => {
    expect(claudeSkew('2.1.277', '2.1.277')).toEqual({ level: 'same', message: null });
  });

  it('calls the measured laptop/VPS gap patch drift — a warning, not a refusal', () => {
    const s = claudeSkew('2.1.277', '2.1.270');
    expect(s.level).toBe('patch');
    expect(s.message).toContain('2.1.270');
    expect(s.message).toContain('2.1.277');
  });

  it('refuses across a minor', () => {
    expect(claudeSkew('2.1.277', '2.0.76').level).toBe('minor');
    expect(claudeSkew('2.1.277', '3.0.0').level).toBe('minor');
  });

  it('refuses when a side has no version and says which side', () => {
    expect(claudeSkew('2.1.277', null)).toEqual({
      level: 'unknown',
      message: 'the remote could not report its claude-code version',
    });
    expect(claudeSkew(null, '2.1.277').message).toContain('local');
  });
});

describe('helmSkew', () => {
  it('applies the same rule helm always used for itself', () => {
    expect(helmSkew('0.1.0', '0.1.0').level).toBe('same');
    expect(helmSkew('0.1.0', '0.1.3').level).toBe('patch');
    expect(helmSkew('0.1.0', '0.2.0').level).toBe('minor');
  });
});
