import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  deleteMcpServer,
  getMcpServer,
  redactMcpServer,
  updateMcpServer,
} from '../../server/library/mcp.ts';
import {
  LibraryNameSchema,
  McpServerConfigSchema,
  McpServerError,
  RuntimeSchema,
} from '../../server/library/mcp-schema.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

type P = RouteParams<'/api/mcp/$id'>;

const PatchSchema = z.object({
  name: LibraryNameSchema.optional(),
  description: z.string().trim().min(1).max(500).optional(),
  /** A full config; `<set>` values keep the stored secret for that key. */
  config: McpServerConfigSchema.optional(),
  requires: z.array(RuntimeSchema).optional(),
});

// /api/mcp/$id — one library MCP server.
//   GET    → redacted view (`helm mcp get`)
//   PATCH  → update (`helm mcp set`) — re-renders every agent that has it
//   DELETE → remove (`helm mcp rm`) — unassigned from every agent (cascade)
export const Route = createFileRoute('/api/mcp/$id')({
  server: {
    handlers: {
      GET: ({ params }: ApiHandlerCtx<P>) => {
        const s = getMcpServer(params.id);
        if (!s) return Response.json({ error: 'mcp server not found' }, { status: 404 });
        return Response.json(redactMcpServer(s));
      },

      PATCH: async ({ params, request }: ApiHandlerCtx<P>) => {
        if (!getMcpServer(params.id)) {
          return Response.json({ error: 'mcp server not found' }, { status: 404 });
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }
        const parsed = PatchSchema.safeParse(body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return Response.json(
            { error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` },
            { status: 400 },
          );
        }
        try {
          const updated = updateMcpServer(params.id, parsed.data);
          return Response.json(redactMcpServer(updated!));
        } catch (err) {
          if (err instanceof McpServerError) {
            return Response.json({ error: err.message }, { status: 400 });
          }
          throw err;
        }
      },

      DELETE: ({ params }: ApiHandlerCtx<P>) => {
        if (!deleteMcpServer(params.id)) {
          return Response.json({ error: 'mcp server not found' }, { status: 404 });
        }
        return Response.json({ ok: true, id: params.id });
      },
    },
  },
});
