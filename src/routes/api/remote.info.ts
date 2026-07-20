import { createFileRoute } from '@tanstack/react-router';
import { getRemoteInfo } from '../../server/remote-info.ts';
import { ensureRuntimeStarted } from '../../server/runtime/index.ts';

// /api/remote/info — the pairing handshake. The local helm calls this through
// the SSH tunnel to verify a remote (add/ping) and read its capabilities.
// Bearer auth is enforced upstream by the server entry in headless mode.
export const Route = createFileRoute('/api/remote/info')({
  server: {
    handlers: {
      GET: async () => {
        ensureRuntimeStarted();
        return Response.json(await getRemoteInfo());
      },
    },
  },
});
