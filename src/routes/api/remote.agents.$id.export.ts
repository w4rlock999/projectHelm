import { createReadStream, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createFileRoute } from '@tanstack/react-router';
import { db } from '../../db/index.ts';
import { agents } from '../../db/schema.ts';
import { eq } from 'drizzle-orm';
import { loadAgent } from '../../server/agents.ts';
import { exportAgentBundle } from '../../server/bundle/export.ts';
import { requirePairing } from '../../server/remote-auth.ts';
import { drainAgentRuns } from '../../server/run.ts';
import { drainAgentPollers, reconcileGateways } from '../../server/runtime/gateways.ts';
import { ensureRuntimeStarted } from '../../server/runtime/index.ts';
import { BUNDLE_FORMAT_VERSION } from '../../version.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

type P = RouteParams<'/api/remote/agents/$id/export'>;

// /api/remote/agents/$id/export — the RECALL wire. The remote deactivates the
// agent on itself and streams a bundle back.
//
// This is the mirror of the local ship flow's steps 0-3, performed by the
// daemon on itself: mark deployState first (so a crash here leaves the agent
// deactivated rather than racing the local copy), drain the pollers so
// pollOffset is settled, drain in-flight runs, then export.
//
// Success streams a tarball; failure returns JSON. The caller discriminates on
// content-type. On any failure the daemon reactivates itself, so a failed recall
// leaves the agent running here exactly as before.
export const Route = createFileRoute('/api/remote/agents/$id/export')({
  server: {
    handlers: {
      POST: async ({ params, request }: ApiHandlerCtx<P>) => {
        const denied = requirePairing(request);
        if (denied) return denied;
        ensureRuntimeStarted();

        const agent = loadAgent(params.id);
        if (!agent) return Response.json({ error: 'agent not found' }, { status: 404 });

        const withData = new URL(request.url).searchParams.get('withoutData') !== '1';

        // Format preflight, BEFORE the claim: if the caller cannot read what
        // this daemon writes, refuse while the agent is still live here. A
        // refusal after deactivation would be a recall that strands the agent
        // for nothing. An absent header is an older caller — let it through
        // and let its own importer decide.
        const accepts = request.headers.get('x-helm-accept-bundle-formats');
        if (accepts !== null) {
          const accepted = accepts
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n));
          if (!accepted.includes(BUNDLE_FORMAT_VERSION)) {
            return Response.json({
              ok: false,
              kind: 'format',
              error:
                `this daemon writes bundle format v${BUNDLE_FORMAT_VERSION}; ` +
                `the caller reads [${accepted.join(', ') || '?'}] — upgrade one side`,
            });
          }
        }

        // Claim first: durable, so an interrupted recall cannot come back with
        // this agent live here while the local side also brings it up.
        db.update(agents).set({ deployState: 'recalling' }).where(eq(agents.id, params.id)).run();

        try {
          await drainAgentPollers(params.id);
          const drained = await drainAgentRuns(params.id, 120_000);
          if (!drained) throw new Error('agent is still mid-run after 120s');

          const exported = await exportAgentBundle(params.id, { withData });
          const stream = createReadStream(exported.path);
          // The file is unlinked once the response body is fully read.
          stream.on('close', () => rmSync(exported.path, { force: true }));

          return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(exported.bytes),
              'x-helm-bundle-sha256': exported.sha256,
              'x-helm-bundle-format': String(BUNDLE_FORMAT_VERSION),
              'x-helm-agent-id': params.id,
            },
          });
        } catch (err) {
          // Reactivate: a failed recall must leave the agent running here.
          db.update(agents).set({ deployState: null }).where(eq(agents.id, params.id)).run();
          reconcileGateways();
          return Response.json({
            ok: false,
            kind: 'io',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
  },
});
