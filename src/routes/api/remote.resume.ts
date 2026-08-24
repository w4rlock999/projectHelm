import { createFileRoute } from '@tanstack/react-router';
import { requirePairing } from '../../server/remote-auth.ts';
import { setPaused } from '../../server/runtime/pause.ts';
import type { ApiHandlerCtx } from '../../server/api-route.ts';

// /api/remote/resume — resume this daemon from a paired local helm.
// Pairing-gated: an agent holding HELM_INTERNAL_TOKEN must not be able to lift
// a pause it was subject to.
export const Route = createFileRoute('/api/remote/resume')({
  server: {
    handlers: {
      POST: ({ request }: ApiHandlerCtx) => {
        const denied = requirePairing(request);
        if (denied) return denied;
        return Response.json({ ok: true, ...setPaused(false, { by: 'api' }) });
      },
    },
  },
});
