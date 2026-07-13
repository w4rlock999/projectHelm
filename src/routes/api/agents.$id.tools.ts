import { createFileRoute } from '@tanstack/react-router';
import { loadAgent } from '../../server/agents.ts';
import { assignTool, getLibraryTool } from '../../server/tools.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

// POST /api/agents/$id/tools { toolId } — assign a library tool to an agent.
// Write surface for `helm tool assign <toolId> --agent <id>`.
export const Route = createFileRoute('/api/agents/$id/tools')({
  server: {
    handlers: {
      POST: async ({ params, request }: ApiHandlerCtx<RouteParams<'/api/agents/$id/tools'>>) => {
        if (!loadAgent(params.id)) {
          return Response.json({ error: 'agent not found' }, { status: 404 });
        }
        let body: { toolId?: string };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }
        if (!body.toolId) return Response.json({ error: 'toolId is required' }, { status: 400 });
        if (!getLibraryTool(body.toolId)) {
          return Response.json({ error: 'tool not found in library' }, { status: 404 });
        }
        assignTool(params.id, body.toolId);
        return Response.json({ ok: true, agentId: params.id, toolId: body.toolId });
      },
    },
  },
});
