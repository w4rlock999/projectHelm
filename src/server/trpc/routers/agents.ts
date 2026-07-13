import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  createAgent,
  deleteAgent,
  listAgents,
  loadAgent,
  resetAgentSession,
  updateAgentSessionRecall,
  updateAgentSessionScope,
  updateAgentSystemPrompt,
} from '../../agents.ts';
import { publicProcedure, router } from '../init.ts';

const idInput = z.object({ id: z.string().uuid() });

export const agentsRouter = router({
  list: publicProcedure.query(() => listAgents()),

  get: publicProcedure.input(idInput).query(({ input }) => {
    const agent = loadAgent(input.id);
    if (!agent) throw new TRPCError({ code: 'NOT_FOUND' });
    return agent;
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
      }),
    )
    .mutation(({ input }) => {
      const agent = loadAgent(input.id);
      if (!agent) throw new TRPCError({ code: 'NOT_FOUND' });
      if (input.systemPrompt) updateAgentSystemPrompt(input.id, input.systemPrompt);
      if (input.sessionScope) updateAgentSessionScope(input.id, input.sessionScope);
      if (input.sessionRecall) updateAgentSessionRecall(input.id, input.sessionRecall);
      return loadAgent(input.id)!;
    }),

  delete: publicProcedure.input(idInput).mutation(({ input }) => {
    const agent = loadAgent(input.id);
    if (!agent) throw new TRPCError({ code: 'NOT_FOUND' });
    deleteAgent(input.id);
    return { id: input.id };
  }),

  resetSession: publicProcedure.input(idInput).mutation(({ input }) => {
    const agent = loadAgent(input.id);
    if (!agent) throw new TRPCError({ code: 'NOT_FOUND' });
    resetAgentSession(input.id);
    return loadAgent(input.id)!;
  }),
});
