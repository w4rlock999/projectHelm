import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { remoteOps, type RemoteOp } from '../../db/schema.ts';
import { paths } from '../paths.ts';

// The ops ledger: what helm ran on which machine. One row per run; progress
// while a run is live is kept in memory by the runner (P2) and polled, only the
// final row lands here. `detail` is argv or step names — never env values,
// never tokens.

export type OpKind = 'provision' | 'upgrade' | 'init' | 'exec-note';
export type OpRequester = 'operator' | 'agent' | 'system';

export const LOCAL_MACHINE = 'local';

export interface RecordOpInput {
  /** remotes.id, or null for this machine. */
  remoteId: string | null;
  kind: OpKind;
  detail: unknown;
  requestedBy: OpRequester;
  startedAt?: Date;
  finishedAt?: Date | null;
  code?: number | null;
  logPath?: string | null;
}

export function recordOp(input: RecordOpInput): RemoteOp {
  const row: RemoteOp = {
    id: randomUUID(),
    remoteId: input.remoteId,
    kind: input.kind,
    detail: input.detail,
    requestedBy: input.requestedBy,
    startedAt: input.startedAt ?? new Date(),
    finishedAt: input.finishedAt ?? null,
    code: input.code ?? null,
    logPath: input.logPath ?? null,
  };
  db.insert(remoteOps).values(row).run();
  return row;
}

export function finishOp(id: string, result: { code: number | null; finishedAt?: Date }): void {
  db.update(remoteOps)
    .set({ code: result.code, finishedAt: result.finishedAt ?? new Date() })
    .where(eq(remoteOps.id, id))
    .run();
}

/** Newest first. `remoteId` null lists what ran on this machine. */
export function listOps(remoteId: string | null, limit = 20): RemoteOp[] {
  return db
    .select()
    .from(remoteOps)
    .where(remoteId === null ? isNull(remoteOps.remoteId) : eq(remoteOps.remoteId, remoteId))
    .orderBy(desc(remoteOps.startedAt))
    .limit(limit)
    .all();
}

/** Where a run's log goes; the directory is created 0700. */
export function opLogPath(remoteId: string | null, opId: string): string {
  const key = remoteId ?? LOCAL_MACHINE;
  mkdirSync(paths.remoteOpsDir(key), { recursive: true, mode: 0o700 });
  return paths.remoteOpLog(key, opId);
}
