import { createFileRoute } from '@tanstack/react-router';
import { loadAgent } from '../../server/agents.ts';
import { runAgentTurn } from '../../server/run.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';
import type { ClaudeEvent } from '../../server/adapter/types.ts';

export const Route = createFileRoute('/api/agents/$id/chat')({
  server: {
    handlers: {
      POST: async ({ params, request }: ApiHandlerCtx<RouteParams<'/api/agents/$id/chat'>>) => {
        const agent = loadAgent(params.id);
        if (!agent) {
          return Response.json({ error: 'agent not found' }, { status: 404 });
        }
        let body: { message?: string };
        try {
          body = (await request.json()) as { message?: string };
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }
        const message = body.message?.toString().trim();
        if (!message) {
          return Response.json({ error: 'message is required' }, { status: 400 });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (eventName: string, data: unknown) => {
              const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
              try {
                controller.enqueue(encoder.encode(payload));
              } catch {
                /* downstream closed */
              }
            };

            try {
              // Route through runAgentTurn so the browser shares the per-agent
              // serialization chain with Telegram/heartbeat turns — no two
              // `--resume` against one session at once. Uses the default
              // (agent/console) session; runAgentTurn writes the ndjson log.
              const result = await runAgentTurn(agent.id, message, {
                source: 'chat',
                signal: request.signal,
                // Tell the client which runId this stream belongs to (for log retrieval).
                onRunId: (runId) => send('open', { runId, agentId: agent.id }),
                onEvent: (evt: ClaudeEvent) => send('claude', evt),
              });
              send('end', { code: result.code });
            } catch (err) {
              send('error', {
                message: err instanceof Error ? err.message : String(err),
              });
            } finally {
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            }
          },
        });

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          },
        });
      },
    },
  },
});
