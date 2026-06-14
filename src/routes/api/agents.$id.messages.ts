import { createFileRoute } from '@tanstack/react-router'
import { loadAgent } from '../../server/agents.ts'
import { sendToAgentChannels } from '../../server/runtime/channels.ts'
import { ensureRuntimeStarted } from '../../server/runtime/index.ts'
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts'

// Used by the agent's built-in `send-telegram` tool: POST { text } → relay to
// the agent's linked Telegram chat(s).
export const Route = createFileRoute('/api/agents/$id/messages')({
  server: {
    handlers: {
      POST: async ({ params, request }: ApiHandlerCtx<RouteParams<'/api/agents/$id/messages'>>) => {
        ensureRuntimeStarted()
        if (!loadAgent(params.id)) {
          return Response.json({ error: 'agent not found' }, { status: 404 })
        }
        let body: { text?: string }
        try {
          body = (await request.json()) as { text?: string }
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 })
        }
        const text = body.text?.toString().trim()
        if (!text) return Response.json({ error: 'text is required' }, { status: 400 })

        try {
          const result = await sendToAgentChannels(params.id, text)
          return Response.json(result)
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
