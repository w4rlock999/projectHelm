import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { agents, type Agent } from '../../db/schema.ts';
import { claudeSkew, helmSkew, majorMinor } from '../../lib/harness-version.ts';
import { HELM_BUILD, HELM_VERSION } from '../../version.ts';
import { fingerprintDelta, type HarnessFingerprint } from '../harness/fingerprint.ts';
import {
  appliedSchemaVersion,
  localHarnessInfo,
  type HarnessInfo,
  type RemoteInfo,
  type Runtimes,
} from '../remote-info.ts';
import { RemoteError } from '../remotes/client.ts';
import { fetchRemoteInfo } from '../remotes/client.ts';
import { getRemote } from '../remotes/index.ts';
import { fetchRemoteAgentStatus, IMPORT_PENDING } from '../remotes/transfer.ts';
import { machineFacts, type MachineFacts } from './probe.ts';
import { sshTransport } from './transport.ts';

// The machine parity report: is that remote configured like this machine?
// One table, every area, each row `expected → actual STATUS fix`. `ok` means
// no row failed; `warn` is drift ship tolerates, `skip` is not-applicable.
//
// Pure row builders (unit-tested) + one orchestrator that gathers both sides.
// P0 covers helm/claude/schema/runtimes/machine/user/harness; P1 adds declared
// machine requirements, P3 env keys.

export type CheckArea =
  'helm' | 'claude' | 'schema' | 'runtimes' | 'machine' | 'user' | 'harness' | 'env';
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckRow {
  area: CheckArea;
  name: string;
  expected: string | null;
  actual: string | null;
  status: CheckStatus;
  /** The command or step that would turn this row green. */
  fix?: string;
}

export interface CheckReport {
  remoteId: string | null;
  remoteName: string | null;
  checkedAt: number;
  ok: boolean;
  rows: CheckRow[];
}

/** This machine's half of every comparison. */
export interface LocalSide {
  helmVersion: string;
  helmBuild: string;
  schemaVersion: number | undefined;
  harness: HarnessInfo;
  machine: MachineFacts;
}

export function reportOk(rows: CheckRow[]): boolean {
  return rows.every((r) => r.status !== 'fail');
}

// Until `helm remote upgrade` / `helm remote claude` land (P2) the fix is the
// documented manual step on the VPS.
const FIX_UPGRADE =
  'on the VPS: git pull && pnpm install && pnpm build && systemctl restart helm-remote';
const fixClaude = (v: string | null) => `on the VPS: pnpm remote:init --claude ${v ?? '<version>'}`;

/** helm version/build, schema, claude version. */
export function versionRows(local: LocalSide, remote: RemoteInfo): CheckRow[] {
  const rows: CheckRow[] = [];

  const helm = helmSkew(local.helmVersion, remote.helmVersion);
  rows.push({
    area: 'helm',
    name: 'version',
    expected: local.helmVersion,
    actual: remote.helmVersion,
    status: helm.level === 'same' ? 'ok' : helm.level === 'patch' ? 'warn' : 'fail',
    ...(helm.level === 'same' ? {} : { fix: FIX_UPGRADE }),
  });
  if (remote.helmBuild === undefined) {
    rows.push({
      area: 'helm',
      name: 'build',
      expected: local.helmBuild,
      actual: null,
      status: 'skip',
    });
  } else {
    const same = remote.helmBuild === local.helmBuild;
    rows.push({
      area: 'helm',
      name: 'build',
      expected: local.helmBuild,
      actual: remote.helmBuild,
      status: same ? 'ok' : 'warn',
      ...(same ? {} : { fix: FIX_UPGRADE }),
    });
  }

  if (local.schemaVersion === undefined || remote.schemaVersion === undefined) {
    rows.push({
      area: 'schema',
      name: 'migrations applied',
      expected: local.schemaVersion?.toString() ?? null,
      actual: remote.schemaVersion?.toString() ?? null,
      status: 'skip',
    });
  } else {
    const same = local.schemaVersion === remote.schemaVersion;
    rows.push({
      area: 'schema',
      name: 'migrations applied',
      expected: String(local.schemaVersion),
      actual: String(remote.schemaVersion),
      status: same ? 'ok' : 'fail',
      ...(same ? {} : { fix: FIX_UPGRADE }),
    });
  }

  const remoteClaude = remote.harnesses.find((h) => h.type === 'claude-code');
  const skew = claudeSkew(local.harness.version, remoteClaude?.version ?? null);
  rows.push({
    area: 'claude',
    name: 'version',
    expected: local.harness.version,
    actual: remoteClaude?.version ?? null,
    status: skew.level === 'same' ? 'ok' : skew.level === 'patch' ? 'warn' : 'fail',
    ...(skew.level === 'same' ? {} : { fix: fixClaude(local.harness.version) }),
  });
  rows.push({
    area: 'claude',
    name: 'authenticated',
    expected: 'yes',
    actual: remoteClaude ? (remoteClaude.authOk ? 'yes' : 'no') : null,
    status: remoteClaude?.authOk ? 'ok' : 'fail',
    ...(remoteClaude?.authOk
      ? {}
      : { fix: 'on the VPS: set CLAUDE_CODE_OAUTH_TOKEN in .helm/remote.env and restart' }),
  });

  return rows;
}

