import { ensureHelmCaptain } from '../../captain.ts'
import { resetAgentSession } from '../../agents.ts'
import { publicProcedure, router } from '../init.ts'

export const captainRouter = router({
  // Returns helmCaptain, scaffolding it on first access.
  get: publicProcedure.query(() => ensureHelmCaptain()),

  resetSession: publicProcedure.mutation(() => {
    const captain = ensureHelmCaptain()
    resetAgentSession(captain.id)
    return ensureHelmCaptain()
  }),
})
