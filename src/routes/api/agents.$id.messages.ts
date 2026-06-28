import { createFileRoute } from '@tanstack/react-router'
import { loadAgent } from '../../server/agents.ts'
import { listAgentChats, sendToChat } from '../../server/runtime/connections.ts'
import { ensureRuntimeStarted } from '../../server/runtime/index.ts'
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts'

// Used by the agent's built-in `send-telegram` tool: POST { text, chatId? } →
// relay to a specific Telegram chat. chatId comes from --chat or HELM_CHAT_ID;
// if omitted and the agent has exactly one chat, we default to it.
export const Route = createFileRoute('/api/agents/$id/messages')({
  server: {
    handlers: {
      POST: async ({ params, request }: ApiHandlerCtx<RouteParams<'/api/agents/$id/messages'>>) => {
        ensureRuntimeStarted()
        if (!loadAgent(params.id)) {
          return Response.json({ error: 'agent not found' }, { status: 404 })
        }
        let body: { text?: string; chatId?: string }
        try {
          body = (await request.json()) as { text?: string; chatId?: string }
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 })
        }
        const text = body.text?.toString().trim()
        if (!text) return Response.json({ error: 'text is required' }, { status: 400 })

        let chatId = body.chatId?.toString().trim() || undefined
        if (!chatId) {
          const chats = listAgentChats(params.id)
          if (chats.length === 1) chatId = chats[0].chatId
          else
            return Response.json(
              {
                error:
                  chats.length === 0
                    ? 'no linked Telegram chat — message the bot first to establish a chat'
                    : 'multiple chats linked — pass --chat <id> to choose one',
              },
              { status: 400 },
            )
        }

        try {
          const result = await sendToChat(params.id, chatId, text)
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
