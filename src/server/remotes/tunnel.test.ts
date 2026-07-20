import { describe, expect, it } from 'vitest';
import { parseSshTarget } from './tunnel.ts';

describe('parseSshTarget', () => {
  it('plain user@host', () => {
    expect(parseSshTarget('deploy@vps.example.com')).toEqual({
      destination: 'deploy@vps.example.com',
    });
  });

  it('user@host:port', () => {
    expect(parseSshTarget('deploy@vps.example.com:2222')).toEqual({
      destination: 'deploy@vps.example.com',
      port: 2222,
    });
  });

  it('bare host (ssh config alias)', () => {
    expect(parseSshTarget('my-vps')).toEqual({ destination: 'my-vps' });
  });
});
