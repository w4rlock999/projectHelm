import { describe, expect, it } from 'vitest';
import { CONNECT_CODE_PREFIX, decodeConnectCode, encodeConnectCode } from './connect-code.ts';

const sample = {
  v: 1 as const,
  sshUser: 'deploy',
  host: '203.0.113.7',
  sshPort: 22,
  helmPort: 5555,
  token: 'helm_rt_abc123',
};

describe('connect code', () => {
  it('round-trips', () => {
    const code = encodeConnectCode(sample);
    expect(code.startsWith(CONNECT_CODE_PREFIX)).toBe(true);
    expect(decodeConnectCode(code)).toEqual(sample);
  });

  it('tolerates surrounding whitespace', () => {
    expect(decodeConnectCode(`  ${encodeConnectCode(sample)}\n`)).toEqual(sample);
  });

  it('rejects a missing prefix', () => {
    expect(() => decodeConnectCode('nope:abc')).toThrow(/must start with/);
  });

  it('rejects garbage base64', () => {
    expect(() => decodeConnectCode(`${CONNECT_CODE_PREFIX}!!!not-base64!!!`)).toThrow(
      /not valid base64url JSON/,
    );
  });

  it('rejects an unsupported version', () => {
    const v2 =
      CONNECT_CODE_PREFIX + Buffer.from(JSON.stringify({ ...sample, v: 2 })).toString('base64url');
    expect(() => decodeConnectCode(v2)).toThrow(/unsupported version|unexpected shape/);
  });

  it('rejects missing fields', () => {
    const { token: _token, ...missing } = sample;
    const code = CONNECT_CODE_PREFIX + Buffer.from(JSON.stringify(missing)).toString('base64url');
    expect(() => decodeConnectCode(code)).toThrow(/unexpected shape/);
  });
});
