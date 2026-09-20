import { createFileRoute } from '@tanstack/react-router';
import { getRemote, redactRemote, removeRemote, updateRemote } from '../../server/remotes/index.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

type P = RouteParams<'/api/remotes/$id'>;

// /api/remotes/$id — one registered remote (token redacted).
//   GET    → the row (`helm remote get`, and what `helm remote exec` reads to
//            build its own ssh argv — the server never runs a caller's command)
//   PATCH  → { name?, sshIdentityFile? } (`helm remote set`); null clears the
//            identity file. A changed identity is handshaken before it is saved.
//   DELETE → unregister (`helm remote rm`). Tears down any open tunnel first.
export const Route = createFileRoute('/api/remotes/$id')({
  server: {
    handlers: {
      GET: ({ params }: ApiHandlerCtx<P>) => {
        const r = getRemote(params.id);
        if (!r) return Response.json({ error: 'remote not found' }, { status: 404 });
        return Response.json(redactRemote(r));
      },

      PATCH: async ({ params, request }: ApiHandlerCtx<P>) => {
        let body: { name?: string; sshIdentityFile?: string | null };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }
        try {
          const result = await updateRemote(params.id, body);
          if (!result) return Response.json({ error: 'remote not found' }, { status: 404 });
          return Response.json({ remote: redactRemote(result.remote), info: result.info });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      },

      DELETE: ({ params }: ApiHandlerCtx<P>) => {
        if (!removeRemote(params.id)) {
          return Response.json({ error: 'remote not found' }, { status: 404 });
        }
        return Response.json({ id: params.id });
      },
    },
  },
});
