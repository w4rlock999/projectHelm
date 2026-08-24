import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { agents, type Agent } from '../../db/schema.ts';
import { HELM_VERSION, BUNDLE_FORMAT_VERSION } from '../../version.ts';
import { loadAgent } from '../agents.ts';
import { exportAgentBundle } from '../bundle/export.ts';
import { importAgentBundle } from '../bundle/import.ts';
import { drainAgentRuns } from '../run.ts';
import { drainAgentPollers, reconcileGateways } from '../runtime/gateways.ts';
import { fetchRemoteInfo, RemoteError, type RemoteErrorKind } from './client.ts';
import { getRemote } from './index.ts';
import {
  deleteRemoteAgent,
  downloadBundle,
  fetchRemoteAgentStatus,
  uploadBundle,
} from './transfer.ts';

// Ship & recall: ownership transfer of an agent between two helm daemons.
//
// The ordering rule that everything else follows: **the durable claim comes
// first**, before deactivation. If the local process dies anywhere between
// deactivating and committing, it must come back with the agent still
// deactivated — otherwise the local poller and the remote poller both hold the
// same Telegram bot token and every message gets answered twice. A flag written
// at the END of the flow (as the original plan had it) cannot provide that.

export type ShipPhase =
  | 'claim'
  | 'preflight'
  | 'deactivate'
  | 'export'
  | 'upload'
  | 'activate'
  | 'commit'
  | 'done'
  | 'rollback'
  | 'stranded';

export interface TransferProgress {
  phase: ShipPhase;
  message: string;
  at: number;
}

export type ShipOutcome =
  | { ok: true; agentId: string; remoteId: string; smoke?: { ok: boolean; text?: string } }
  | {
      ok: false;
      phase: ShipPhase;
      error: string;
      kind: RemoteErrorKind | 'preflight' | 'bundle' | 'conflict' | 'busy' | 'ambiguous';
      resolution: 'rolled-back' | 'stranded';
    };

interface TransferRun {
  transferId: string;
  agentId: string;
  remoteId: string;
  direction: 'ship' | 'recall';
  phase: ShipPhase;
  log: TransferProgress[];
  outcome?: ShipOutcome;
  promise: Promise<ShipOutcome>;
}

// Same globalThis registry pattern as the pollers and tunnels, so HMR and
// repeated imports don't fork the bookkeeping.
const transfers: Map<string, TransferRun> =
  (globalThis as any).__helmTransfers ?? ((globalThis as any).__helmTransfers = new Map());

function step(run: TransferRun, phase: ShipPhase, message: string): void {
  run.phase = phase;
  run.log.push({ phase, message, at: Date.now() });
  console.log(`[helm] ${run.direction} ${run.agentId}: ${phase} — ${message}`);
}

export function transferStatus(agentId: string): {
  transferId: string;
  direction: 'ship' | 'recall';
  phase: ShipPhase;
  log: TransferProgress[];
  outcome?: ShipOutcome;
} | null {
  const run = transfers.get(agentId);
  if (!run) return null;
  const { transferId, direction, phase, log, outcome } = run;
  return { transferId, direction, phase, log, outcome };
}

/** Set deployment columns in one statement. */
function setDeploy(agentId: string, patch: Partial<Agent>): void {
  db.update(agents).set(patch).where(eq(agents.id, agentId)).run();
}

// ── ship ────────────────────────────────────────────────────────────────────

export function startShip(
  agentId: string,
  remoteId: string,
  opts: { withData?: boolean } = {},
): { transferId: string } {
  const existing = transfers.get(agentId);
  if (existing && !existing.outcome) {
    throw new Error(`a ${existing.direction} is already in progress for this agent`);
  }

  const transferId = randomUUID();
  const run: TransferRun = {
    transferId,
    agentId,
    remoteId,
    direction: 'ship',
    phase: 'claim',
    log: [],
    promise: Promise.resolve({} as ShipOutcome),
  };
  transfers.set(agentId, run);
  // Runs in the background: a ship takes minutes, and a synchronous mutation
  // would be at the mercy of any proxy's idle timeout. Callers poll.
  run.promise = runShip(run, opts).then((outcome) => {
    run.outcome = outcome;
    run.phase = outcome.ok ? 'done' : outcome.resolution === 'stranded' ? 'stranded' : 'rollback';
    return outcome;
  });
  return { transferId };
}