/** node/python3 (major must match), npx/uvx (present locally ⇒ present remotely). */
export function runtimeRows(local: Runtimes | undefined, remote: Runtimes | undefined): CheckRow[] {
  if (!local || !remote) {
    return [
      {
        area: 'runtimes',
        name: 'advertised',
        expected: local ? 'yes' : null,
        actual: remote ? 'yes' : null,
        status: 'skip',
      },
    ];
  }
  const rows: CheckRow[] = [];
  for (const name of ['node', 'python3'] as const) {
    const l = local[name];
    const r = remote[name];
    let status: CheckStatus;
    if (l === null) status = 'skip';
    else if (r === null) status = 'fail';
    else status = majorMinor(l)?.split('.')[0] === majorMinor(r)?.split('.')[0] ? 'ok' : 'warn';
    rows.push({ area: 'runtimes', name, expected: l, actual: r, status });
  }
  for (const name of ['npx', 'uvx'] as const) {
    const l = local[name];
    const r = remote[name];
    rows.push({
      area: 'runtimes',
      name,
      expected: l ? 'present' : 'absent',
      actual: r ? 'present' : 'absent',
      status: !l ? 'skip' : r ? 'ok' : 'fail',
    });
  }
  return rows;
}

function privileges(m: MachineFacts): string {
  return m.root ? 'root' : m.sudo ? 'sudo' : 'no-sudo';
}

/** What the machine is. Informational except privileges (no-sudo warns: apt/systemd steps will be skipped). */
export function machineRows(remote: MachineFacts | undefined): CheckRow[] {
  if (!remote) {
    return [
      {
        area: 'machine',
        name: 'facts',
        expected: 'advertised',
        actual: null,
        status: 'skip',
        fix: FIX_UPGRADE,
      },
    ];
  }
  const os = remote.distro
    ? `${remote.distro.id} ${remote.distro.version ?? ''}`.trim()
    : remote.platform;
  const priv = privileges(remote);
  return [
    { area: 'machine', name: 'os', expected: null, actual: `${os} ${remote.arch}`, status: 'ok' },
    {
      area: 'machine',
      name: 'privileges',
      expected: 'root or sudo',
      actual: priv,
      status: priv === 'no-sudo' ? 'warn' : 'ok',
    },
    { area: 'machine', name: 'app dir', expected: null, actual: remote.appDir, status: 'ok' },
    {
      area: 'machine',
      name: 'pnpm',
      expected: 'on the daemon PATH',
      actual: remote.pnpmBin ?? 'absent',
      status: remote.pnpmBin ? 'ok' : 'warn',
    },
  ];
}

/**
 * The saved ssh login must land as the same user the daemon runs as: recipes
 * write `.helm/machine/**` over ssh and the daemon reads it. `sshUid` null
 * means the exec itself failed (message in `sshError`).
 */
export function userRow(
  remote: MachineFacts | undefined,
  ssh: { uid: number | null; error?: string },
): CheckRow {
  if (ssh.uid === null) {
    return {
      area: 'user',
      name: 'ssh login',
      expected: remote ? `uid ${remote.uid}` : 'reachable',
      actual: ssh.error ?? 'unreachable',
      status: 'fail',
      fix: 'helm remote set <id> --identity <path-to-key>',
    };
  }
  if (!remote) {
    return {
      area: 'user',
      name: 'ssh login',
      expected: null,
      actual: `uid ${ssh.uid}`,
      status: 'skip',
    };
  }
  const same = ssh.uid === remote.uid;
  return {
    area: 'user',
    name: 'ssh login',
    expected: `uid ${remote.uid} (the daemon user)`,
    actual: `uid ${ssh.uid}`,
    status: same ? 'ok' : 'fail',
    ...(same ? {} : { fix: 'log in as the daemon user — recipes must own what the daemon reads' }),
  };
}

