import { createFileRoute } from '@tanstack/react-router';
import { unassignTool } from '../../server/tools.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

// DELETE /api/agents/$id/tools/$toolId — unassign a library tool from an agent.
// Write surface for `helm tool unassign <toolId> --agent <id>`.
export const Route = createFileRoute('/api/agents/$id/tools/$toolId')({
  server: {
    handlers: {
      DELETE: ({ params }: ApiHandlerCtx<RouteParams<'/api/agents/$id/tools/$toolId'>>) => {
        unassignTool(params.id, params.toolId);
        return Response.json({ ok: true, agentId: params.id, toolId: params.toolId });
      },
    },
  },
});