async function runShip(run: TransferRun, opts: { withData?: boolean }): Promise<ShipOutcome> {
  const { agentId, remoteId } = run;
  let bundlePath: string | null = null;

  const agent = loadAgent(agentId);
  if (!agent) {
    return {
      ok: false,
      phase: 'claim',
      error: 'agent not found',
      kind: 'preflight',
      resolution: 'rolled-back',
    };
  }
  if (agent.isOperator) {
    return {
      ok: false,
      phase: 'claim',
      error: 'helmCaptain manages this fleet and cannot be shipped',
      kind: 'preflight',
      resolution: 'rolled-back',
    };
  }
  const remote = getRemote(remoteId);
  if (!remote) {
    return {
      ok: false,
      phase: 'claim',
      error: 'remote not found',
      kind: 'preflight',
      resolution: 'rolled-back',
    };
  }

  // ── 0. Claim: the mutex, the run-gate close, and the crash marker, in one
  //    conditional write. rowsAffected === 0 means someone else got there first.
  const claimed = db
    .update(agents)
    .set({ deployState: 'shipping', deployedTo: remoteId, deployError: null })
    .where(and(eq(agents.id, agentId), isNull(agents.deployState)))
    .run();
  if (claimed.changes === 0) {
    return {
      ok: false,
      phase: 'claim',
      error: 'this agent is already deployed or mid-transfer',
      kind: 'busy',
      resolution: 'rolled-back',
    };
  }
  step(run, 'claim', `claimed for ship to ${remote.name}`);

  try {
    // ── 1. Preflight. Deliberately after the claim: a failed preflight rolls
    //    back cheaply, whereas preflighting first leaves a window where two
    //    ships both pass.
    step(run, 'preflight', 'checking the remote');
    const info = await fetchRemoteInfo(remote);
    if (majorMinor(info.helmVersion) !== majorMinor(HELM_VERSION)) {
      // A warning is right for ping; for a bundle crossing the seam it is not.
      throw new ShipRefusal(
        'preflight',
        `remote runs helm ${info.helmVersion}, local is ${HELM_VERSION} — upgrade one before shipping`,
        'preflight',
      );
    }
    if (!info.bundleFormats?.includes(BUNDLE_FORMAT_VERSION)) {
      throw new ShipRefusal(
        'preflight',
        info.bundleFormats
          ? `remote accepts bundle formats [${info.bundleFormats.join(', ')}], this helm writes v${BUNDLE_FORMAT_VERSION}`
          : 'remote predates agent transfer (no bundle formats advertised) — upgrade it',
        'preflight',
      );
    }
    if (!info.harnesses.some((h) => h.type === 'claude-code' && h.authOk)) {
      throw new ShipRefusal(
        'preflight',
        'remote has no authenticated claude-code harness — check its OAuth token',
        'preflight',
      );
    }
    if (info.paused) {
      // Shipping into a paused daemon lands an agent that cannot run.
      throw new ShipRefusal(
        'preflight',
        'remote is paused — resume it before shipping',
        'preflight',
      );
    }
    const already = await fetchRemoteAgentStatus(remote, agentId);
    if (already) {
      throw new ShipRefusal('preflight', 'the remote already has this agent', 'conflict');
    }

    // ── 2. Deactivate. The poller-conflict window opens here and closes when
    //    the remote activates: exactly zero pollers hold the bot token, and
    //    Telegram queues updates for 24h, so nothing is lost and nothing is
    //    answered twice.
    step(run, 'deactivate', 'stopping pollers and draining in-flight runs');
    await drainAgentPollers(agentId);
    const drained = await drainAgentRuns(agentId, 120_000);
    if (!drained) {
      throw new ShipRefusal('deactivate', 'agent is still mid-run after 120s — try again', 'busy');
    }

    // ── 3. Export. pollOffset is now settled.
    step(run, 'export', 'building the bundle');
    const exported = await exportAgentBundle(agentId, { withData: opts.withData ?? true });
    bundlePath = exported.path;
    step(run, 'export', `bundle is ${Math.round(exported.bytes / 1024)}KB`);

    // ── 4/5. Upload; the remote imports, activates and smoke-tests in one
    //    request, so the whole far side is a single atomic outcome.
    step(run, 'upload', 'transferring to the remote');
    let response;
    try {
      response = await uploadBundle(remote, exported.path, {
        agentId,
        transferId: run.transferId,
        sha256: exported.sha256,
      });
    } catch (err) {
      // THE AMBIGUOUS CASE. The connection may have died after the remote
      // committed but before its response arrived. Auto-rolling back here is the
      // one move that can produce two live pollers on one bot token, so probe
      // before deciding.
      step(
        run,
        'upload',
        'transfer failed mid-flight — probing the remote to find out what happened',
      );
      const settled = await probeRemoteFor(remote, agentId, 60_000);
      if (settled === true) {
        step(run, 'commit', 'the remote has it after all — committing');
        setDeploy(agentId, { deployState: 'deployed', deployedAt: new Date(), deployError: null });
        return { ok: true, agentId, remoteId };
      }
      if (settled === null) {
        const message = err instanceof Error ? err.message : String(err);
        setDeploy(agentId, { deployState: 'stranded', deployError: message });
        step(run, 'stranded', 'could not determine whether the remote took the agent');
        return {
          ok: false,
          phase: 'upload',
          error: `${message}. The remote could not be reached to confirm, so this agent is marked stranded — check the remote before retrying.`,
          kind: 'ambiguous',
          resolution: 'stranded',
        };
      }
      throw err; // definitively not there → normal rollback
    }

    if (!response.ok) {
      // The remote self-rolled-back before answering, so it is provably clean.
      throw new ShipRefusal(
        'activate',
        response.error ?? 'the remote refused the bundle',
        response.kind === 'conflict' ? 'conflict' : 'bundle',
      );
    }

    // ── 6. Commit. Local gateway/heartbeat rows are KEPT: deployState makes
    //    them inert, and keeping them is what makes recovery non-lossy.
    step(run, 'commit', 'marking deployed');
    setDeploy(agentId, { deployState: 'deployed', deployedAt: new Date(), deployError: null });
    step(run, 'done', `now running on ${remote.name}`);
    return { ok: true, agentId, remoteId, smoke: response.smoke };
  } catch (err) {
    const phase = err instanceof ShipRefusal ? err.phase : run.phase;
    const kind =
      err instanceof ShipRefusal ? err.kind : err instanceof RemoteError ? err.kind : 'bundle';
    const message = err instanceof Error ? err.message : String(err);

    step(run, 'rollback', `reactivating locally: ${message}`);
    setDeploy(agentId, { deployState: null, deployedTo: null, deployError: message });
    reconcileGateways();
    return { ok: false, phase, error: message, kind, resolution: 'rolled-back' };
  } finally {
    if (bundlePath) rmSync(bundlePath, { force: true });
  }
}

