import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { runs, type Run } from '../db/schema.ts';
import { loadAgent } from './agents.ts';
import type { HarnessFingerprint } from './harness/fingerprint.ts';
import { deployRefusal } from './deploy-state.ts';
import { SHARED_SESSION_KEY } from './paths.ts';
import { getPauseState, isPaused } from './runtime/pause.ts';

// The run ledger: admission control in front of every agent turn, plus the
// durable record of what ran.
//
// Before this existed a run was only `.helm/agents/<id>/logs/<runId>.ndjson`,
// which nothing ever read back. A uuid run id carries no timestamp, so
// answering "how many runs in the last hour?" meant statting every log file —
// which is why the run budget needs a table rather than a directory listing.

/** Prompts and results are truncated here; the ndjson holds the full text. */
const RUN_TEXT_LIMIT = 2000;

/**
 * The budget is a **rolling** window, not a clock-hour reset.
 *
 * A clock-hour reset satisfies "2 runs/hour" on paper while allowing 2 runs at
 * :59 and 2 more at :00 — four turns in two minutes, which is precisely the
 * burst this guard exists to prevent. Rolling gives the stronger property: never
 * more than N runs in *any* 60-minute span.
 *
 * Overridable so the acceptance criterion ("runBudgetPerHour=2 with a * * * * *
 * heartbeat yields exactly 2 runs/hour") is testable in 60 seconds rather than
 * 60 minutes.
 */
export const BUDGET_WINDOW_MS = Number(process.env.HELM_BUDGET_WINDOW_MS) || 3_600_000;

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

/**
 * Pure budget decision, split out so the whole matrix is unit-testable without
 * a database or a daemon.
 *
 * `oldestStartedAt` is the earliest counted run still inside the window; once it
 * ages out, one slot frees up, which is what `retryAfterMs` reports.
 */
export function budgetVerdict(args: {
  limit: number | null;
  countInWindow: number;
  oldestStartedAt: number | null;
  now: number;
  windowMs: number;
}): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const { limit, countInWindow, oldestStartedAt, now, windowMs } = args;
  if (limit === null) return { allowed: true };
  if (countInWindow < limit) return { allowed: true };
  const retryAfterMs =
    oldestStartedAt === null ? windowMs : Math.max(0, oldestStartedAt + windowMs - now);
  return { allowed: false, retryAfterMs };
}

function truncate(s: string): string {
  return s.length > RUN_TEXT_LIMIT ? s.slice(0, RUN_TEXT_LIMIT) : s;
}

/** What a caller tells the ledger about the turn it is about to run. */
export interface RunMeta {
  source: string;
  prompt: string;
  /** Session the turn runs in; defaults to the shared agent/console session. */
  sessionKey?: string;
}

