import { createFileRoute } from '@tanstack/react-router';
import { getHarnessDefaults, setHarnessDefaults } from '../../server/harness/defaults.ts';
import { HarnessProfileSchema } from '../../server/harness/profile.ts';
import { resyncAllAgents } from '../../server/tools.ts';
import type { ApiHandlerCtx } from '../../server/api-route.ts';

// /api/system/harness — the fleet harness defaults (`helm harness defaults`).
//   GET → the defaults profile
//   PUT → merge fields into it (explicit null clears a field), then re-render
//         every agent that inherits.
export const Route = createFileRoute('/api/system/harness')({
  server: {
    handlers: {
      GET: () => Response.json(getHarnessDefaults()),

      PUT: async ({ request }: ApiHandlerCtx) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }
        const parsed = HarnessProfileSchema.partial().safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: parsed.error.issues[0]?.message ?? 'invalid profile' },
            { status: 400 },
          );
        }
        const saved = setHarnessDefaults(
          HarnessProfileSchema.parse({ ...getHarnessDefaults(), ...parsed.data }),
        );
        const resynced = resyncAllAgents();
        return Response.json({ ok: true, defaults: saved, resynced });
      },
    },
  },
});
