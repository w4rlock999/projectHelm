// Agents whose import this daemon is still working on: spooled, extracted,
// possibly committed, but not yet through the smoke turn that decides whether
// the import stands or self-rolls-back.
//
// Why this exists: the import route holds its response until the smoke turn
// ends, and that can outlast the shipping side's stall timeout. When that
// happens the shipper probes `/api/remote/agents/:id/status`, which answers
// 200 the moment the row exists — i.e. *during* the smoke turn — and the
// shipper commits `deployed` while this side is about to delete the agent
// again. Not a double poller, but a silently dead agent that a later recall
// then strands. The status route answers 202 for anything in this set, and the
// shipper treats 202 as "keep waiting".
//
// Same globalThis registry pattern as the pollers and transfers, so HMR and
// repeated imports do not fork the set.
const inflight: Set<string> =
  (globalThis as any).__helmImportsInFlight ??
  ((globalThis as any).__helmImportsInFlight = new Set());

export function markImportInFlight(agentId: string): void {
  inflight.add(agentId);
}

export function clearImportInFlight(agentId: string): void {
  inflight.delete(agentId);
}

export function isImportInFlight(agentId: string): boolean {
  return inflight.has(agentId);
}
