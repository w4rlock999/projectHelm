import { createFileRoute } from '@tanstack/react-router'
import { deleteHeartbeat, updateHeartbeat } from '../../server/runtime/heartbeats.ts'
import { ensureRuntimeStarted } from '../../server/runtime/index.ts'
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts'

type P = RouteParams<'/api/agents/$id/heartbeats/$hbId'>

// Used by the agent's built-in `heartbeat` tool to update/enable/disable/remove.
export const Route = createFileRoute('/api/agents/$id/heartbeats/$hbId')({
  server: {
    handlers: {
      PATCH: async ({ params, request }: ApiHandlerCtx<P>) => {
        ensureRuntimeStarted()
        let body: {
          cron?: string
          prompt?: string
          name?: string
          enabled?: boolean
          targetType?: string
          targetChatId?: string | null
        }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 })
        }
        try {
          const updated = updateHeartbeat(params.hbId, body)
          if (!updated) return Response.json({ error: 'heartbeat not found' }, { status: 404 })
          return Response.json(updated)
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          )
        }
      },

      DELETE: ({ params }: ApiHandlerCtx<P>) => {
        ensureRuntimeStarted()
        if (!deleteHeartbeat(params.hbId)) {
          return Response.json({ error: 'heartbeat not found' }, { status: 404 })
        }
        return Response.json({ id: params.hbId })
      },
    },
  },
})
