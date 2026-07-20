import { router } from '../init.ts';
import { agentsRouter } from './agents.ts';
import { captainRouter } from './captain.ts';
import { gatewaysRouter } from './gateways.ts';
import { heartbeatsRouter } from './heartbeats.ts';
import { remotesRouter } from './remotes.ts';
import { toolsRouter } from './tools.ts';

export const appRouter = router({
  agents: agentsRouter,
  captain: captainRouter,
  tools: toolsRouter,
  gateways: gatewaysRouter,
  heartbeats: heartbeatsRouter,
  remotes: remotesRouter,
});

export type AppRouter = typeof appRouter;
