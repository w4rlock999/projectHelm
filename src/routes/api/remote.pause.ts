import { createFileRoute } from '@tanstack/react-router';
import { requirePairing } from '../../server/remote-auth.ts';
import { setPaused } from '../../server/runtime/pause.ts';
import type { ApiHandlerCtx } from '../../server/api-route.ts';

// /api/remote/pause — pause this daemon from a paired local helm.
//
// Unlike /api/system/pause (which any authenticated caller may use, including
// the daemon's own agents), the /api/remote/* surface is the operator's control
// plane and is pairing-gated throughout — including pause, so the two halves of
// the switch are consistent for a remote operator.
export const Route = createFileRoute('/api/remote/pause')({
  server: {
    handlers: {
      POST: async ({ request }: ApiHandlerCtx) => {
        const denied = requirePairing(request);
        if (denied) return denied;
        const body = (await request.json().catch(() => ({}))) as { reason?: string };
        return Response.json({ ok: true, ...setPaused(true, { reason: body.reason, by: 'api' }) });
      },
    },
  },
});
