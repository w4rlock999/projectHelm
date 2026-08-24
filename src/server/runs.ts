import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { runs, type Run } from '../db/schema.ts';
import { loadAgent } from './agents.ts';

// The run ledger: admission control in front of every agent turn, plus the
// durable record of what ran.
//
// Before this existed a run was only `.helm/agents/<id>/logs/<runId>.ndjson`,
// which nothing ever read back. A uuid run id carries no timestamp, so
// answering "how many runs in the last hour?" meant statting every log file —
// which is why the run budget needs a table rather than a directory listing.

/** Prompts and results are truncated here; the ndjson holds the full text. */
const RUN_TEXT_LIMIT = 2000;

/** Statuses that consume budget. A run that never ran must not. */
const COUNTED_STATUSES = ['queued', 'running', 'ok', 'error'] as const;

export type RefusalReason = 'budget' | 'paused' | 'deployed' | 'transferring' | 'missing';

/**
 * A turn that was refused admission and never started. Callers distinguish this
 * from a *failed* run: a heartbeat that is refused stays scheduled, and an
 * inbound Telegram message that is refused deserves a reply saying so.
 */
export class RunRefusedError extends Error {
  constructor(
    readonly reason: RefusalReason,
    message: string,
    /** When the caller could reasonably try again. Only set for 'budget'. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RunRefusedError';
  }
}

function truncate(s: string): string {
  return s.length > RUN_TEXT_LIMIT ? s.slice(0, RUN_TEXT_LIMIT) : s;
}

function recordRefusal(
  agentId: string,
  meta: { source: string; prompt: string },
  reason: RefusalReason,
): void {
  db.insert(runs)
    .values({
      id: randomUUID(),
      agentId,
      source: meta.source,
      status: 'refused',
      refusedReason: reason,
      prompt: truncate(meta.prompt),
      startedAt: new Date(),
      endedAt: new Date(),
    })
    .run();
}

/**
 * Claim a run slot for `agentId`, or throw `RunRefusedError`.
 *
 * **Reserves, it does not merely check.** Five Telegram messages arriving in a
 * single getUpdates batch would each observe the same pre-run count and each
 * pass a naive check. better-sqlite3 is synchronous, so the count and the
 * insert below run with no `await` between them and are therefore atomic with
 * respect to the event loop — the second caller sees the first one's row.
 *
 * Must stay fully synchronous for that reason. Do not add `await` here.
 */
export function reserveRun(
  agentId: string,
  meta: { source: string; prompt: string },
): { runId: string } {
  const agent = loadAgent(agentId);
  if (!agent) {
    // No row to hang a ledger entry off (agent_id is a FK), so nothing recorded.
    throw new RunRefusedError('missing', `agent ${agentId} not found`);
  }

  const runId = randomUUID();
  db.insert(runs)
    .values({
      id: runId,
      agentId,
      source: meta.source,
      status: 'queued',
      prompt: truncate(meta.prompt),
      startedAt: new Date(),
    })
    .run();
  return { runId };
}

export function markRunStarted(runId: string): void {
  db.update(runs).set({ status: 'running' }).where(eq(runs.id, runId)).run();
}

export function markRunFinished(
  runId: string,
  r: { code: number | null; isError: boolean; text: string },
): void {
  db.update(runs)
    .set({
      status: r.isError ? 'error' : 'ok',
      resultText: truncate(r.text),
      exitCode: r.code,
      isError: r.isError,
      endedAt: new Date(),
    })
    .where(eq(runs.id, runId))
    .run();
}

/** A turn that threw before producing a result (spawn failure, abort, crash). */
export function markRunErrored(runId: string, message: string): void {
  db.update(runs)
    .set({
      status: 'error',
      resultText: truncate(message),
      isError: true,
      endedAt: new Date(),
    })
    .where(eq(runs.id, runId))
    .run();
}

export function listRuns(agentId: string, limit = 20): Run[] {
  return db
    .select()
    .from(runs)
    .where(eq(runs.agentId, agentId))
    .orderBy(desc(runs.startedAt))
    .limit(limit)
    .all();
}

export function getRun(runId: string): Run | null {
  return db.select().from(runs).where(eq(runs.id, runId)).get() ?? null;
}

/**
 * Boot sweep: rows left 'queued'/'running' by a process that died mid-turn.
 * Without this they would count against the budget forever, since a run that
 * never ends never leaves the counted set.
 */
export function sweepInterruptedRuns(): number {
  const stale = db
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.status, ['queued', 'running']))
    .all();
  if (stale.length === 0) return 0;
  db.update(runs)
    .set({ status: 'interrupted', endedAt: new Date() })
    .where(
      inArray(
        runs.id,
        stale.map((r) => r.id),
      ),
    )
    .run();
  return stale.length;
}

/** Runs counted against the budget in the window ending now. */
export function countRunsInWindow(agentId: string, windowMs: number, now = Date.now()): number {
  const since = new Date(now - windowMs);
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(runs)
    .where(
      and(
        eq(runs.agentId, agentId),
        gt(runs.startedAt, since),
        inArray(runs.status, [...COUNTED_STATUSES]),
      ),
    )
    .get();
  return row?.n ?? 0;
}

export { COUNTED_STATUSES, RUN_TEXT_LIMIT, recordRefusal, truncate };
