import { createFileRoute } from '@tanstack/react-router'
import { listAgents } from '../../server/agents.ts'
import { listAgentTools } from '../../server/tools.ts'
import { listGateways } from '../../server/runtime/gateways.ts'
import { listHeartbeats } from '../../server/runtime/heartbeats.ts'

// GET /api/agents/list — the fleet (excludes helmCaptain) with per-agent counts.
// Read surface for the helm CLI's `agent ls` / `context`. A leaf route (not a
// bare /api/agents) so it doesn't reparent the agents.$id.* sibling routes.
export const Route = createFileRoute('/api/agents/list')({
  server: {
    handlers: {
      GET: () => {
        const fleet = listAgents().map((a) => ({
          id: a.id,
          name: a.name,
          model: a.model ?? 'sonnet',
          hasSession: !!a.claudeSessionId,
          toolCount: listAgentTools(a.id).length,
          gatewayCount: listGateways(a.id).length,
          heartbeatCount: listHeartbeats(a.id).length,
          createdAt: a.createdAt,
        }))
        return Response.json(fleet)
      },
    },
  },
})