/**
 * Harness parity for one deployed agent: the remote's last fingerprint against
 * the last one seen locally. Drift is a warning today (helm declares nothing to
 * be strict about until skills/plugins land); `harnessDiff` takes over then.
 */
export function harnessRows(
  agent: { id: string; name: string; lastHarness: HarnessFingerprint | null },
  remoteLast: HarnessFingerprint | null | undefined,
): CheckRow[] {
  if (!agent.lastHarness || !remoteLast) {
    return [
      {
        area: 'harness',
        name: agent.name,
        expected: agent.lastHarness ? 'as last observed locally' : null,
        actual: remoteLast ? 'observed' : 'no turn on the remote yet',
        status: 'skip',
      },
    ];
  }
  const delta = fingerprintDelta(agent.lastHarness, remoteLast);
  return [
    {
      area: 'harness',
      name: agent.name,
      expected: 'as last observed locally',
      actual: delta.length ? delta.join('; ') : 'same',
      status: delta.length ? 'warn' : 'ok',
    },
  ];
}

export async function localSide(): Promise<LocalSide> {
  const [harness, machine] = await Promise.all([localHarnessInfo(), machineFacts()]);
  return {
    helmVersion: HELM_VERSION,
    helmBuild: HELM_BUILD,
    schemaVersion: appliedSchemaVersion(),
    harness,
    machine,
  };
}

/** `id -u` over the saved login — the one ssh exec a check performs. */
async function sshUid(remote: { sshTarget: string; sshIdentityFile: string | null }) {
  const r = await sshTransport(remote).exec('id -u', [], { timeoutMs: 20_000 });
  const uid = r.code === 0 ? Number(r.stdoutTail.trim()) : NaN;
  if (Number.isInteger(uid)) return { uid };
  return {
    uid: null,
    error: r.timedOut
      ? 'ssh timed out'
      : (r.stderrTail.split('\n').filter(Boolean).pop() ?? `ssh exited ${r.code}`),
  };
}

export interface RemoteCheckOptions {
  /** Restrict harness rows to this agent (deployed there or not). */
  agentId?: string;
  /** Skip the `id -u` ssh exec (tests, or a machine without ssh). */
  ssh?: boolean;
}

/**
 * The report for a registered remote. Never throws for an expected failure:
 * an unreachable remote is a report with one failed row.
 */
export async function runRemoteCheck(
  remoteId: string,
  opts: RemoteCheckOptions = {},
): Promise<CheckReport | null> {
  const remote = getRemote(remoteId);
  if (!remote) return null;
  const checkedAt = Date.now();
  const local = await localSide();

  let info: RemoteInfo;
  try {
    info = await fetchRemoteInfo(remote);
  } catch (err) {
    const kind = err instanceof RemoteError ? err.kind : 'ssh';
    const rows: CheckRow[] = [
      {
        area: 'helm',
        name: 'reachable',
        expected: 'yes',
        actual: `[${kind}] ${err instanceof Error ? err.message : String(err)}`,
        status: 'fail',
        fix: kind === 'ssh' ? 'helm remote set <id> --identity <path-to-key>' : undefined,
      },
    ];
    return { remoteId, remoteName: remote.name, checkedAt, ok: false, rows };
  }

  const rows: CheckRow[] = [
    ...versionRows(local, info),
    ...runtimeRows(
      local.harness.runtimes,
      info.harnesses.find((h) => h.type === 'claude-code')?.runtimes,
    ),
    ...machineRows(info.machine),
  ];
  if (opts.ssh !== false) rows.push(userRow(info.machine, await sshUid(remote)));

  const deployed: Agent[] = opts.agentId
    ? db.select().from(agents).where(eq(agents.id, opts.agentId)).all()
    : db.select().from(agents).where(eq(agents.deployedTo, remoteId)).all();
  for (const a of deployed) {
    try {
      const status = await fetchRemoteAgentStatus(remote, a.id);
      if (status === null) {
        rows.push({
          area: 'harness',
          name: a.name,
          expected: 'present on the remote',
          actual: 'absent',
          status: a.deployedTo === remoteId ? 'fail' : 'skip',
        });
      } else if (status === IMPORT_PENDING) {
        rows.push({
          area: 'harness',
          name: a.name,
          expected: 'present',
          actual: 'import in flight',
          status: 'skip',
        });
      } else {
        rows.push(...harnessRows(a, status.lastHarness));
      }
    } catch (err) {
      rows.push({
        area: 'harness',
        name: a.name,
        expected: 'status readable',
        actual: err instanceof Error ? err.message : String(err),
        status: 'fail',
      });
    }
  }

  return { remoteId, remoteName: remote.name, checkedAt, ok: reportOk(rows), rows };
}
