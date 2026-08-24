import { createFileRoute } from '@tanstack/react-router';
import { loadAgent } from '../../server/agents.ts';
import { listRuns } from '../../server/runs.ts';
import { ensureRuntimeStarted } from '../../server/runtime/index.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

type P = RouteParams<'/api/agents/$id/runs'>;

// /api/agents/$id/runs — recent turns from the run ledger (`helm agent runs`).
// A leaf sibling of info/chat/messages/heartbeats, for the same reason they are:
// a bare /api/agents/$id route would reparent them all.
export const Route = createFileRoute('/api/agents/$id/runs')({
  server: {
    handlers: {
      GET: ({ params, request }: ApiHandlerCtx<P>) => {
        ensureRuntimeStarted();
        const agent = loadAgent(params.id);
        if (!agent) return Response.json({ error: 'agent not found' }, { status: 404 });

        const limitParam = new URL(request.url).searchParams.get('limit');
        const parsed = limitParam ? Number(limitParam) : NaN;
        const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 20;

        return Response.json({
          runs: listRuns(params.id, limit).map((r) => ({
            id: r.id,
            source: r.source,
            status: r.status,
            refusedReason: r.refusedReason,
            prompt: r.prompt,
            resultText: r.resultText,
            exitCode: r.exitCode,
            isError: r.isError,
            startedAt: r.startedAt,
            endedAt: r.endedAt,
          })),
        });
      },
    },
  },
});
