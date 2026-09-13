import { createFileRoute } from '@tanstack/react-router';
import { HELM_VERSION } from '../../version.ts';
import { config } from '../../server/config.ts';
import { getPauseState } from '../../server/runtime/pause.ts';

// /api/system/status — daemon-scoped state (`helm system status`). Readable by
// any authenticated caller, agents included: knowing it is paused is harmless
// and lets an agent explain itself.
export const Route = createFileRoute('/api/system/status')({
  server: {
    handlers: {
      GET: () =>
        Response.json({
          ...getPauseState(),
          version: HELM_VERSION,
          headless: config.headless,
        }),
    },
  },
});
