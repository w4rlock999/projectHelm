import { createFileRoute } from '@tanstack/react-router';
import { unassignMcpServer } from '../../server/library/mcp.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

// DELETE /api/agents/$id/mcp/$serverId — unassign an MCP server from an agent.
// Write surface for `helm mcp unassign <serverId> --agent <id>`.
export const Route = createFileRoute('/api/agents/$id/mcp/$serverId')({
  server: {
    handlers: {
      DELETE: ({ params }: ApiHandlerCtx<RouteParams<'/api/agents/$id/mcp/$serverId'>>) => {
        unassignMcpServer(params.id, params.serverId);
        return Response.json({ ok: true, agentId: params.id, serverId: params.serverId });
      },
    },
  },
});
