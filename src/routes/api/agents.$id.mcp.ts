import { createFileRoute } from '@tanstack/react-router';
import { loadAgent } from '../../server/agents.ts';
import {
  assignMcpServer,
  getMcpServer,
  listAgentMcpServers,
  redactMcpServer,
} from '../../server/library/mcp.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

type P = RouteParams<'/api/agents/$id/mcp'>;

// /api/agents/$id/mcp — the MCP servers assigned to an agent. A leaf sibling
// of info/tools/harness — never a bare /api/agents/$id parent.
//   GET  → assigned servers, redacted
//   POST { serverId } → assign (`helm mcp assign <serverId> --agent <id>`)
export const Route = createFileRoute('/api/agents/$id/mcp')({
  server: {
    handlers: {
      GET: ({ params }: ApiHandlerCtx<P>) => {
        if (!loadAgent(params.id)) {
          return Response.json({ error: 'agent not found' }, { status: 404 });
        }
        return Response.json(listAgentMcpServers(params.id).map(redactMcpServer));
      },

      POST: async ({ params, request }: ApiHandlerCtx<P>) => {
        if (!loadAgent(params.id)) {
          return Response.json({ error: 'agent not found' }, { status: 404 });
        }
        let body: { serverId?: string };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }
        if (!body.serverId) {
          return Response.json({ error: 'serverId is required' }, { status: 400 });
        }
        if (!getMcpServer(body.serverId)) {
          return Response.json({ error: 'mcp server not found in library' }, { status: 404 });
        }
        assignMcpServer(params.id, body.serverId);
        return Response.json({ ok: true, agentId: params.id, serverId: body.serverId });
      },
    },
  },
});
