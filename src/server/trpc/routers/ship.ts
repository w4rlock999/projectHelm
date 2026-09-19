import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { loadAgent } from '../../agents.ts';
import { getRemote } from '../../remotes/index.ts';
import { resolveStranded, startRecall, startShip, transferStatus } from '../../remotes/ship.ts';
import { fetchRemoteAgentStatus, IMPORT_PENDING } from '../../remotes/transfer.ts';
import { publicProcedure, router } from '../init.ts';

const agentInput = z.object({ agentId: z.string().uuid() });

// Ship & recall. Transfers run in the background and are polled via `status` —
// a ship takes minutes, so a mutation that waited for it would be at the mercy
// of any proxy's idle timeout.
export const shipRouter = router({
  ship: publicProcedure
    .input(
      z.object({
        agentId: z.string().uuid(),
        remoteId: z.string().uuid(),
        withoutData: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) => {
      if (!loadAgent(input.agentId)) throw new TRPCError({ code: 'NOT_FOUND' });
      if (!getRemote(input.remoteId)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'remote not found' });
      }
      try {
        return startShip(input.agentId, input.remoteId, { withData: !input.withoutData });
      } catch (err) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  recall: publicProcedure.input(agentInput).mutation(({ input }) => {
    try {
      return startRecall(input.agentId);
    } catch (err) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }),

  status: publicProcedure.input(agentInput).query(({ input }) => transferStatus(input.agentId)),

  /** What the remote says about a deployed agent. `{ ok: false }`, not a throw. */
  remoteStatus: publicProcedure.input(agentInput).query(async ({ input }) => {
    const agent = loadAgent(input.agentId);
    if (!agent) throw new TRPCError({ code: 'NOT_FOUND' });
    if (!agent.deployedTo) return { ok: false as const, error: 'not deployed', kind: 'local' };
    const remote = getRemote(agent.deployedTo);
    if (!remote) return { ok: false as const, error: 'remote not registered', kind: 'missing' };
    try {
      const status = await fetchRemoteAgentStatus(remote, input.agentId);
      if (status === IMPORT_PENDING) {
        return {
          ok: false as const,
          error: 'the remote is still importing this agent',
          kind: 'pending',
        };
      }
      if (!status) {
        return {
          ok: false as const,
          error: 'the remote does not have this agent',
          kind: 'missing',
        };
      }
      return { ok: true as const, status };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
        kind: 'unreachable',
      };
    }
  }),

  resolve: publicProcedure
    .input(z.object({ agentId: z.string().uuid(), decision: z.enum(['deployed', 'local']) }))
    .mutation(({ input }) => {
      try {
        return resolveStranded(input.agentId, input.decision);
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
});
