import { createFileRoute } from '@tanstack/react-router';
import { setPaused } from '../../server/runtime/pause.ts';
import type { ApiHandlerCtx } from '../../server/api-route.ts';

// /api/system/pause — stop admitting new turns (`helm system pause`).
//
// Deliberately NOT pairing-gated: an agent that notices it is misbehaving should
// be able to stop the fleet. Resuming is the privileged half — see system.resume.
export const Route = createFileRoute('/api/system/pause')({
  server: {
    handlers: {
      POST: async ({ request }: ApiHandlerCtx) => {
        const body = (await request.json().catch(() => ({}))) as { reason?: string };
        return Response.json(setPaused(true, { reason: body.reason, by: 'api' }));
      },
    },
  },
});
