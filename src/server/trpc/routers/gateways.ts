import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  createGateway,
  deleteGateway,
  listAgentChats,
  listGateways,
  setChatStatus,
  updateGateway,
} from '../../runtime/gateways.ts'
import { getMe } from '../../gateways/telegram.ts'
import { publicProcedure, router } from '../init.ts'

export const gatewaysRouter = router({
  list: publicProcedure
    .input(z.object({ agentId: z.string().uuid() }))
    .query(({ input }) => listGateways(input.agentId)),

  // Validate a token without persisting — powers the wizard's "Verify" step.
  verifyToken: publicProcedure
    .input(z.object({ token: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        const me = await getMe(input.token)
        return { ok: true as const, username: me.username, name: me.first_name }
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    }),

  create: publicProcedure
    .input(
      z.object({
        agentId: z.string().uuid(),
        token: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await createGateway(input)
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        enabled: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) => {
      const { id, ...patch } = input
      const updated = updateGateway(id, patch)
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND' })
      return updated
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ input }) => {
      const agentId = deleteGateway(input.id)
      if (!agentId) throw new TRPCError({ code: 'NOT_FOUND' })
      return { id: input.id }
    }),

  // ── Chats (conversations under an agent's gateways) ────────────────────

  chats: publicProcedure
    .input(z.object({ agentId: z.string().uuid() }))
    .query(({ input }) => listAgentChats(input.agentId)),

  updateChat: publicProcedure
    .input(z.object({ id: z.string().uuid(), status: z.enum(['active', 'blocked']) }))
    .mutation(({ input }) => {
      const updated = setChatStatus(input.id, input.status)
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND' })
      return updated
    }),
})
