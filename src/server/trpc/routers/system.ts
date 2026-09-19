import { z } from 'zod';
import { HELM_BUILD, HELM_VERSION } from '../../../version.ts';
import { config } from '../../config.ts';
import { localHarnessInfo } from '../../remote-info.ts';
import { getPauseState, setPaused } from '../../runtime/pause.ts';
import { publicProcedure, router } from '../init.ts';

// Daemon-scoped controls, as opposed to per-agent ones. Today: the kill switch,
// and what this helm knows about its own build and harness — the local half of
// every comparison the Remotes page draws against a remote's handshake.
export const systemRouter = router({
  status: publicProcedure.query(async () => ({
    ...getPauseState(),
    version: HELM_VERSION,
    build: HELM_BUILD,
    headless: config.headless,
    harness: await localHarnessInfo(),
  })),

  pause: publicProcedure
    .input(z.object({ reason: z.string().max(500).optional() }))
    .mutation(({ input }) => setPaused(true, { reason: input.reason, by: 'console' })),

  resume: publicProcedure.mutation(() => setPaused(false, { by: 'console' })),
});
