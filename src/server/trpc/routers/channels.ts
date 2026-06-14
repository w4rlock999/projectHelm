import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  createChannel,
  deleteChannel,
  listChannels,
  updateChannel,
} from '../../runtime/channels.ts'
import { getMe } from '../../channels/telegram.ts'
import { publicProcedure, router } from '../init.ts'

export const channelsRouter = router({
  list: publicProcedure
    .input(z.object({ agentId: z.string().uuid() }))
    .query(({ input }) => listChannels(input.agentId)),

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
        chatId: z.string().nullish(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await createChannel(input)
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
        chatId: z.string().nullish(),
      }),
    )
    .mutation(({ input }) => {
      const { id, ...patch } = input
      const updated = updateChannel(id, patch)
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND' })
      return updated
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ input }) => {
      const agentId = deleteChannel(input.id)
      if (!agentId) throw new TRPCError({ code: 'NOT_FOUND' })
      return { id: input.id }
    }),
})
