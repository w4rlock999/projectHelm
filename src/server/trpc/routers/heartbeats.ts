import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  createHeartbeat,
  deleteHeartbeat,
  listHeartbeats,
  updateHeartbeat,
} from '../../runtime/heartbeats.ts';
import { isValidCron } from '../../cron.ts';
import { publicProcedure, router } from '../init.ts';

const cronField = z.string().refine(
  (v) => {
    try {
      return isValidCron(v);
    } catch {
      return false;
    }
  },
  { message: 'invalid 5-field cron expression' },
);

export const heartbeatsRouter = router({
  list: publicProcedure
    .input(z.object({ agentId: z.string().uuid() }))
    .query(({ input }) => listHeartbeats(input.agentId)),

  create: publicProcedure
    .input(
      z.object({
        agentId: z.string().uuid(),
        name: z.string().max(80).nullish(),
        cron: cronField,
        prompt: z.string().min(1),
        targetType: z.enum(['main', 'chat']).optional(),
        targetChatId: z.string().nullish(),
      }),
    )
    .mutation(({ input }) => createHeartbeat(input)),

  update: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().max(80).optional(),
        cron: cronField.optional(),
        prompt: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        targetType: z.enum(['main', 'chat']).optional(),
        targetChatId: z.string().nullish(),
      }),
    )
    .mutation(({ input }) => {
      const { id, ...patch } = input;
      const updated = updateHeartbeat(id, patch);
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND' });
      return updated;
    }),

  delete: publicProcedure.input(z.object({ id: z.string().uuid() })).mutation(({ input }) => {
    if (!deleteHeartbeat(input.id)) throw new TRPCError({ code: 'NOT_FOUND' });
    return { id: input.id };
  }),
});
