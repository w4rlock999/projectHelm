import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  assignMcpServer,
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listAgentMcpServerIds,
  listMcpServers,
  redactMcpServer,
  unassignMcpServer,
  updateMcpServer,
} from '../../library/mcp.ts';
import {
  LibraryNameSchema,
  McpServerConfigSchema,
  McpServerError,
  McpServerInputSchema,
  RuntimeSchema,
} from '../../library/mcp-schema.ts';
import { publicProcedure, router } from '../init.ts';

/** A duplicate name or a marker with nothing behind it is the operator's mistake. */
function bad<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof McpServerError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
    }
    throw err;
  }
}

// The MCP server library. Every read goes through redactMcpServer: env and
// header values never reach the browser.
export const mcpRouter = router({
  list: publicProcedure.query(() => listMcpServers().map(redactMcpServer)),

  get: publicProcedure.input(z.object({ id: z.string().uuid() })).query(({ input }) => {
    const s = getMcpServer(input.id);
    if (!s) throw new TRPCError({ code: 'NOT_FOUND' });
    return redactMcpServer(s);
  }),

  create: publicProcedure
    .input(McpServerInputSchema.extend({ assignTo: z.array(z.string().uuid()).optional() }))
    .mutation(({ input }) => {
      const { assignTo, ...def } = input;
      const row = bad(() => createMcpServer(def));
      for (const agentId of assignTo ?? []) assignMcpServer(agentId, row.id);
      return redactMcpServer(row);
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: LibraryNameSchema.optional(),
        description: z.string().trim().min(1).max(500).optional(),
        /** A full config; `<set>` values keep the stored secret for that key. */
        config: McpServerConfigSchema.optional(),
        requires: z.array(RuntimeSchema).optional(),
      }),
    )
    .mutation(({ input }) => {
      const { id, ...patch } = input;
      const updated = bad(() => updateMcpServer(id, patch));
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND' });
      return redactMcpServer(updated);
    }),

  delete: publicProcedure.input(z.object({ id: z.string().uuid() })).mutation(({ input }) => {
    if (!deleteMcpServer(input.id)) throw new TRPCError({ code: 'NOT_FOUND' });
    return { id: input.id };
  }),

  /** The library tagged with whether each server is assigned to the agent. */
  forAgent: publicProcedure.input(z.object({ agentId: z.string().uuid() })).query(({ input }) => {
    const assigned = new Set(listAgentMcpServerIds(input.agentId));
    return listMcpServers().map((s) => ({ ...redactMcpServer(s), assigned: assigned.has(s.id) }));
  }),

  assign: publicProcedure
    .input(z.object({ agentId: z.string().uuid(), serverId: z.string().uuid() }))
    .mutation(({ input }) => {
      if (!getMcpServer(input.serverId)) throw new TRPCError({ code: 'NOT_FOUND' });
      assignMcpServer(input.agentId, input.serverId);
      return { ok: true };
    }),

  unassign: publicProcedure
    .input(z.object({ agentId: z.string().uuid(), serverId: z.string().uuid() }))
    .mutation(({ input }) => {
      unassignMcpServer(input.agentId, input.serverId);
      return { ok: true };
    }),
});
