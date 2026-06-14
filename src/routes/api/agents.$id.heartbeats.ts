import { createFileRoute } from '@tanstack/react-router'
import { loadAgent } from '../../server/agents.ts'
import { createHeartbeat, listHeartbeats } from '../../server/runtime/heartbeats.ts'
import { ensureRuntimeStarted } from '../../server/runtime/index.ts'
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts'

// Used by the agent's built-in `heartbeat` tool to list/add its own heartbeats.
export const Route = createFileRoute('/api/agents/$id/heartbeats')({
  server: {
    handlers: {
      GET: ({ params }: ApiHandlerCtx<RouteParams<'/api/agents/$id/heartbeats'>>) => {
        ensureRuntimeStarted()
        if (!loadAgent(params.id)) {
          return Response.json({ error: 'agent not found' }, { status: 404 })
        }
        return Response.json(listHeartbeats(params.id))
      },

      POST: async ({
        params,
        request,
      }: ApiHandlerCtx<RouteParams<'/api/agents/$id/heartbeats'>>) => {
        ensureRuntimeStarted()
        if (!loadAgent(params.id)) {
          return Response.json({ error: 'agent not found' }, { status: 404 })
        }
        let body: { cron?: string; prompt?: string; name?: string }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 })
        }
        if (!body.cron || !body.prompt) {
          return Response.json({ error: 'cron and prompt are required' }, { status: 400 })
        }
        try {
          const hb = createHeartbeat({
            agentId: params.id,
            cron: body.cron,
            prompt: body.prompt,
            name: body.name,
          })
          return Response.json(hb, { status: 201 })
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          )
        }
      },
    },
  },
})
