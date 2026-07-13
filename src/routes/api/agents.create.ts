import { createFileRoute } from '@tanstack/react-router';
import { createAgent } from '../../server/agents.ts';

// POST /api/agents/create — author a new agent. Write surface for `helm agent new`.
// A leaf sibling of agents.list.ts (a bare /api/agents route would reparent the
// agents.$id.* children).
export const Route = createFileRoute('/api/agents/create')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        let body: { name?: string; systemPrompt?: string; model?: string };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }
        if (!body.name?.trim() || !body.systemPrompt?.trim()) {
          return Response.json({ error: 'name and systemPrompt are required' }, { status: 400 });
        }
        const agent = createAgent({
          name: body.name.trim(),
          systemPrompt: body.systemPrompt,
          model: body.model?.trim() || null,
          allowedTools: null,
        });
        return Response.json(
          { id: agent.id, name: agent.name, model: agent.model },
          { status: 201 },
        );
      },
    },
  },
});
