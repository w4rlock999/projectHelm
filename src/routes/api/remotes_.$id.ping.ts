import { createFileRoute } from '@tanstack/react-router';
import { pingRemote } from '../../server/remotes/index.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

// /api/remotes/$id/ping — POST → handshake with the remote and refresh its
// cached status (read surface for `helm remote ping`). Expected failures come
// back as { ok: false, error, kind } with HTTP 200 — they're status, not errors.
export const Route = createFileRoute('/api/remotes_/$id/ping')({
  server: {
    handlers: {
      POST: async ({ params }: ApiHandlerCtx<RouteParams<'/api/remotes/$id/ping'>>) => {
        const result = await pingRemote(params.id);
        if (!result) return Response.json({ error: 'remote not found' }, { status: 404 });
        return Response.json(result);
      },
    },
  },
});
