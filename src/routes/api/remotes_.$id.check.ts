import { createFileRoute } from '@tanstack/react-router';
import { runRemoteCheck } from '../../server/machine/check.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

// /api/remotes/$id/check — POST { agentId? } → the machine parity report
// (`helm remote check`). Like ping, an unreachable remote is a report with a
// failed row and HTTP 200, not an error: it is status.
export const Route = createFileRoute('/api/remotes_/$id/check')({
  server: {
    handlers: {
      POST: async ({ params, request }: ApiHandlerCtx<RouteParams<'/api/remotes/$id/check'>>) => {
        let body: { agentId?: string } = {};
        try {
          const text = await request.text();
          if (text.trim()) body = JSON.parse(text) as typeof body;
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }
        const report = await runRemoteCheck(params.id, { agentId: body.agentId });
        if (!report) return Response.json({ error: 'remote not found' }, { status: 404 });
        return Response.json(report);
      },
    },
  },
});
