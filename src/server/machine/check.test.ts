import { describe, expect, it } from 'vitest';
import type { HarnessFingerprint } from '../harness/fingerprint.ts';
import type { RemoteInfo } from '../remote-info.ts';
import {
  harnessRows,
  machineRows,
  reportOk,
  runtimeRows,
  userRow,
  versionRows,
  type LocalSide,
} from './check.ts';
import type { MachineFacts } from './probe.ts';

const facts: MachineFacts = {
  platform: 'linux',
  arch: 'x64',
  distro: { id: 'ubuntu', version: '24.04' },
  uid: 0,
  root: true,
  sudo: true,
  appDir: '/root/workspace/projectHelm',
  nodeBin: '/usr/bin/node',
  pnpmBin: '/usr/local/bin/pnpm',
  prefixes: { venv: false, npmModules: false, browsers: [] },
};

const local: LocalSide = {
  helmVersion: '0.1.0',
  helmBuild: 'abc1234',
  schemaVersion: 15,
  harness: {
    type: 'claude-code',
    version: '2.1.278',
    authOk: true,
    runtimes: { node: 'v22.1.0', python3: '3.12.3', npx: true, uvx: true },
  },
  machine: { ...facts, platform: 'darwin', uid: 501, root: false, sudo: true },
};

const remote: RemoteInfo = {
  helmVersion: '0.1.0',
  helmBuild: 'abc1234',
  headless: true,
  harnesses: [
    {
      type: 'claude-code',
      version: '2.1.278',
      authOk: true,
      runtimes: { node: 'v22.9.0', python3: '3.12.3', npx: true, uvx: true },
    },
  ],
  agentCount: 1,
  uptimeSec: 10,
  bundleFormats: [3],
  schemaVersion: 15,
  machine: facts,
};

const byName = (rows: { area: string; name: string; status: string }[]) =>
  Object.fromEntries(rows.map((r) => [`${r.area}/${r.name}`, r.status]));

describe('versionRows', () => {
  it('is all green when both sides match', () => {
    expect(byName(versionRows(local, remote))).toEqual({
      'helm/version': 'ok',
      'helm/build': 'ok',
      'schema/migrations applied': 'ok',
      'claude/version': 'ok',
      'claude/authenticated': 'ok',
    });
  });

  it('warns on patch drift and a different build, fails on a minor skew', () => {
    const rows = versionRows(local, {
      ...remote,
      helmBuild: 'ffff000',
      harnesses: [{ type: 'claude-code', version: '2.1.270', authOk: true }],
    });
    const s = byName(rows);
    expect(s['helm/build']).toBe('warn');
    expect(s['claude/version']).toBe('warn');
    expect(rows.find((r) => r.name === 'build')?.fix).toMatch(/git pull/);
    expect(byName(versionRows(local, { ...remote, helmVersion: '0.2.0' }))['helm/version']).toBe(
      'fail',
    );
    expect(
      byName(
        versionRows(local, {
          ...remote,
          harnesses: [{ type: 'claude-code', version: '2.0.1', authOk: true }],
        }),
      )['claude/version'],
    ).toBe('fail');
  });

  it('fails when the remote cannot report a claude version or is unauthenticated', () => {
    const s = byName(
      versionRows(local, {
        ...remote,
        harnesses: [{ type: 'claude-code', version: null, authOk: false }],
      }),
    );
    expect(s['claude/version']).toBe('fail');
    expect(s['claude/authenticated']).toBe('fail');
  });

  it('skips build/schema an older daemon does not advertise, fails a schema mismatch', () => {
    const s = byName(
      versionRows(local, { ...remote, helmBuild: undefined, schemaVersion: undefined }),
    );
    expect(s['helm/build']).toBe('skip');
    expect(s['schema/migrations applied']).toBe('skip');
    expect(
      byName(versionRows(local, { ...remote, schemaVersion: 14 }))['schema/migrations applied'],
    ).toBe('fail');
  });
});