function recordRefusal(agentId: string, meta: RunMeta, reason: RefusalReason): void {
  db.insert(runs)
    .values({
      id: randomUUID(),
      agentId,
      source: meta.source,
      sessionKey: meta.sessionKey ?? SHARED_SESSION_KEY,
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
export function reserveRun(agentId: string, meta: RunMeta): { runId: string } {
  const agent = loadAgent(agentId);
  if (!agent) {
    // No row to hang a ledger entry off (agent_id is a FK), so nothing recorded.
    throw new RunRefusedError('missing', `agent ${agentId} not found`);
  }

  // Cheapest and most absolute first.
  if (isPaused()) {
    const { reason } = getPauseState();
    recordRefusal(agentId, meta, 'paused');
    throw new RunRefusedError(
      'paused',
      reason ? `the helm daemon is paused (${reason})` : 'the helm daemon is paused',
    );
  }

  const deployed = deployRefusal(agent);
  if (deployed) {
    recordRefusal(agentId, meta, deployed);
    throw new RunRefusedError(
      deployed,
      deployed === 'deployed'
        ? `"${agent.name}" is deployed to a remote and runs there — recall it to run it here`
        : `"${agent.name}" is mid-transfer (${agent.deployState}) — try again once it settles`,
    );
  }

  const now = Date.now();
  const verdict = budgetVerdict({
    limit: agent.runBudgetPerHour,
    countInWindow: countRunsInWindow(agentId, BUDGET_WINDOW_MS, now),
    oldestStartedAt: oldestCountedRunAt(agentId, BUDGET_WINDOW_MS, now),
    now,
    windowMs: BUDGET_WINDOW_MS,
  });
  if (!verdict.allowed) {
    recordRefusal(agentId, meta, 'budget');
    const mins = Math.ceil(verdict.retryAfterMs / 60_000);
    throw new RunRefusedError(
      'budget',
      `"${agent.name}" has used its limit of ${agent.runBudgetPerHour} run(s) per hour — ` +
        `next slot frees up in about ${mins} minute(s)`,
      verdict.retryAfterMs,
    );
  }

  const runId = randomUUID();
  db.insert(runs)
    .values({
      id: runId,
      agentId,
      source: meta.source,
      sessionKey: meta.sessionKey ?? SHARED_SESSION_KEY,
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
  r: { code: number | null; isError: boolean; text: string; harness?: HarnessFingerprint | null },
): void {
  db.update(runs)
    .set({
      status: r.isError ? 'error' : 'ok',
      resultText: truncate(r.text),
      exitCode: r.code,
      isError: r.isError,
      harness: r.harness ?? null,
      endedAt: new Date(),
    })
    .where(eq(runs.id, runId))
    .run();
}

/**
 * A turn that threw before producing a result (spawn failure, abort, crash).
 * The fingerprint is still recorded when the CLI got as far as `system/init`.
 */
export function markRunErrored(
  runId: string,
  message: string,
  harness: HarnessFingerprint | null = null,
): void {
  db.update(runs)
    .set({
      status: 'error',
      harness,
      resultText: truncate(message),
      isError: true,
      endedAt: new Date(),
    })
    .where(eq(runs.id, runId))
    .run();
}

/**
 * A turn the caller aborted before a result (browser refresh, the Stop button).
 * The adapter SIGTERMs the child and resolves normally, so without this the
 * ledger recorded such a run as `ok` with an empty result — and the console,
 * replaying it, would have shown "(no output)" for a turn that was cut short.
 *
 * Deliberately `interrupted` rather than `error`: it shares the boot sweep's
 * meaning (stopped mid-run) and its budget exemption.
 */
export function markRunInterrupted(
  runId: string,
  r: { code: number | null; harness?: HarnessFingerprint | null } = { code: null },
): void {
  db.update(runs)
    .set({
      status: 'interrupted',
      exitCode: r.code,
      harness: r.harness ?? null,
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

/**
 * The turns that make up one conversation, oldest first: every run of
 * `agentId` in `sessionKey` that actually ran (refusals never reached Claude,
 * so they are not part of what it remembers). Pre-migration rows have a null
 * key and are treated as the shared session — every one of them was.
 *
 * Paginates backwards from `before` (epoch ms, exclusive) so the console can
 * load earlier turns on demand; `hasMore` says whether anything older exists.
 */
export function listSessionRuns(
  agentId: string,
  sessionKey: string,
  opts: { limit?: number; before?: number } = {},
): { runs: Run[]; hasMore: boolean } {
  const limit = opts.limit ?? 50;
  const conditions = [
    eq(runs.agentId, agentId),
    or(eq(runs.sessionKey, sessionKey), isNull(runs.sessionKey)),
    ne(runs.status, 'refused'),
  ];
  if (opts.before !== undefined) conditions.push(lt(runs.startedAt, new Date(opts.before)));
  const page = db
    .select()
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(limit + 1)
    .all();
  const hasMore = page.length > limit;
  return { runs: page.slice(0, limit).reverse(), hasMore };
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

/** Start time of the earliest counted run still inside the window, if any. */
export function oldestCountedRunAt(
  agentId: string,
  windowMs: number,
  now = Date.now(),
): number | null {
  const since = new Date(now - windowMs);
  const row = db
    .select({ startedAt: runs.startedAt })
    .from(runs)
    .where(
      and(
        eq(runs.agentId, agentId),
        gt(runs.startedAt, since),
        inArray(runs.status, [...COUNTED_STATUSES]),
      ),
    )
    .orderBy(runs.startedAt)
    .limit(1)
    .get();
  return row ? new Date(row.startedAt).getTime() : null;
}

/** Current budget consumption, for the console and `helm agent budget`. */
export function budgetUsage(
  agentId: string,
): { limit: number | null; used: number; windowMs: number } | null {
  const agent = loadAgent(agentId);
  if (!agent) return null;
  return {
    limit: agent.runBudgetPerHour,
    used: countRunsInWindow(agentId, BUDGET_WINDOW_MS),
    windowMs: BUDGET_WINDOW_MS,
  };
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
