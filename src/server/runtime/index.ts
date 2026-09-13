import { sweepRecallOrphans } from '../remotes/orphans.ts';
import { recoverInterruptedTransfers } from '../remotes/ship.ts';
import { sweepInterruptedRuns } from '../runs.ts';
import { reconcileGateways } from './gateways.ts';
import { startHeartbeatScheduler } from './heartbeats.ts';

/**
 * Boot the background daemon loops (heartbeat scheduler + Telegram pollers)
 * exactly once per server process. Idempotent and HMR-safe via a globalThis
 * flag. Called from the tRPC context factory and the agent-facing REST routes,
 * so the loops come up as soon as the server handles any request.
 */
export function ensureRuntimeStarted(): void {
  if ((globalThis as any).__helmRuntimeStarted) return;
  (globalThis as any).__helmRuntimeStarted = true;
  try {
    // Runs left 'queued'/'running' by a process that died mid-turn would
    // otherwise count against their agent's budget forever, since a run that
    // never ends never leaves the counted set. Sweep before anything can start.
    const swept = sweepInterruptedRuns();
    if (swept > 0) console.log(`[helm] marked ${swept} interrupted run(s) from a previous process`);
    startHeartbeatScheduler();
    reconcileGateways();
    // An interrupted ship/recall left its agent deactivated (the safe half);
    // this decides whether it belongs here or on the remote. Fire-and-forget,
    // and it must never throw into this path — the catch below un-sets the
    // guard flag, which would make the runtime start over on every request.
    void recoverInterruptedTransfers().catch((err) =>
      console.error('[helm] transfer recovery failed:', String(err)),
    );
    // A recall whose confirm-delete failed left a full copy of the agent on the
    // remote. Same fire-and-forget shape, and for the same reason.
    void sweepRecallOrphans().catch((err) =>
      console.error('[helm] recall-orphan sweep failed:', String(err)),
    );
    console.log('[helm] runtime started (heartbeat scheduler + gateway pollers)');
  } catch (err) {
    // Don't wedge request handling if boot hiccups; next request retries.
    (globalThis as any).__helmRuntimeStarted = false;
    console.error('[helm] runtime start failed:', String(err));
  }
}
