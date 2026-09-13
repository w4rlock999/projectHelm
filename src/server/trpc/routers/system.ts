import { z } from 'zod';
import { HELM_VERSION } from '../../../version.ts';
import { config } from '../../config.ts';
import { getPauseState, setPaused } from '../../runtime/pause.ts';
import { publicProcedure, router } from '../init.ts';

// Daemon-scoped controls, as opposed to per-agent ones. Today: the kill switch.
export const systemRouter = router({
  status: publicProcedure.query(() => ({
    ...getPauseState(),
    version: HELM_VERSION,
    headless: config.headless,
  })),

  pause: publicProcedure
    .input(z.object({ reason: z.string().max(500).optional() }))
    .mutation(({ input }) => setPaused(true, { reason: input.reason, by: 'console' })),

  resume: publicProcedure.mutation(() => setPaused(false, { by: 'console' })),
});
