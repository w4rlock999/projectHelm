import { createFileRoute } from '@tanstack/react-router';
import { loadAgent, resolvedHarnessProfile, updateAgentHarness } from '../../server/agents.ts';
import { HarnessProfileError, HarnessProfileSchema } from '../../server/harness/profile.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

type P = RouteParams<'/api/agents/$id/harness'>;

// /api/agents/$id/harness — the agent's harness profile (`helm agent harness`).
// A leaf sibling of info/chat/… — never a bare /api/agents/$id parent.
//   GET   → { own, effective, lastObserved }
//   PATCH → merge fields into the agent's own profile; body `null` clears it
//           (back to the fleet defaults). Fields absent from the body are kept.
export const Route = createFileRoute('/api/agents/$id/harness')({
  server: {
    handlers: {
      GET: ({ params }: ApiHandlerCtx<P>) => {
        const a = loadAgent(params.id);
        if (!a) return Response.json({ error: 'agent not found' }, { status: 404 });
        return Response.json({
          own: a.harness,
          effective: resolvedHarnessProfile(a),
          lastObserved: a.lastHarness,
        });
      },

      PATCH: async ({ params, request }: ApiHandlerCtx<P>) => {
        const a = loadAgent(params.id);
        if (!a) return Response.json({ error: 'agent not found' }, { status: 404 });
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }

        let next: ReturnType<typeof HarnessProfileSchema.parse> | null;
        if (body === null) {
          next = null;
        } else {
          // Merge onto the current own profile so a caller can set one field
          // without restating the others; an explicit null clears that field.
          const parsed = HarnessProfileSchema.partial().safeParse(body);
          if (!parsed.success) {
            return Response.json(
              { error: parsed.error.issues[0]?.message ?? 'invalid profile' },
              { status: 400 },
            );
          }
          next = HarnessProfileSchema.parse({ ...(a.harness ?? {}), ...parsed.data });
        }

        try {
          updateAgentHarness(params.id, next);
        } catch (err) {
          if (err instanceof HarnessProfileError) {
            return Response.json({ error: err.message }, { status: 400 });
          }
          throw err;
        }
        const updated = loadAgent(params.id)!;
        return Response.json({
          ok: true,
          own: updated.harness,
          effective: resolvedHarnessProfile(updated),
        });
      },
    },
  },
});
