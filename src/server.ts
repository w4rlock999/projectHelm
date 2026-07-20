import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import type { ServerEntry } from '@tanstack/react-start/server-entry';
import { config } from './server/config.ts';
import { verifyBearer } from './server/remote-auth.ts';
import { ensureRuntimeStarted } from './server/runtime/index.ts';

// Custom TanStack Start server entry — resolved automatically by the Start
// plugin (never create src/server/index.ts: it would make `./server`
// ambiguous with this file). Every request in dev, preview, and production
// flows through this fetch handler, which makes it the single choke point for
// headless-daemon concerns:
//
// - **Eager runtime boot.** A headless daemon may receive zero requests, but
//   its heartbeat cron + gateway pollers must still run. Booting here (module
//   top level) starts them at process start in production, where the launcher
//   (scripts/serve.mjs) imports this bundle before listening.
// - **Bearer auth on the whole /api/* surface** (tRPC + REST) when headless.
//   Local mode is untouched. SPA assets are served before this handler (Vite
//   middleware in dev, srvx serveStatic in production), so the console stays
//   reachable through the SSH tunnel; only data endpoints are gated.
if (config.headless) ensureRuntimeStarted();

const startFetch = createStartHandler(defaultStreamHandler);

const entry: ServerEntry = {
  async fetch(request, ...rest) {
    if (config.headless && new URL(request.url).pathname.startsWith('/api/')) {
      if (!verifyBearer(request.headers.get('authorization'))) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
    }
    return startFetch(request, ...rest);
  },
};

export default entry;
