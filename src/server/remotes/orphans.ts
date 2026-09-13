import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { recallOrphans, remotes, type RecallOrphan, type Remote } from '../../db/schema.ts';
import { deleteRemoteAgent } from './transfer.ts';

// Cleaning up remote copies that a completed recall could not delete.
//
// `recall` ends by asking the remote to delete its copy. That call is the only
// step of the flow whose failure does not make the recall wrong: the agent is
// already live locally, and the remote copy is deactivated (its deployState is
// still 'recalling'), so the double-poller hazard that governs every other
// ordering decision in ship.ts does not apply. What it does leave behind is a
// full copy of the agent — workspace, data plane, gateway token — sitting on a
// machine that nothing is going to revisit.
//
// So the failure is recorded (see the `recall_orphans` table) and retried here:
// at boot, and again whenever a ping proves the remote is reachable. The delete
// endpoint is idempotent and refuses anything not marked 'recalling', so
// retrying is cheap and cannot touch an agent that is live over there.
//
// This module deliberately reads the `remotes` table directly instead of
// importing getRemote from ./index.ts: the ping-triggered sweep means index.ts
// imports *this*, and the dependency has to run one way.

/** Note that `agentId` still exists on `remoteId`, and why it wasn't deleted. */
export function recordRecallOrphan(agentId: string, remoteId: string, error: string): void {
  db.insert(recallOrphans)
    .values({
      id: randomUUID(),
      agentId,
      remoteId,
      lastTriedAt: new Date(),
      lastError: error,
    })
    // One row per (agent, remote) — a retry updates the attempt rather than
    // adding a row, so the table's size tracks orphans, not failures.
    .onConflictDoUpdate({
      target: [recallOrphans.agentId, recallOrphans.remoteId],
      set: { lastTriedAt: new Date(), lastError: error },
    })
    .run();
}

/** Orphans still awaiting a successful delete, optionally for one remote. */
export function pendingOrphans(remoteId?: string): RecallOrphan[] {
  const q = db.select().from(recallOrphans);
  return (remoteId ? q.where(eq(recallOrphans.remoteId, remoteId)) : q).all();
}

export interface OrphanSweepResult {
  /** Copies confirmed gone from their remote; their rows are deleted. */
  cleared: number;
  /** Still out there — the row survives for the next sweep. */
  kept: number;
}

export interface SweepOptions {
  /** Limit the sweep to one remote (the ping-triggered case). */
  remoteId?: string;
  /**
   * Seam for unit tests, so the sweep's decision table can be exercised without
   * an ssh tunnel and a live daemon (cf. verifyBearer's `overrides`).
   * Production callers pass nothing.
   */
  deleter?: (remote: Remote, agentId: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Retry every pending confirm-delete.
 *
 * Never throws: it runs on the boot path beside `recoverInterruptedTransfers`,
 * where an exception would leave `ensureRuntimeStarted` un-flagged and restart
 * the whole runtime on the next request.
 */
export async function sweepRecallOrphans(opts: SweepOptions = {}): Promise<OrphanSweepResult> {
  const rows = pendingOrphans(opts.remoteId);
  const result: OrphanSweepResult = { cleared: 0, kept: 0 };
  if (rows.length === 0) return result;

  const remove = opts.deleter ?? deleteRemoteAgent;

  for (const row of rows) {
    try {
      const remote = db.select().from(remotes).where(eq(remotes.id, row.remoteId)).get();
      if (!remote) {
        // The row is now the only record that a copy exists at all, which is
        // exactly why it is kept rather than dropped with the registration.
        keep(row, 'the remote is no longer registered');
        result.kept++;
        continue;
      }

      const res = await remove(remote, row.agentId);
      if (res.ok) {
        // Includes the endpoint's idempotent already-gone answer.
        db.delete(recallOrphans).where(eq(recallOrphans.id, row.id)).run();
        result.cleared++;
        console.log(`[helm] swept recalled copy of ${row.agentId} from ${remote.name}`);
        continue;
      }

      // The remote no longer considers it 'recalling'. Something reactivated it
      // over there, and deleting a live agent has no undo — so this one waits
      // for a human rather than being retried into oblivion.
      keep(row, res.error ?? 'the remote refused the delete');
      result.kept++;
      console.error(
        `[helm] ${row.agentId} still exists on ${remote.name} and the remote refused to ` +
          `delete it: ${res.error ?? 'no reason given'}`,
      );
    } catch (err) {
      // Unreachable remote, dead tunnel, a locked database. All transient by
      // assumption; the next sweep tries again and says nothing in the meantime.
      keep(row, err instanceof Error ? err.message : String(err));
      result.kept++;
    }
  }

  return result;
}

function keep(row: RecallOrphan, error: string): void {
  try {
    db.update(recallOrphans)
      .set({ lastTriedAt: new Date(), lastError: error })
      .where(eq(recallOrphans.id, row.id))
      .run();
  } catch (err) {
    console.error('[helm] could not record a recall-orphan attempt:', String(err));
  }
}