describe('runtimeRows', () => {
  const l = { node: 'v22.1.0', python3: '3.12.3', npx: true, uvx: true };

  it('ok when majors match and launchers are present', () => {
    expect(byName(runtimeRows(l, { ...l, node: 'v22.9.0' }))).toEqual({
      'runtimes/node': 'ok',
      'runtimes/python3': 'ok',
      'runtimes/npx': 'ok',
      'runtimes/uvx': 'ok',
    });
  });

  it('warns on a different major, fails on a missing runtime, skips what local lacks', () => {
    const s = byName(
      runtimeRows({ ...l, uvx: false }, { node: 'v20.0.0', python3: null, npx: false, uvx: false }),
    );
    expect(s['runtimes/node']).toBe('warn');
    expect(s['runtimes/python3']).toBe('fail');
    expect(s['runtimes/npx']).toBe('fail');
    expect(s['runtimes/uvx']).toBe('skip');
  });

  it('is a single skip row when a side does not advertise runtimes', () => {
    expect(runtimeRows(l, undefined)).toEqual([
      { area: 'runtimes', name: 'advertised', expected: 'yes', actual: null, status: 'skip' },
    ]);
  });
});

describe('machineRows / userRow', () => {
  it('describes the machine and warns only on no-sudo', () => {
    expect(byName(machineRows(facts))['machine/privileges']).toBe('ok');
    expect(
      byName(machineRows({ ...facts, root: false, sudo: false, uid: 1000 }))['machine/privileges'],
    ).toBe('warn');
    expect(machineRows(facts).find((r) => r.name === 'os')?.actual).toBe('ubuntu 24.04 x64');
    expect(machineRows(undefined)[0].status).toBe('skip');
  });

  it('requires the ssh login to be the daemon user', () => {
    expect(userRow(facts, { uid: 0 }).status).toBe('ok');
    expect(userRow(facts, { uid: 1000 }).status).toBe('fail');
    const unreachable = userRow(facts, { uid: null, error: 'Permission denied (publickey)' });
    expect(unreachable.status).toBe('fail');
    expect(unreachable.actual).toMatch(/publickey/);
    expect(userRow(undefined, { uid: 0 }).status).toBe('skip');
  });
});

describe('harnessRows', () => {
  const fp = (over: Partial<HarnessFingerprint> = {}): HarnessFingerprint => ({
    claudeVersion: '2.1.278',
    model: 'claude-sonnet-5',
    permissionMode: 'default',
    tools: ['Bash'],
    skills: ['a', 'b'],
    plugins: [],
    mcpServers: [],
    agents: [],
    slashCommands: [],
    capturedAt: 1,
    ...over,
  });

  it('ok when the remote fingerprint matches the last local one, warn on drift', () => {
    const agent = { id: 'x', name: 'writer', lastHarness: fp() };
    expect(harnessRows(agent, fp())[0].status).toBe('ok');
    const drift = harnessRows(agent, fp({ skills: ['a'], claudeVersion: '2.1.270' }))[0];
    expect(drift.status).toBe('warn');
    expect(drift.actual).toContain('skills 2 → 1');
    expect(drift.actual).toContain('claude 2.1.278 → 2.1.270');
  });

  it('skips when either side has not run a turn yet', () => {
    expect(harnessRows({ id: 'x', name: 'w', lastHarness: null }, fp())[0].status).toBe('skip');
    expect(harnessRows({ id: 'x', name: 'w', lastHarness: fp() }, null)[0].status).toBe('skip');
  });
});

describe('reportOk', () => {
  it('is false iff a row failed; warn and skip do not count', () => {
    const row = (status: 'ok' | 'warn' | 'fail' | 'skip') => ({
      area: 'helm' as const,
      name: 'x',
      expected: null,
      actual: null,
      status,
    });
    expect(reportOk([row('ok'), row('warn'), row('skip')])).toBe(true);
    expect(reportOk([row('ok'), row('fail')])).toBe(false);
  });
});
