/**
 * Context object passed by TanStack Start to file-route `server.handlers.METHOD`
 * functions. Generic over the route's param shape.
 *
 * Use with `RouteParams<'<path>'>` so the param shape is derived from the
 * route path string at the type level. Note: TanStack's Vite plugin requires
 * `createFileRoute('<literal>')` to be a literal at the call site, AND you
 * can't pull the params from `typeof Route` (creates a TS cycle in strict
 * mode). So the path literal appears twice in the file by necessity — once
 * in `createFileRoute(...)` and once in `RouteParams<...>`. Keep them in
 * sync; TS won't catch a mismatch.
 *
 *   const PATH_LITERAL = '/api/things/$id/$turn'
 *
 *   export const Route = createFileRoute('/api/things/$id/$turn')({
 *     server: { handlers: {
 *       POST: async (
 *         { params, request }: ApiHandlerCtx<RouteParams<'/api/things/$id/$turn'>>
 *       ) => { ... }   // params is { id: string; turn: string }
 *     } }
 *   })
 *
 * Drop these helpers when TanStack Router lands native param inference for
 * server handlers (it's been on the roadmap).
 */
export type ApiHandlerCtx<TParams = Record<string, string>> = {
  request: Request;
  params: TParams;
};

/**
 * Derive a `{paramName: string}` record from a TanStack route path string.
 * Each `$name` segment becomes a string property.
 *
 *   RouteParams<'/foo/$id'>                → { id: string }
 *   RouteParams<'/foo/$id/$turn/chat'>     → { id: string; turn: string }
 *   RouteParams<'/foo'>                    → Record<string, never>
 */
export type RouteParams<P extends string> = P extends `${string}$${infer Name}/${infer Rest}`
  ? { [_ in Name]: string } & RouteParams<Rest>
  : P extends `${string}$${infer Name}`
    ? { [_ in Name]: string }
    : Record<string, never>;
