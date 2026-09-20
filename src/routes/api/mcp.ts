import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { loadAgent } from '../../server/agents.ts';
import {
  assignMcpServer,
  createMcpServer,
  listMcpServers,
  redactMcpServer,
} from '../../server/library/mcp.ts';
import {
  McpServerError,
  McpServerInputSchema,
  missingRuntimes,
} from '../../server/library/mcp-schema.ts';
import { localHarnessInfo } from '../../server/remote-info.ts';
import type { ApiHandlerCtx } from '../../server/api-route.ts';

const CreateSchema = McpServerInputSchema.extend({
  assignTo: z.array(z.string().uuid()).optional(),
});

// /api/mcp — the MCP server library.
//   GET  → list, redacted (read surface for `helm mcp ls`)
//   POST → add a server, optional assignTo (write surface for `helm mcp add`)
export const Route = createFileRoute('/api/mcp')({
  server: {
    handlers: {
      GET: () => Response.json(listMcpServers().map(redactMcpServer)),

      POST: async ({ request }: ApiHandlerCtx) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }
        const parsed = CreateSchema.safeParse(body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return Response.json(
            { error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` },
            { status: 400 },
          );
        }
        const { assignTo, ...def } = parsed.data;

        let row;
        try {
          row = createMcpServer(def);
        } catch (err) {
          if (err instanceof McpServerError) {
            return Response.json({ error: err.message }, { status: 400 });
          }
          throw err;
        }
        const assignedTo: string[] = [];
        for (const agentId of assignTo ?? []) {
          if (loadAgent(agentId)) {
            assignMcpServer(agentId, row.id);
            assignedTo.push(agentId);
          }
        }
        // Say now if this machine cannot start it, rather than at the agent's
        // next turn as a `failed` server in the fingerprint.
        const runtimes = (await localHarnessInfo()).runtimes;
        const runtimesMissing = runtimes ? missingRuntimes(row.requires, runtimes) : [];
        return Response.json(
          { ...redactMcpServer(row), assignedTo, runtimesMissing },
          { status: 201 },
        );
      },
    },
  },
});
