import { z } from 'zod';
import { HELM_BUILD, HELM_VERSION } from '../../../version.ts';
import { config } from '../../config.ts';
import { getHarnessDefaults, setHarnessDefaults } from '../../harness/defaults.ts';
import { HarnessProfileSchema } from '../../harness/profile.ts';
import { localHarnessInfo } from '../../remote-info.ts';
import { getPauseState, setPaused } from '../../runtime/pause.ts';
import { resyncAllAgents } from '../../tools.ts';
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

  // ── Fleet harness defaults (harness H1) ───────────────────────────────────
  harnessDefaults: publicProcedure.query(() => getHarnessDefaults()),

  /**
   * Replace the fleet defaults, then re-render every agent: each one that
   * inherits a field now has a different effective profile on disk. An agent
   * whose own model collides with a new default fallback fails at its next
   * spawn rather than here — the per-agent check runs where the agent is
   * edited, and a fleet default is not the place to enumerate the fleet.
   */
  setHarnessDefaults: publicProcedure.input(HarnessProfileSchema).mutation(({ input }) => {
    const saved = setHarnessDefaults(input);
    resyncAllAgents();
    return saved;
  }),
});
