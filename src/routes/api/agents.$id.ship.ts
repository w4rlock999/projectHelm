import { createFileRoute } from '@tanstack/react-router';
import { loadAgent } from '../../server/agents.ts';
import { getRemote } from '../../server/remotes/index.ts';
import { startRecall, startShip, transferStatus } from '../../server/remotes/ship.ts';
import { ensureRuntimeStarted } from '../../server/runtime/index.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

type P = RouteParams<'/api/agents/$id/ship'>;

// /api/agents/$id/ship — the captain's surface onto ship & recall.
//   POST { remoteId, withoutData? }  → start a ship
//   POST { recall: true }            → start a recall
//   GET                              → poll the transfer's phase log
//
// Transfers are asynchronous: POST returns a transferId immediately and GET
// reports progress, because a ship can take minutes.
export const Route = createFileRoute('/api/agents/$id/ship')({
  server: {
    handlers: {
      GET: ({ params }: ApiHandlerCtx<P>) => {
        const agent = loadAgent(params.id);
        if (!agent) return Response.json({ error: 'agent not found' }, { status: 404 });
        return Response.json({
          deployState: agent.deployState,
          deployedTo: agent.deployedTo,
          deployError: agent.deployError,
          transfer: transferStatus(params.id),
        });
      },

      POST: async ({ params, request }: ApiHandlerCtx<P>) => {
        ensureRuntimeStarted();
        const agent = loadAgent(params.id);
        if (!agent) return Response.json({ error: 'agent not found' }, { status: 404 });

        const body = (await request.json().catch(() => ({}))) as {
          remoteId?: string;
          withoutData?: boolean;
          recall?: boolean;
        };

        try {
          if (body.recall) return Response.json(startRecall(params.id));
          if (!body.remoteId) {
            return Response.json({ error: 'remoteId is required' }, { status: 400 });
          }
          if (!getRemote(body.remoteId)) {
            return Response.json({ error: 'remote not found' }, { status: 404 });
          }
          return Response.json(
            startShip(params.id, body.remoteId, { withData: !body.withoutData }),
          );
        } catch (err) {
          // Already transferring, or not deployed — status, not a crash.
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 409 },
          );
        }
      },
    },
  },
});
