import { ensureRuntimeStarted } from '../runtime/index.ts';

// Per-request context for tRPC procedures. Slim today; this is where auth /
// session / request-scoped state lands when we add the operator-agent auth model.
export interface Context {
  req: Request;
}

export function createContext({ req }: { req: Request }): Context {
  // Boot background loops (heartbeat scheduler + gateway pollers) on first request.
  ensureRuntimeStarted();
  return { req };
}
