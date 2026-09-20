import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { listOps, recordOp } from '../../server/machine/ledger.ts';
import { getRemote } from '../../server/remotes/index.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

type P = RouteParams<'/api/remotes/$id/ops'>;

// /api/remotes/$id/ops — the ledger of what helm ran on a remote.
//   GET  ?limit= → newest first (`helm remote ops`)
//   POST { kind: 'exec-note', argv, code } → the CLI records an operator
//        `helm remote exec` after the fact. The server runs nothing here; this
//        is a note, best-effort, so the ledger still answers "what was run".
const ExecNote = z.object({
  kind: z.literal('exec-note'),
  argv: z.array(z.string().max(1_000)).max(200),
  code: z.number().int().nullable(),
});

export const Route = createFileRoute('/api/remotes_/$id/ops')({
  server: {
    handlers: {
      GET: ({ params, request }: ApiHandlerCtx<P>) => {
        if (!getRemote(params.id)) {
          return Response.json({ error: 'remote not found' }, { status: 404 });
        }
        const raw = new URL(request.url).searchParams.get('limit');
        const limit = Math.min(Math.max(Number(raw) || 20, 1), 200);
        return Response.json(listOps(params.id, limit));
      },

      POST: async ({ params, request }: ApiHandlerCtx<P>) => {
        if (!getRemote(params.id)) {
          return Response.json({ error: 'remote not found' }, { status: 404 });
        }
        const parsed = ExecNote.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return Response.json(
            { error: 'expected { kind: "exec-note", argv, code }' },
            { status: 400 },
          );
        }
        const now = new Date();
        const op = recordOp({
          remoteId: params.id,
          kind: 'exec-note',
          detail: { argv: parsed.data.argv },
          requestedBy: 'operator',
          startedAt: now,
          finishedAt: now,
          code: parsed.data.code,
        });
        return Response.json(op, { status: 201 });
      },
    },
  },
});
