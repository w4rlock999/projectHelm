import { createFileRoute } from '@tanstack/react-router';
import { machineFacts } from '../../server/machine/probe.ts';
import { requirePairing } from '../../server/remote-auth.ts';

// /api/remote/probe — POST → what this machine has, for the shipper's preflight
// and the console's check. P0 answers with the machine facts only; P1 accepts
// `{ requires }` and probes each declared item under the agent env. Pairing-
// gated like every daemon endpoint the local console drives.
export const Route = createFileRoute('/api/remote/probe')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const denied = requirePairing(request);
        if (denied) return denied;
        return Response.json({ ok: true, machine: await machineFacts(), results: [] });
      },
    },
  },
});
