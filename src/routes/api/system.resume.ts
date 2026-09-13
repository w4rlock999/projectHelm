import { createFileRoute } from '@tanstack/react-router';
import { requirePairing } from '../../server/remote-auth.ts';
import { setPaused } from '../../server/runtime/pause.ts';
import type { ApiHandlerCtx } from '../../server/api-route.ts';

// /api/system/resume — start admitting turns again (`helm system resume`).
//
// Pairing-gated in headless mode. Every spawned agent holds HELM_INTERNAL_TOKEN,
// so without this an agent paused for burning budget could simply un-pause
// itself. Pause is unprivileged, resume is not.
export const Route = createFileRoute('/api/system/resume')({
  server: {
    handlers: {
      POST: ({ request }: ApiHandlerCtx) => {
        const denied = requirePairing(request);
        if (denied) return denied;
        return Response.json(setPaused(false, { by: 'api' }));
      },
    },
  },
});
