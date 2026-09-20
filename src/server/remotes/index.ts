import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { agents, remotes, type Remote } from '../../db/schema.ts';
import { claudeSkew, helmSkew } from '../../lib/harness-version.ts';
import { HELM_VERSION } from '../../version.ts';
import { SSH_TARGET_RE } from '../machine/transport.ts';
import { localHarnessInfo, type RemoteInfo } from '../remote-info.ts';
import { fetchRemoteInfo, RemoteError, setRemotePaused, type RemoteErrorKind } from './client.ts';
import { decodeConnectCode } from './connect-code.ts';
import { pendingOrphans, sweepRecallOrphans } from './orphans.ts';
import { teardownTunnel } from './tunnel.ts';

// The local remotes registry: CRUD over the `remotes` table plus the
// handshake-backed operations (add verifies before saving; ping refreshes
// lastSeenAt/lastVersion/capabilities).

/** A remotes row without its pairing token — the only shape any read surface returns. */
export function redactRemote(r: Remote): Omit<Remote, 'token'> {
  const { token: _token, ...rest } = r;
  return rest;
}

export function listRemotes(): Remote[] {
  return db.select().from(remotes).all();
}

export function getRemote(id: string): Remote | null {
  return db.select().from(remotes).where(eq(remotes.id, id)).get() ?? null;
}

/** Either a pasted connect code or the individual fields. */
export interface AddRemoteInput {
  name?: string;
  connectCode?: string;
  sshTarget?: string;
  helmPort?: number;
  token?: string;
  /** `-i` identity file on this machine; `~` is expanded. Optional in both modes. */
  sshIdentityFile?: string | null;
}

/**
 * Normalize an identity-file path: `~` expanded, must be absolute and exist.
 * A path, never key material — helm stores where the key is, not the key.
 * Returns null for an empty/absent value (meaning "ssh's choice").
 */
export function normalizeIdentityFile(input: string | null | undefined): string | null {
  const raw = input?.trim();
  if (!raw) return null;
  const expanded =
    raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded)) {
    throw new Error(`identity file must be an absolute path (or ~/…): ${raw}`);
  }
  if (!existsSync(expanded)) throw new Error(`identity file not found: ${expanded}`);
  return expanded;
}

/**
 * Register a remote. The first handshake happens BEFORE the row is saved —
 * a remote that can't be reached or rejects the token is never persisted.
 */
export async function addRemote(
  input: AddRemoteInput,
): Promise<{ remote: Remote; info: RemoteInfo }> {
  let sshTarget: string;
  let helmPort: number;
  let token: string;
  let defaultName: string;

  if (input.connectCode?.trim()) {
    const code = decodeConnectCode(input.connectCode);
    sshTarget =
      code.sshPort === 22
        ? `${code.sshUser}@${code.host}`
        : `${code.sshUser}@${code.host}:${code.sshPort}`;
    helmPort = code.helmPort;
    token = code.token;
    defaultName = code.host;
  } else {
    if (!input.sshTarget?.trim() || !input.token?.trim()) {
      throw new Error('provide a connect code, or sshTarget + token');
    }
    sshTarget = input.sshTarget.trim();
    if (!SSH_TARGET_RE.test(sshTarget)) {
      throw new Error(`sshTarget must look like user@host[:port], got: ${sshTarget}`);
    }
    helmPort = input.helmPort ?? 5555;
    token = input.token.trim();
    defaultName = sshTarget.split('@').pop()?.split(':')[0] || sshTarget;
  }

  const sshIdentityFile = normalizeIdentityFile(input.sshIdentityFile);
  const id = randomUUID();
  const info = await fetchRemoteInfo({ id, sshTarget, helmPort, token, sshIdentityFile });

  const now = new Date();
  const row: Remote = {
    id,
    name: input.name?.trim() || defaultName,
    sshTarget,
    sshIdentityFile,
    helmPort,
    token,
    lastSeenAt: now,
    lastVersion: info.helmVersion,
    capabilities: info.harnesses,
    createdAt: now,
  };
  db.insert(remotes).values(row).run();
  return { remote: row, info };
}

export interface UpdateRemoteInput {
  name?: string;
  /** null clears (back to ssh's choice); absent leaves it alone. */
  sshIdentityFile?: string | null;
}

/**
 * Edit a registered remote's name or identity file. The cached tunnel is torn
 * down (it was opened with the old argv) and a fresh handshake proves the new
 * identity works before the row changes — a bad key never gets saved.
 */
