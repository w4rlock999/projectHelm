import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  assignTool,
  createLibraryTool,
  deleteLibraryTool,
  listAgentToolIds,
  listLibraryTools,
  unassignTool,
  updateLibraryTool,
} from '../../tools.ts'
import { publicProcedure, router } from '../init.ts'

const interpreterSchema = z.enum(['bash', 'sh', 'node', 'python3'])

export const toolsRouter = router({
  // The shared tool library (definitions, owned by no agent).
  list: publicProcedure.query(() => listLibraryTools()),

  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        description: z.string().min(1).max(500),
        interpreter: interpreterSchema.default('bash'),
        source: z.string().min(1),
        // Optionally assign to agents on creation (author-and-assign flow).
        assignTo: z.array(z.string().uuid()).optional(),
      }),
    )
    .mutation(({ input }) => {
      const { assignTo, ...def } = input
      const tool = createLibraryTool(def)
      for (const agentId of assignTo ?? []) assignTool(agentId, tool.id)
      return tool
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(80).optional(),
        description: z.string().min(1).max(500).optional(),
        interpreter: interpreterSchema.optional(),
        source: z.string().min(1).optional(),
      }),
    )
    .mutation(({ input }) => {
      const { id, ...patch } = input
      const updated = updateLibraryTool(id, patch)
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND' })
      return updated
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ input }) => {
      if (!deleteLibraryTool(input.id)) throw new TRPCError({ code: 'NOT_FOUND' })
      return { id: input.id }
    }),

  // Library tools tagged with whether they're assigned to a given agent —
  // powers the per-agent assignment UI.
  forAgent: publicProcedure
    .input(z.object({ agentId: z.string().uuid() }))
    .query(({ input }) => {
      const assigned = new Set(listAgentToolIds(input.agentId))
      return listLibraryTools().map((t) => ({ ...t, assigned: assigned.has(t.id) }))
    }),

  assign: publicProcedure
    .input(z.object({ agentId: z.string().uuid(), toolId: z.string().uuid() }))
    .mutation(({ input }) => {
      assignTool(input.agentId, input.toolId)
      return { ok: true }
    }),

  unassign: publicProcedure
    .input(z.object({ agentId: z.string().uuid(), toolId: z.string().uuid() }))
    .mutation(({ input }) => {
      unassignTool(input.agentId, input.toolId)
      return { ok: true }
    }),
})
