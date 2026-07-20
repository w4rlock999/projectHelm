import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { addRemote, listRemotes, pingRemote, removeRemote } from '../../remotes/index.ts';
import { publicProcedure, router } from '../init.ts';

export const remotesRouter = router({
  list: publicProcedure.query(() => listRemotes()),

  // Performs the first handshake before saving — a bad code/target never
  // creates a row. Accepts a pasted connect code or the individual fields.
  add: publicProcedure
    .input(
      z.object({
        name: z.string().optional(),
        connectCode: z.string().optional(),
        sshTarget: z.string().optional(),
        helmPort: z.number().int().positive().optional(),
        token: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await addRemote(input);
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  remove: publicProcedure.input(z.object({ id: z.string().uuid() })).mutation(({ input }) => {
    if (!removeRemote(input.id)) throw new TRPCError({ code: 'NOT_FOUND' });
    return { id: input.id };
  }),

  ping: publicProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    const result = await pingRemote(input.id);
    if (!result) throw new TRPCError({ code: 'NOT_FOUND' });
    return result;
  }),
});