// ── recall ──────────────────────────────────────────────────────────────────

export function startRecall(agentId: string): { transferId: string } {
  const existing = transfers.get(agentId);
  if (existing && !existing.outcome) {
    throw new Error(`a ${existing.direction} is already in progress for this agent`);
  }
  const agent = loadAgent(agentId);
  if (!agent) throw new Error('agent not found');
  if (agent.deployState !== 'deployed' || !agent.deployedTo) {
    throw new Error(`"${agent.name}" is not deployed anywhere`);
  }

  const transferId = randomUUID();
  const run: TransferRun = {
    transferId,
    agentId,
    remoteId: agent.deployedTo,
    direction: 'recall',
    phase: 'claim',
    log: [],
    promise: Promise.resolve({} as ShipOutcome),
  };
  transfers.set(agentId, run);
  run.promise = runRecall(run).then((outcome) => {
    run.outcome = outcome;
    run.phase = outcome.ok ? 'done' : outcome.resolution === 'stranded' ? 'stranded' : 'rollback';
    return outcome;
  });
  return { transferId };
}

async function runRecall(run: TransferRun): Promise<ShipOutcome> {
  const { agentId, remoteId } = run;
  const remote = getRemote(remoteId);
  if (!remote) {
    return {
      ok: false,
      phase: 'claim',
      error: 'the remote this agent lives on is no longer registered',
      kind: 'preflight',
      resolution: 'rolled-back',
    };
  }
  let bundlePath: string | null = null;

  setDeploy(agentId, { deployState: 'recalling', deployError: null });
  step(run, 'claim', `recalling from ${remote.name}`);

  try {
    // The remote deactivates itself and streams the bundle back. Its own
    // poller-conflict window opens there and closes when we reactivate here.
    step(run, 'export', 'asking the remote to export');
    const downloaded = await downloadBundle(remote, agentId, run.transferId);
    if ('refused' in downloaded) {
      // The remote reactivated itself before answering.
      setDeploy(agentId, { deployState: 'deployed', deployError: downloaded.refused.error });
      return {
        ok: false,
        phase: 'export',
        error: downloaded.refused.error,
        kind: 'bundle',
        resolution: 'rolled-back',
      };
    }
    bundlePath = downloaded.path;
    step(run, 'upload', `received ${Math.round(downloaded.bytes / 1024)}KB`);

    // The local row still exists (deployState made it inert), so the incoming
    // bundle would collide with it. Remove the shell first; its workspace and
    // data plane are whatever was left behind at ship time and are superseded.
    step(run, 'activate', 'restoring locally');
    const { deleteAgent } = await import('../agents.ts');
    deleteAgent(agentId, { force: true });
    await importAgentBundle(downloaded.path);

    reconcileGateways();
    step(run, 'commit', 'live locally again');

    // Confirm-delete on the remote. A failure here is untidy, not harmful: the
    // remote copy is deactivated (its own deployState is 'recalling'), so it is
    // not polling. sweepRecallOrphans retries.
    try {
      await deleteRemoteAgent(remote, agentId);
      step(run, 'done', 'removed from the remote');
    } catch (err) {
      step(run, 'done', `recalled, but the remote copy still needs deleting: ${String(err)}`);
    }
    return { ok: true, agentId, remoteId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = err instanceof RemoteError ? err.kind : 'bundle';
    // The local side could not restore the agent; the remote still has it.
    setDeploy(agentId, { deployState: 'stranded', deployError: message });
    step(run, 'stranded', message);
    return { ok: false, phase: run.phase, error: message, kind, resolution: 'stranded' };
  } finally {
    if (bundlePath) rmSync(bundlePath, { force: true });
  }
}

// ── recovery ────────────────────────────────────────────────────────────────

/**
 * Probe whether a remote ended up with the agent. Returns true/false when it can
 * tell, or null if the remote stayed unreachable for the whole window.
 */
async function probeRemoteFor(
  remote: NonNullable<ReturnType<typeof getRemote>>,
  agentId: string,
  windowMs: number,
): Promise<boolean | null> {
  const deadline = Date.now() + windowMs;
  let delay = 2_000;
  let reachedOnce = false;
  while (Date.now() < deadline) {
    try {
      const status = await fetchRemoteAgentStatus(remote, agentId);
      reachedOnce = true;
      return status !== null;
    } catch {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  }
  return reachedOnce ? false : null;
}

/**
 * Called at boot. An interrupted transfer left the agent deactivated (which is
 * the safe half); this decides whether it belongs here or on the remote.
 *
 * Fire-and-forget, and must never throw into the boot path —
 * `ensureRuntimeStarted` un-sets its guard flag if it does.
 */
export async function recoverInterruptedTransfers(): Promise<void> {
  const stuck = db
    .select()
    .from(agents)
    .where(and(isNotNull(agents.deployState), isNotNull(agents.deployedTo)))
    .all()
    .filter((a) => a.deployState === 'shipping' || a.deployState === 'recalling');

  for (const agent of stuck) {
    try {
      const remote = agent.deployedTo ? getRemote(agent.deployedTo) : null;
      if (!remote) continue;
      const there = await probeRemoteFor(remote, agent.id, 20_000);
      if (there === true) {
        setDeploy(agent.id, { deployState: 'deployed', deployedAt: new Date() });
        console.log(`[helm] recovered ${agent.name}: the remote has it — marked deployed`);
      } else if (there === false) {
        setDeploy(agent.id, { deployState: null, deployedTo: null });
        reconcileGateways();
        console.log(`[helm] recovered ${agent.name}: the remote does not have it — reactivated`);
      } else {
        setDeploy(agent.id, {
          deployState: 'stranded',
          deployError: 'the remote was unreachable at boot; outcome unknown',
        });
        console.error(`[helm] ${agent.name} is stranded — the remote could not be reached`);
      }
    } catch (err) {
      console.error(`[helm] transfer recovery failed for ${agent.id}:`, String(err));
    }
  }
}

/**
 * Operator decision for a stranded agent. There is no safe automatic answer:
 * choosing wrong in one direction leaves the agent dead, and in the other leaves
 * two pollers on one bot token.
 */
export function resolveStranded(agentId: string, decision: 'deployed' | 'local'): Agent {
  const agent = loadAgent(agentId);
  if (!agent) throw new Error('agent not found');
  if (agent.deployState !== 'stranded') throw new Error(`"${agent.name}" is not stranded`);

  if (decision === 'deployed') {
    setDeploy(agentId, { deployState: 'deployed', deployedAt: new Date(), deployError: null });
  } else {
    setDeploy(agentId, { deployState: null, deployedTo: null, deployError: null });
    reconcileGateways();
  }
  return loadAgent(agentId)!;
}

/** Custom refusal so a phase and kind travel with the message. */
class ShipRefusal extends Error {
  constructor(
    readonly phase: ShipPhase,
    message: string,
    readonly kind: 'preflight' | 'conflict' | 'bundle' | 'busy',
  ) {
    super(message);
    this.name = 'ShipRefusal';
  }
}

function majorMinor(v: string): string {
  return v.split('.').slice(0, 2).join('.');
}
