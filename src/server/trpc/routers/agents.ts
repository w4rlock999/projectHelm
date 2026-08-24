import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  createAgent,
  deleteAgent,
  DeployedAgentError,
  listAgents,
  loadAgent,
  resetAgentSession,
  updateAgentSessionRecall,
  updateAgentSessionScope,
  updateAgentRunBudget,
  updateAgentSystemPrompt,
} from '../../agents.ts';
import { listRuns } from '../../runs.ts';
import { publicProcedure, router } from '../init.ts';

const idInput = z.object({ id: z.string().uuid() });

export const agentsRouter = router({
  list: publicProcedure.query(() => listAgents()),

  get: publicProcedure.input(idInput).query(({ input }) => {
    const agent = loadAgent(input.id);
    if (!agent) throw new TRPCError({ code: 'NOT_FOUND' });
    return agent;
  }),

  /** Recent turns from the run ledger — every source, including refusals. */
  runs: publicProcedure
    .input(z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(200).optional() }))
    .query(({ input }) => {
      const agent = loadAgent(input.id);
      if (!agent) throw new TRPCError({ code: 'NOT_FOUND' });
      return listRuns(input.id, input.limit);
    }),

  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1).max(120),
        systemPrompt: z.string().min(1),
        model: z.string().nullish(),
        allowedTools: z.array(z.string()).nullish(),
      }),
    )
    .mutation(({ input }) => createAgent(input)),

  update: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        systemPrompt: z.string().min(1).optional(),
        sessionScope: z.enum(['chat', 'agent']).optional(),
        sessionRecall: z.enum(['none', 'all']).optional(),
        // null clears the cap. `undefined` (absent) leaves it untouched, which
        // is why this is nullish rather than optional.
        runBudgetPerHour: z.number().int().positive().nullish(),
      }),
    )
    .mutation(({ input }) => {
      const agent = loadAgent(input.id);
      if (!agent) throw new TRPCError({ code: 'NOT_FOUND' });
      if (input.systemPrompt) updateAgentSystemPrompt(input.id, input.systemPrompt);
      if (input.sessionScope) updateAgentSessionScope(input.id, input.sessionScope);
      if (input.sessionRecall) updateAgentSessionRecall(input.id, input.sessionRecall);
      if (input.runBudgetPerHour !== undefined)
        updateAgentRunBudget(input.id, input.runBudgetPerHour);
      return loadAgent(input.id)!;
    }),

  delete: publicProcedure.input(idInput).mutation(({ input }) => {
    const agent = loadAgent(input.id);
    if (!agent) throw new TRPCError({ code: 'NOT_FOUND' });
    try {
      deleteAgent(input.id);
    } catch (err) {
      if (err instanceof DeployedAgentError) {
        throw new TRPCError({ code: 'CONFLICT', message: err.message });
      }
      throw err;
    }
    return { id: input.id };
  }),

  resetSession: publicProcedure.input(idInput).mutation(({ input }) => {
    const agent = loadAgent(input.id);
    if (!agent) throw new TRPCError({ code: 'NOT_FOUND' });
    resetAgentSession(input.id);
    return loadAgent(input.id)!;
  }),
});
