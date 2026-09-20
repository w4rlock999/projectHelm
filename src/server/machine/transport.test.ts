import { describe, expect, it } from 'vitest';
import {
  bashStdinCommand,
  localTransport,
  parseSshTarget,
  shellQuote,
  SSH_TARGET_RE,
  sshBaseArgs,
} from './transport.ts';

describe('sshBaseArgs', () => {
  it('has batch mode and keepalives, no identity, no port by default', () => {
    expect(sshBaseArgs({ sshTarget: 'root@vps' })).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=2',
    ]);
  });

  it('adds -i with IdentitiesOnly when a key is saved, and -p for a port', () => {
    const args = sshBaseArgs({ sshTarget: 'root@vps:2222', sshIdentityFile: '/home/me/.ssh/k' });
    expect(args.slice(-6)).toEqual([
      '-i',
      '/home/me/.ssh/k',
      '-o',
      'IdentitiesOnly=yes',
      '-p',
      '2222',
    ]);
  });

  it('ignores a null identity', () => {
    expect(sshBaseArgs({ sshTarget: 'root@vps', sshIdentityFile: null })).not.toContain('-i');
  });
});

describe('shellQuote / bashStdinCommand', () => {
  it('single-quotes anything, escaping embedded quotes', () => {
    expect(shellQuote('plain')).toBe(`'plain'`);
    expect(shellQuote(`it's $HOME "x"`)).toBe(`'it'\\''s $HOME "x"'`);
    expect(shellQuote('')).toBe(`''`);
  });

  it('builds the remote command with every arg quoted', () => {
    expect(bashStdinCommand(['a b', '--flag'])).toBe(`bash -s -- 'a b' '--flag'`);
  });
});

describe('SSH_TARGET_RE', () => {
  it('accepts user@host, host:port and a bare config alias', () => {
    for (const ok of ['root@65.21.179.129', 'deploy@vps.example.com:2222', 'my-vps', 'a.b_c@h-1']) {
      expect(SSH_TARGET_RE.test(ok), ok).toBe(true);
    }
  });

  it('rejects anything ssh could read as an option or a command', () => {
    for (const bad of [
      '-oProxyCommand=id@x',
      'root@vps -oProxyCommand=id',
      'a b@c',
      'root@vps:abc',
      '',
    ]) {
      expect(SSH_TARGET_RE.test(bad), bad).toBe(false);
    }
  });
});

describe('parseSshTarget', () => {
  it('splits the port off', () => {
    expect(parseSshTarget('u@h:22')).toEqual({ destination: 'u@h', port: 22 });
    expect(parseSshTarget('u@h')).toEqual({ destination: 'u@h' });
  });
});

// Real bash, no network: proves the stdin-script + argv contract end to end.
describe('localTransport', () => {
  it('runs the script from stdin with positional args and captures both streams', async () => {
    const r = await localTransport().exec('echo "arg1=$1"; echo oops >&2; exit 3', ['a b'], {
      timeoutMs: 10_000,
    });
    expect(r.code).toBe(3);
    expect(r.stdoutTail).toBe('arg1=a b');
    expect(r.stderrTail).toBe('oops');
    expect(r.timedOut).toBe(false);
  });

  it('streams lines and reports a timeout', async () => {
    const lines: string[] = [];
    const r = await localTransport().exec('echo one; sleep 5; echo two', [], {
      timeoutMs: 500,
      onLine: (_s, l) => lines.push(l),
    });
    expect(lines).toEqual(['one']);
    expect(r.timedOut).toBe(true);
  });
});
