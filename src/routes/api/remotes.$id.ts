import { createFileRoute } from '@tanstack/react-router';
import { removeRemote } from '../../server/remotes/index.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

// /api/remotes/$id — DELETE → unregister a remote (write surface for
// `helm remote rm`). Tears down any open tunnel first.
export const Route = createFileRoute('/api/remotes/$id')({
  server: {
    handlers: {
      DELETE: ({ params }: ApiHandlerCtx<RouteParams<'/api/remotes/$id'>>) => {
        if (!removeRemote(params.id)) {
          return Response.json({ error: 'remote not found' }, { status: 404 });
        }
        return Response.json({ id: params.id });
      },
    },
  },
});
