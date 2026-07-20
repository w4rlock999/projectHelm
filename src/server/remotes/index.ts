import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { remotes, type Remote } from '../../db/schema.ts';
import { HELM_VERSION } from '../../version.ts';
import type { RemoteInfo } from '../remote-info.ts';
import { fetchRemoteInfo, RemoteError, type RemoteErrorKind } from './client.ts';
import { decodeConnectCode } from './connect-code.ts';
import { teardownTunnel } from './tunnel.ts';

// The local remotes registry: CRUD over the `remotes` table plus the
// handshake-backed operations (add verifies before saving; ping refreshes
// lastSeenAt/lastVersion/capabilities).

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
    helmPort = input.helmPort ?? 5555;
    token = input.token.trim();
    defaultName = sshTarget.split('@').pop()?.split(':')[0] || sshTarget;
  }

  const id = randomUUID();
  const info = await fetchRemoteInfo({ id, sshTarget, helmPort, token });

  const now = new Date();
  const row: Remote = {
    id,
    name: input.name?.trim() || defaultName,
    sshTarget,
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

export function removeRemote(id: string): boolean {
  const existing = getRemote(id);
  if (!existing) return false;
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
    return { ok: true, info, warning: versionWarning(info.helmVersion) };
  } catch (err) {
    const kind = err instanceof RemoteError ? err.kind : 'ssh';
    return { ok: false, error: err instanceof Error ? err.message : String(err), kind };
  }
}

/** Warn when local and remote disagree on major.minor — skew breaks the seam. */
function versionWarning(remoteVersion: string): string | undefined {
  const majorMinor = (v: string) => v.split('.').slice(0, 2).join('.');
  if (majorMinor(remoteVersion) === majorMinor(HELM_VERSION)) return undefined;
  return `remote runs helm ${remoteVersion}, local is ${HELM_VERSION} — update one of them before shipping agents`;
}
