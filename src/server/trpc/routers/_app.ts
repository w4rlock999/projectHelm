import { router } from '../init.ts';
import { agentsRouter } from './agents.ts';
import { captainRouter } from './captain.ts';
import { gatewaysRouter } from './gateways.ts';
import { heartbeatsRouter } from './heartbeats.ts';
import { toolsRouter } from './tools.ts';

export const appRouter = router({
  agents: agentsRouter,
  captain: captainRouter,
  tools: toolsRouter,
  gateways: gatewaysRouter,
  heartbeats: heartbeatsRouter,
});

export type AppRouter = typeof appRouter;
