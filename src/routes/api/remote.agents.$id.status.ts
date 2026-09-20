import { createFileRoute } from '@tanstack/react-router';
import { loadAgent } from '../../server/agents.ts';
import { isImportInFlight } from '../../server/bundle/inflight.ts';
import { budgetUsage, listRuns } from '../../server/runs.ts';
import { listAgentChats, listGateways } from '../../server/runtime/gateways.ts';
import { listHeartbeats } from '../../server/runtime/heartbeats.ts';
import { getPauseState } from '../../server/runtime/pause.ts';
import { ensureRuntimeStarted } from '../../server/runtime/index.ts';
import { requirePairing } from '../../server/remote-auth.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

type P = RouteParams<'/api/remote/agents/$id/status'>;

// /api/remote/agents/$id/status — what the local console shows for a deployed
// agent without recalling it: heartbeats, gateways, recent runs, budget.
//
// A 404 here is also how ship preflight checks that the target does not already
// hold this agent, so the status code matters as much as the body.
export const Route = createFileRoute('/api/remote/agents/$id/status')({
  server: {
    handlers: {
      GET: ({ params, request }: ApiHandlerCtx<P>) => {
        const denied = requirePairing(request);
        if (denied) return denied;
        ensureRuntimeStarted();

        // An import in progress is neither present nor absent: the row may
        // exist, but the smoke turn has not yet decided whether it stays. A
        // shipper probing after a lost response must wait on this, because
        // concluding "the remote has it" here and then watching this daemon
        // self-roll-back leaves a deployed-but-dead agent.
        if (isImportInFlight(params.id)) {
          return Response.json({ ok: false, pending: true }, { status: 202 });
        }

        const a = loadAgent(params.id);
        if (!a) return Response.json({ error: 'agent not found' }, { status: 404 });

        return Response.json({
          ok: true,
          paused: getPauseState().paused,
          agent: {
            id: a.id,
            name: a.name,
            model: a.model,
            sessionScope: a.sessionScope,
            sessionRecall: a.sessionRecall,
            deployState: a.deployState,
            runBudgetPerHour: a.runBudgetPerHour,
            createdAt: a.createdAt,
          },
          // What this daemon's CLI loaded on the agent's last turn here — the
          // observed side of the local console's harness parity row. Names and
          // statuses only (see fingerprint.ts), so safe to return.
          lastHarness: a.lastHarness,
          budget: budgetUsage(a.id),
          heartbeats: listHeartbeats(a.id).map((h) => ({
            id: h.id,
            name: h.name,
            cron: h.cron,
            enabled: h.enabled,
            targetType: h.targetType,
            lastRunAt: h.lastRunAt,
          })),
          // Tokens are secret — never returned, even to the paired operator.
          gateways: listGateways(a.id).map((g) => ({
            id: g.id,
            type: g.type,
            enabled: g.enabled,
            pollOffset: g.pollOffset,
          })),
          chats: listAgentChats(a.id).map((c) => ({
            id: c.id,
            chatId: c.chatId,
            title: c.title,
            status: c.status,
            lastMessageAt: c.lastMessageAt,
          })),
          runs: listRuns(a.id, 20).map((r) => ({
            id: r.id,
            source: r.source,
            status: r.status,
            refusedReason: r.refusedReason,
            prompt: r.prompt,
            resultText: r.resultText,
            startedAt: r.startedAt,
            endedAt: r.endedAt,
          })),
        });
      },
    },
  },
});
