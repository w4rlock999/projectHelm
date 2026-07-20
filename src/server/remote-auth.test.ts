import { describe, expect, it } from 'vitest';
import {
  encodeBase58,
  generatePairingToken,
  getInternalToken,
  hashToken,
  TOKEN_PREFIX,
  verifyBearer,
} from './remote-auth.ts';

describe('encodeBase58', () => {
  it('encodes known vectors (bitcoin alphabet)', () => {
    expect(encodeBase58(new Uint8Array([0]))).toBe('1');
    expect(encodeBase58(new Uint8Array([0, 0, 1]))).toBe('112');
    expect(encodeBase58(new Uint8Array([57]))).toBe('z');
    expect(encodeBase58(new Uint8Array([255]))).toBe('5Q');
    expect(encodeBase58(Buffer.from('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
  });

  it('never emits ambiguous characters', () => {
    const out = encodeBase58(Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
    expect(out).not.toMatch(/[0OIl]/);
  });
});

describe('generatePairingToken', () => {
  it('has the helm_rt_ prefix and encodes 32 random bytes', () => {
    const token = generatePairingToken();
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    // 32 bytes in base58 is 43–44 chars.
    expect(token.length).toBeGreaterThanOrEqual(TOKEN_PREFIX.length + 40);
    expect(generatePairingToken()).not.toBe(token);
  });
});

describe('verifyBearer', () => {
  const token = generatePairingToken();
  const tokenHash = hashToken(token);

  it('accepts the pairing token against its stored hash', () => {
    expect(verifyBearer(`Bearer ${token}`, { tokenHash })).toBe(true);
  });

  it('is case-insensitive on the Bearer scheme and trims the token', () => {
    expect(verifyBearer(`bearer ${token}`, { tokenHash })).toBe(true);
    expect(verifyBearer(`Bearer ${token} `, { tokenHash })).toBe(true);
  });

  it('accepts the internal token', () => {
    expect(
      verifyBearer('Bearer internal-secret', { tokenHash, internalToken: 'internal-secret' }),
    ).toBe(true);
    expect(verifyBearer(`Bearer ${getInternalToken()}`, { tokenHash: null })).toBe(true);
  });

  it('rejects a missing or malformed header', () => {
    expect(verifyBearer(null, { tokenHash })).toBe(false);
    expect(verifyBearer('', { tokenHash })).toBe(false);
    expect(verifyBearer(token, { tokenHash })).toBe(false); // no scheme
    expect(verifyBearer('Basic dXNlcjpwYXNz', { tokenHash })).toBe(false);
  });

  it('rejects a wrong token, and fails closed with no stored hash', () => {
    expect(verifyBearer(`Bearer ${generatePairingToken()}`, { tokenHash })).toBe(false);
    expect(verifyBearer(`Bearer ${token}`, { tokenHash: null })).toBe(false);
  });

  it('rotation: a new hash invalidates the old token', () => {
    const rotated = hashToken(generatePairingToken());
    expect(verifyBearer(`Bearer ${token}`, { tokenHash: rotated })).toBe(false);
  });
});
