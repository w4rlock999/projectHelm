// Per-request context for tRPC procedures. Slim today; this is where auth /
// session / request-scoped state lands when we add the operator-agent auth model.
export interface Context {
  req: Request
}

export function createContext({ req }: { req: Request }): Context {
  return { req }
}
