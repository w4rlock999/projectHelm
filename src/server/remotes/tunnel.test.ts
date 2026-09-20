import { describe, expect, it } from 'vitest';
import { parseSshTarget, shouldReap, tunnelArgs } from './tunnel.ts';

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

describe('shouldReap', () => {
  const now = 1_700_000_000_000;

  it('reaps an idle, unleased tunnel', () => {
    expect(shouldReap({ leases: 0, lastUsedAt: now - 61_000 }, now)).toBe(true);
  });

  it('spares a tunnel used recently', () => {
    expect(shouldReap({ leases: 0, lastUsedAt: now - 5_000 }, now)).toBe(false);
  });

  // The bug this exists to prevent: a bundle upload runs far longer than the
  // idle TTL, and reaping it would SIGTERM ssh mid-transfer.
  it('never reaps a leased tunnel, however old', () => {
    expect(shouldReap({ leases: 1, lastUsedAt: now - 60 * 60_000 }, now)).toBe(false);
  });

  it('becomes reapable once the last lease is released', () => {
    expect(shouldReap({ leases: 0, lastUsedAt: now - 60 * 60_000 }, now)).toBe(true);
  });
});

describe('tunnelArgs', () => {
  it('forwards the port with -N, shares the base ssh options, and ends with -- destination', () => {
    const args = tunnelArgs({ id: 'r', sshTarget: 'root@vps:2222', helmPort: 5555 }, 40000);
    expect(args[0]).toBe('-N');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ExitOnForwardFailure=yes');
    expect(args.slice(-2)).toEqual(['--', 'root@vps']);
    expect(args[args.indexOf('-L') + 1]).toBe('127.0.0.1:40000:127.0.0.1:5555');
    expect(args[args.indexOf('-p') + 1]).toBe('2222');
    expect(args).not.toContain('-i');
  });

  it('adds the saved identity file', () => {
    const args = tunnelArgs(
      { id: 'r', sshTarget: 'root@vps', helmPort: 5555, sshIdentityFile: '/k' },
      1,
    );
    expect(args[args.indexOf('-i') + 1]).toBe('/k');
    expect(args).toContain('IdentitiesOnly=yes');
  });
});
