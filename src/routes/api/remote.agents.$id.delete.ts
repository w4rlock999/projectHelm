import { createFileRoute } from '@tanstack/react-router';
import { deleteAgent, loadAgent } from '../../server/agents.ts';
import { requirePairing } from '../../server/remote-auth.ts';
import { reconcileGateways } from '../../server/runtime/gateways.ts';
import { ensureRuntimeStarted } from '../../server/runtime/index.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

type P = RouteParams<'/api/remote/agents/$id/delete'>;

// /api/remote/agents/$id/delete — the confirm-delete at the end of a recall.
//
// A leaf sibling rather than DELETE /api/remote/agents/$id, because a bare $id
// route would reparent status/export and break their param typing.
//
// Refuses unless this daemon has already marked the agent 'recalling'. Without
// that check a stray call could delete a live remote agent, and there is no
// undo — deleteAgent removes the workspace and the whole data plane.
export const Route = createFileRoute('/api/remote/agents/$id/delete')({
  server: {
    handlers: {
      POST: ({ params, request }: ApiHandlerCtx<P>) => {
        const denied = requirePairing(request);
        if (denied) return denied;
        ensureRuntimeStarted();

        const agent = loadAgent(params.id);
        if (!agent) {
          // Already gone: the recall succeeded and this is a retry. Idempotent.
          return Response.json({ ok: true, alreadyGone: true });
        }
        if (agent.deployState !== 'recalling') {
          return Response.json({
            ok: false,
            kind: 'conflict',
            error: `"${agent.name}" is not being recalled (deployState=${agent.deployState ?? 'null'}) — refusing to delete`,
          });
        }
        deleteAgent(params.id, { force: true });
        reconcileGateways();
        return Response.json({ ok: true, id: params.id });
      },
    },
  },
});
