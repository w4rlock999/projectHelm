import { createFileRoute } from '@tanstack/react-router';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '#/server/trpc/routers/_app';
import { createContext } from '#/server/trpc/context';
import type { ApiHandlerCtx } from '#/server/api-route';

const handle = ({ request }: ApiHandlerCtx) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    createContext: () => createContext({ req: request }),
  });

export const Route = createFileRoute('/api/trpc/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
    },
  },
});
