import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { listOps } from '../../machine/ledger.ts';
import { runRemoteCheck } from '../../machine/check.ts';
import {
  addRemote,
  agentsDeployedTo,
  listRemotes,
  pauseRemote,
  pingRemote,
  removeRemote,
  updateRemote,
} from '../../remotes/index.ts';
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
        sshIdentityFile: z.string().nullish(),
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

  /** Rename, or attach/clear the saved identity file (handshaken before saving). */
  update: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(120).optional(),
        sshIdentityFile: z.string().nullish(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      try {
        const result = await updateRemote(id, patch);
        if (!result) throw new TRPCError({ code: 'NOT_FOUND' });
        return result;
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  /** The machine parity report — status, so an unreachable remote is a failed row, not a throw. */
  check: publicProcedure
    .input(z.object({ id: z.string().uuid(), agentId: z.string().uuid().optional() }))
    .mutation(async ({ input }) => {
      const report = await runRemoteCheck(input.id, { agentId: input.agentId });
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
      return report;
    }),

  /** What helm ran on that remote, newest first. */
  ops: publicProcedure
    .input(z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(200).optional() }))
    .query(({ input }) => listOps(input.id, input.limit)),

  remove: publicProcedure.input(z.object({ id: z.string().uuid() })).mutation(({ input }) => {
    try {
      if (!removeRemote(input.id)) throw new TRPCError({ code: 'NOT_FOUND' });
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      // Agents are still deployed there — status, not a crash.
      throw new TRPCError({
        code: 'CONFLICT',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return { id: input.id };
  }),

  /** Agents this helm believes live on a given remote. */
  deployedAgents: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ input }) => agentsDeployedTo(input.id)),

  setPaused: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        paused: z.boolean(),
        reason: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const result = await pauseRemote(input.id, input.paused, input.reason);
      if (!result) throw new TRPCError({ code: 'NOT_FOUND' });
      return result;
    }),

  ping: publicProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    const result = await pingRemote(input.id);
    if (!result) throw new TRPCError({ code: 'NOT_FOUND' });
    return result;
  }),
});
