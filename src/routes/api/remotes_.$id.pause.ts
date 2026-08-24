import { createFileRoute } from '@tanstack/react-router';
import { pauseRemote } from '../../server/remotes/index.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

// /api/remotes/$id/pause — POST { paused, reason? } → pause or resume a remote
// daemon through its tunnel (`helm remote pause|resume`). Expected failures come
// back as { ok: false, error, kind } with HTTP 200 — they're status, not errors.
//
// The `_` suffix un-nests this from /api/remotes/$id (see remotes_.$id.ping.ts):
// a child whose own segment has no param would otherwise get `params` typed as
// never and fail typecheck.
export const Route = createFileRoute('/api/remotes_/$id/pause')({
  server: {
    handlers: {
      POST: async ({ params, request }: ApiHandlerCtx<RouteParams<'/api/remotes/$id/pause'>>) => {
        const body = (await request.json().catch(() => ({}))) as {
          paused?: boolean;
          reason?: string;
        };
        if (typeof body.paused !== 'boolean') {
          return Response.json({ error: 'paused (boolean) is required' }, { status: 400 });
        }
        const result = await pauseRemote(params.id, body.paused, body.reason);
        if (!result) return Response.json({ error: 'remote not found' }, { status: 404 });
        return Response.json(result);
      },
    },
  },
});
