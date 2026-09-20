import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { BUNDLE_FORMAT_VERSION, HELM_VERSION } from '../../version.ts';
import { HarnessFingerprintSchema, type HarnessFingerprint } from '../harness/fingerprint.ts';
import { paths } from '../paths.ts';
import { remoteFetch, RemoteError } from './client.ts';
import type { TunnelTarget } from './tunnel.ts';

// Moving bundles across the tunnel.
//
// The bundle is materialized and hashed on disk BEFORE the request starts,
// rather than piping tar's stdout straight into fetch. Streaming from tar is
// possible, but if tar exits non-zero mid-stream the request body simply *ends*
// and the receiver sees a truncated-but-well-formed POST — indistinguishable
// from success. On an ownership transfer that ambiguity is unacceptable. Having
// the file on disk also makes a failed ship retryable without re-tarring.

export interface ImportResponse {
  ok: boolean;
  agentId?: string;
  imported?: {
    tools: number;
    mcpServers?: number;
    gateways: number;
    chats: number;
    heartbeats: number;
  };
  toolsCreated?: { id: string; name: string }[];
  toolsReused?: { id: string; name: string }[];
  mcpServersCreated?: { id: string; name: string }[];
  mcpServersReused?: { id: string; name: string }[];
  warnings?: string[];
  smoke?: { ok: boolean; runId?: string; text?: string; error?: string };
  /**
   * What the remote's CLI loaded for the smoke turn. This is the far side of
   * the harness comparison: the local fingerprint says what the agent had
   * here, this says what it has there.
   */
  harnessFingerprint?: HarnessFingerprint;
  error?: string;
  kind?: 'format' | 'version' | 'conflict' | 'requires' | 'io' | 'smoke';
}

/**
 * Upper bound on the whole import call. It covers spool + extract + import +
 * a full smoke turn (model call, MCP server start-up) before the first response
 * byte, so it is minutes, not seconds. A dead link is still caught fast by
 * ssh's keepalives (tunnel.ts); this only bounds a *live* but slow import.
 */
const IMPORT_STALL_MS = 10 * 60_000;

/** Push a bundle to a remote's import endpoint. */
export async function uploadBundle(
  remote: TunnelTarget & { token: string },
  filePath: string,
  meta: { agentId: string; transferId: string; sha256: string },
): Promise<ImportResponse> {
  const { size } = statSync(filePath);
  const res = await remoteFetch(remote, {
    method: 'POST',
    path: '/api/remote/import',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'x-helm-bundle-format': String(BUNDLE_FORMAT_VERSION),
      'x-helm-source-version': HELM_VERSION,
      'x-helm-agent-id': meta.agentId,
      'x-helm-transfer-id': meta.transferId,
      'x-helm-bundle-sha256': meta.sha256,
    },
    body: Readable.toWeb(createReadStream(filePath)) as unknown as BodyInit,
    duplex: 'half',
    // No hard ceiling: a healthy transfer over a slow link may take many
    // minutes. Stall detection plus ssh's own keepalives bound the failure.
    stallMs: IMPORT_STALL_MS,
  });
  if (!res.ok) throw new RemoteError('http', `remote returned HTTP ${res.status} on import`);
  return (await res.json()) as ImportResponse;
}

export interface DownloadedBundle {
  path: string;
  bytes: number;
  sha256: string | null;
}

/**
 * Ask a remote to export an agent and stream the bundle to a local file.
 *
 * The remote answers with either a tarball or JSON, so the caller discriminates
 * on content-type; a JSON body here means the remote refused and has already
 * reactivated the agent on its side.
 */
export async function downloadBundle(
  remote: TunnelTarget & { token: string },
  agentId: string,
  transferId: string,
  opts: { withData?: boolean } = {},
): Promise<DownloadedBundle | { refused: { error: string; kind: string } }> {
  const query = opts.withData === false ? '?withoutData=1' : '';
  const res = await remoteFetch(remote, {
    method: 'POST',
    path: `/api/remote/agents/${agentId}/export${query}`,
    // What this helm can import. A remote that writes another format refuses
    // *before* deactivating its agent (see the export route), so the failure
    // is a sentence here rather than a stranded transfer.
    headers: { 'x-helm-accept-bundle-formats': String(BUNDLE_FORMAT_VERSION) },
    stallMs: 120_000,
  });

  if (!res.ok) throw new RemoteError('http', `remote returned HTTP ${res.status} on export`);

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await res.json()) as { error?: string; kind?: string };
    return {
      refused: { error: body.error ?? 'remote refused the export', kind: body.kind ?? 'io' },
    };
  }
  if (!res.body) throw new RemoteError('protocol', 'remote returned an empty export body');

  mkdirSync(paths.bundlesDir, { recursive: true, mode: 0o700 });
  const outFile = paths.bundleFile(transferId);
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(outFile, { mode: 0o600 }),
  );
  return {
    path: outFile,
    bytes: statSync(outFile).size,
    sha256: res.headers.get('x-helm-bundle-sha256'),
  };
}

/** The remote is still importing this agent; whether it will keep it is undecided. */
export const IMPORT_PENDING = 'pending' as const;

/**
 * What `/api/remote/agents/$id/status` answers. Loose and every field beyond
 * `ok` optional, for the same reason as RemoteInfoSchema: a newer local side
 * must keep reading an older daemon's status. The console renders it as-is;
 * the machine check reads `lastHarness`.
 */
export const RemoteAgentStatusSchema = z.looseObject({
  ok: z.boolean(),
  paused: z.boolean().optional(),
  agent: z.looseObject({ id: z.string(), name: z.string() }).optional(),
  /** What the remote's CLI loaded on the agent's last turn there (machine parity P0). */
  lastHarness: HarnessFingerprintSchema.nullable().optional(),
});
export type RemoteAgentStatus = z.infer<typeof RemoteAgentStatusSchema>;

/**
 * Fetch a deployed agent's status. `null` means the remote does not have it;
 * `IMPORT_PENDING` (HTTP 202) means it is mid-import and the answer is not yet
 * knowable — callers deciding a transfer's outcome must wait, not conclude.
 */
export async function fetchRemoteAgentStatus(
  remote: TunnelTarget & { token: string },
  agentId: string,
): Promise<RemoteAgentStatus | null | typeof IMPORT_PENDING> {
  const res = await remoteFetch(remote, {
    path: `/api/remote/agents/${agentId}/status`,
    timeoutMs: 20_000,
  });
  if (res.status === 404) return null;
  if (res.status === 202) return IMPORT_PENDING;
  if (!res.ok) throw new RemoteError('http', `remote returned HTTP ${res.status} on status`);
  const parsed = RemoteAgentStatusSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new RemoteError('protocol', 'remote agent status has an unexpected shape');
  }
  return parsed.data;
}

/** Confirm-delete after a successful recall. */
export async function deleteRemoteAgent(
  remote: TunnelTarget & { token: string },
  agentId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await remoteFetch(remote, {
    method: 'POST',
    path: `/api/remote/agents/${agentId}/delete`,
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new RemoteError('http', `remote returned HTTP ${res.status} on delete`);
  return (await res.json()) as { ok: boolean; error?: string };
}
