import { router } from '../init.ts';
import { agentsRouter } from './agents.ts';
import { captainRouter } from './captain.ts';
import { gatewaysRouter } from './gateways.ts';
import { heartbeatsRouter } from './heartbeats.ts';
import { mcpRouter } from './mcp.ts';
import { remotesRouter } from './remotes.ts';
import { shipRouter } from './ship.ts';
import { systemRouter } from './system.ts';
import { toolsRouter } from './tools.ts';

export const appRouter = router({
  agents: agentsRouter,
  captain: captainRouter,
  tools: toolsRouter,
  mcp: mcpRouter,
  gateways: gatewaysRouter,
  heartbeats: heartbeatsRouter,
  remotes: remotesRouter,
  ship: shipRouter,
  system: systemRouter,
});

export type AppRouter = typeof appRouter;
