import { createFileRoute } from '@tanstack/react-router';
import { addRemote, listRemotes } from '../../server/remotes/index.ts';
import type { Remote } from '../../db/schema.ts';

// Pairing tokens stay out of the agent-facing surface — the captain manages
// remotes, it doesn't hold their credentials.
function redact(r: Remote) {
  const { token: _token, ...rest } = r;
  return rest;
}

// /api/remotes — the remotes registry (read/write surface for `helm remote`).
//   GET  → list
//   POST → add (handshakes before saving; accepts connect code or fields)
export const Route = createFileRoute('/api/remotes')({
  server: {
    handlers: {
      GET: () => Response.json(listRemotes().map(redact)),

      POST: async ({ request }: { request: Request }) => {
        let body: {
          name?: string;
          connectCode?: string;
          sshTarget?: string;
          helmPort?: number;
          token?: string;
        };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }
        try {
          const { remote, info } = await addRemote(body);
          return Response.json({ remote: redact(remote), info }, { status: 201 });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      },
    },
  },
});
