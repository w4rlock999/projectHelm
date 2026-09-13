import { isNull } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { agents, type Agent } from '../db/schema.ts';

// Ownership: which agents does THIS daemon run?
//
// helmship uses move semantics — an agent lives in exactly one place. That rule
// is enforced by a single column (`agents.deployState`) read from three places:
// the run gate (src/server/runs.ts), the gateway poller reconciler, and the
// heartbeat tick. This module is a leaf so all three can import it without a
// cycle; it deliberately holds no other logic.
//
// The reason the check must be a persisted column rather than in-memory state:
// a ship deactivates the agent locally *before* the remote takes over, and if
// the local process dies inside that window it must come back with the agent
// still deactivated. Otherwise the local poller and the remote poller both hold
// the same Telegram bot token and every message gets answered twice.

/** Non-null values of `agents.deployState`. null means "locally live". */
export type DeployState = 'shipping' | 'deployed' | 'recalling' | 'stranded';

export const DEPLOY_STATES: readonly DeployState[] = [
  'shipping',
  'deployed',
  'recalling',
  'stranded',
];

/**
 * The one predicate. A null `deployState` means this daemon owns the agent and
 * may run it; anything else means hands off.
 *
 * Pure, so the schedulers' filters can be unit-tested without a database.
 */
export function isLocallyLive(a: Pick<Agent, 'deployState'>): boolean {
  return a.deployState === null;
}

/**
 * Ids of the agents this daemon owns. One query per scheduler tick — both the
 * heartbeat tick and `reconcileGateways()` re-read their whole table anyway,
 * so this adds a single indexed lookup rather than a per-row one.
 */
export function localAgentIds(): Set<string> {
  const rows = db.select({ id: agents.id }).from(agents).where(isNull(agents.deployState)).all();
  return new Set(rows.map((r) => r.id));
}

/**
 * Why a run against this agent must be refused, or null if it may proceed.
 * The two reasons are distinct because the operator-facing messages differ: a
 * settled remote agent is working as intended, a transfer is transient.
 */
export function deployRefusal(a: Pick<Agent, 'deployState'>): 'deployed' | 'transferring' | null {
  if (a.deployState === null) return null;
  return a.deployState === 'deployed' ? 'deployed' : 'transferring';
}
