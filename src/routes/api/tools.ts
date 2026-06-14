import { createFileRoute } from '@tanstack/react-router'
import { assignTool, createLibraryTool, listLibraryTools } from '../../server/tools.ts'
import { loadAgent } from '../../server/agents.ts'

const INTERPRETERS = new Set(['bash', 'sh', 'node', 'python3'])

// /api/tools — the shared tool library.
//   GET  → list (read surface for `helm tool ls`)
//   POST → author a new tool, optional assignTo (write surface for `helm tool author`)
export const Route = createFileRoute('/api/tools')({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          listLibraryTools().map((t) => ({
            id: t.id,
            name: t.name,
            interpreter: t.interpreter,
            description: t.description,
            updatedAt: t.updatedAt,
          })),
        ),

      POST: async ({ request }: { request: Request }) => {
        let body: {
          name?: string
          description?: string
          interpreter?: string
          source?: string
          assignTo?: string[]
        }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 })
        }
        if (!body.name?.trim() || !body.description?.trim() || !body.source?.trim()) {
          return Response.json(
            { error: 'name, description and source are required' },
            { status: 400 },
          )
        }
        const interpreter = body.interpreter?.trim() || 'bash'
        if (!INTERPRETERS.has(interpreter)) {
          return Response.json(
            { error: `interpreter must be one of: ${[...INTERPRETERS].join(', ')}` },
            { status: 400 },
          )
        }
        const tool = createLibraryTool({
          name: body.name.trim(),
          description: body.description.trim(),
          interpreter,
          source: body.source,
        })
        const assignedTo: string[] = []
        for (const agentId of body.assignTo ?? []) {
          if (loadAgent(agentId)) {
            assignTool(agentId, tool.id)
            assignedTo.push(agentId)
          }
        }
        return Response.json({ ...tool, assignedTo }, { status: 201 })
      },
    },
  },
})
