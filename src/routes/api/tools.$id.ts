import { createFileRoute } from '@tanstack/react-router'
import { deleteLibraryTool, getLibraryTool, updateLibraryTool } from '../../server/tools.ts'
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts'

const INTERPRETERS = new Set(['bash', 'sh', 'node', 'python3'])
type P = RouteParams<'/api/tools/$id'>

// /api/tools/$id — a single library tool.
//   PATCH  → update (`helm tool set`) — re-materializes for all assigned agents
//   DELETE → remove (`helm tool rm`) — removed from all assigned agents (cascade)
export const Route = createFileRoute('/api/tools/$id')({
  server: {
    handlers: {
      PATCH: async ({ params, request }: ApiHandlerCtx<P>) => {
        if (!getLibraryTool(params.id)) {
          return Response.json({ error: 'tool not found' }, { status: 404 })
        }
        let body: { name?: string; description?: string; interpreter?: string; source?: string }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 })
        }
        if (body.interpreter && !INTERPRETERS.has(body.interpreter)) {
          return Response.json(
            { error: `interpreter must be one of: ${[...INTERPRETERS].join(', ')}` },
            { status: 400 },
          )
        }
        const patch: Record<string, string> = {}
        for (const k of ['name', 'description', 'interpreter', 'source'] as const) {
          if (body[k] != null) patch[k] = body[k] as string
        }
        const updated = updateLibraryTool(params.id, patch)
        return Response.json(updated)
      },

      DELETE: ({ params }: ApiHandlerCtx<P>) => {
        if (!deleteLibraryTool(params.id)) {
          return Response.json({ error: 'tool not found' }, { status: 404 })
        }
        return Response.json({ ok: true, id: params.id })
      },
    },
  },
})