export async function updateRemote(
  id: string,
  patch: UpdateRemoteInput,
): Promise<{ remote: Remote; info: RemoteInfo | null } | null> {
  const existing = getRemote(id);
  if (!existing) return null;
  const next: Partial<Remote> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('name cannot be empty');
    next.name = name;
  }
  let info: RemoteInfo | null = null;
  if (patch.sshIdentityFile !== undefined) {
    next.sshIdentityFile = normalizeIdentityFile(patch.sshIdentityFile);
    teardownTunnel(id);
    info = await fetchRemoteInfo({ ...existing, sshIdentityFile: next.sshIdentityFile });
    next.lastSeenAt = new Date();
    next.lastVersion = info.helmVersion;
    next.capabilities = info.harnesses;
  }
  if (Object.keys(next).length > 0) {
    db.update(remotes).set(next).where(eq(remotes.id, id)).run();
  }
  return { remote: getRemote(id)!, info };
}

export function removeRemote(id: string): boolean {
  const existing = getRemote(id);
  if (!existing) return false;

  // Unregistering a remote that still hosts agents would leave them running
  // there with nothing left here pointing at them — deployedTo would dangle.
  const deployed = db.select().from(agents).where(eq(agents.deployedTo, id)).all();
  if (deployed.length > 0) {
    throw new Error(
      `${deployed.length} agent(s) are deployed to "${existing.name}" ` +
        `(${deployed.map((a) => a.name).join(', ')}) — recall them first`,
    );
  }

  // Orphans are not a reason to refuse — a dead remote is exactly what you want
  // to unregister — but say so, because the sweep can no longer reach them and
  // their rows will sit unresolved from here on.
  const orphans = pendingOrphans(id);
  if (orphans.length > 0) {
    console.warn(
      `[helm] "${existing.name}" still holds ${orphans.length} recalled agent copy(ies) ` +
        `(${orphans.map((o) => o.agentId).join(', ')}) — unregistering it means deleting them by hand`,
    );
  }

  teardownTunnel(id);
  db.delete(remotes).where(eq(remotes.id, id)).run();
  return true;
}

export type PingResult =
  | { ok: true; info: RemoteInfo; warning?: string }
  | { ok: false; error: string; kind: RemoteErrorKind };

/**
 * Handshake with a registered remote. Success refreshes the cached status
 * columns; expected failures come back as `{ ok: false }` (not a throw) so
 * callers can render them as status. Returns null for an unknown id.
 */
export async function pingRemote(id: string): Promise<PingResult | null> {
  const remote = getRemote(id);
  if (!remote) return null;
  try {
    const info = await fetchRemoteInfo(remote);
    db.update(remotes)
      .set({ lastSeenAt: new Date(), lastVersion: info.helmVersion, capabilities: info.harnesses })
      .where(eq(remotes.id, id))
      .run();
    // A ping is the cheapest proof this remote is reachable, which makes it the
    // natural retry trigger for any copy a recall failed to delete there —
    // otherwise the only retry is a daemon restart. Fire-and-forget: an orphan
    // is not this call's concern, and the sweep is silent when there are none.
    void sweepRecallOrphans({ remoteId: id }).catch((err) =>
      console.error('[helm] recall-orphan sweep failed:', String(err)),
    );
    return { ok: true, info, warning: await skewWarning(info) };
  } catch (err) {
    const kind = err instanceof RemoteError ? err.kind : 'ssh';
    return { ok: false, error: err instanceof Error ? err.message : String(err), kind };
  }
}

/**
 * One sentence per component whose version disagrees with this machine's —
 * helm itself and the Claude Code CLI. Ship preflight refuses on the same
 * comparisons (minor and unknown); patch drift is reported here and only
 * noted there.
 */
async function skewWarning(info: RemoteInfo): Promise<string | undefined> {
  const remoteClaude = info.harnesses.find((h) => h.type === 'claude-code')?.version ?? null;
  const local = await localHarnessInfo();
  const messages = [
    helmSkew(HELM_VERSION, info.helmVersion).message,
    claudeSkew(local.version, remoteClaude).message,
  ].filter((m): m is string => m !== null);
  return messages.length ? messages.join('; ') : undefined;
}

export type RemotePauseResult =
  | { ok: true; paused: boolean; since: string | null; reason: string | null }
  | { ok: false; error: string; kind: RemoteErrorKind };

/**
 * Pause or resume a registered remote. Like pingRemote, expected failures come
 * back as `{ ok: false }` rather than throwing — they're status, not errors.
 */
export async function pauseRemote(
  id: string,
  paused: boolean,
  reason?: string,
): Promise<RemotePauseResult | null> {
  const remote = getRemote(id);
  if (!remote) return null;
  try {
    const state = await setRemotePaused(remote, paused, reason);
    return { ok: true, ...state };
  } catch (err) {
    const kind = err instanceof RemoteError ? err.kind : 'ssh';
    return { ok: false, error: err instanceof Error ? err.message : String(err), kind };
  }
}

/** Agents this local helm believes are deployed to `remoteId`. */
export function agentsDeployedTo(remoteId: string): { id: string; name: string }[] {
  return db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.deployedTo, remoteId))
    .all();
}
