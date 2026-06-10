import { router } from '../init.ts'
import { agentsRouter } from './agents.ts'

export const appRouter = router({
  agents: agentsRouter,
})

export type AppRouter = typeof appRouter
