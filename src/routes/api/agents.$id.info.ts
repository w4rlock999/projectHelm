import { createFileRoute } from '@tanstack/react-router'
import { deleteAgent, loadAgent, updateAgentSystemPrompt } from '../../server/agents.ts'
import { listAgentTools } from '../../server/tools.ts'
import { listAgentChats, listConnections } from '../../server/runtime/connections.ts'
import { listHeartbeats } from '../../server/runtime/heartbeats.ts'
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts'

type P = RouteParams<'/api/agents/$id/info'>

// /api/agents/$id/info — the agent resource. A leaf sibling of chat/messages/
// heartbeats (a bare /api/agents/$id route would reparent those and break them).
//   GET    → full config (`helm agent get`)
//   PATCH  → update system prompt (`helm agent set-prompt`)
//   DELETE → remove the agent + its workspace (`helm agent rm`)
export const Route = createFileRoute('/api/agents/$id/info')({
  server: {
    handlers: {
      GET: ({ params }: ApiHandlerCtx<P>) => {
        const a = loadAgent(params.id)
        if (!a) return Response.json({ error: 'agent not found' }, { status: 404 })
        return Response.json({
          id: a.id,
          name: a.name,
          model: a.model ?? 'sonnet',
          isOperator: a.isOperator,
          hasSession: !!a.claudeSessionId,
          sessionScope: a.sessionScope,
          systemPrompt: a.systemPrompt,
          tools: listAgentTools(a.id).map((t) => ({
            id: t.id,
            name: t.name,
            interpreter: t.interpreter,
            description: t.description,
          })),
          // Tokens are secret — never expose them over the read API.
          connections: listConnections(a.id).map((c) => ({
            id: c.id,
            type: c.type,
            enabled: c.enabled,
          })),
          chats: listAgentChats(a.id).map((c) => ({
            id: c.id,
            connectionId: c.connectionId,
            chatId: c.chatId,
            title: c.title,
            status: c.status,
            lastMessageAt: c.lastMessageAt,
          })),
          heartbeats: listHeartbeats(a.id).map((h) => ({
            id: h.id,
            name: h.name,
            cron: h.cron,
            prompt: h.prompt,
            enabled: h.enabled,
            targetType: h.targetType,
            targetChatId: h.targetChatId,
            lastRunAt: h.lastRunAt,
          })),
        })
      },

      PATCH: async ({ params, request }: ApiHandlerCtx<P>) => {
        if (!loadAgent(params.id)) {
          return Response.json({ error: 'agent not found' }, { status: 404 })
        }
        let body: { systemPrompt?: string }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 })
        }
        if (!body.systemPrompt?.trim()) {
          return Response.json({ error: 'systemPrompt is required' }, { status: 400 })
        }
        updateAgentSystemPrompt(params.id, body.systemPrompt)
        return Response.json({ ok: true, id: params.id })
      },

      DELETE: ({ params }: ApiHandlerCtx<P>) => {
        if (!loadAgent(params.id)) {
          return Response.json({ error: 'agent not found' }, { status: 404 })
        }
        deleteAgent(params.id)
        return Response.json({ ok: true, id: params.id })
      },
    },
  },
})
