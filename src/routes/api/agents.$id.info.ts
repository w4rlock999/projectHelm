import { createFileRoute } from '@tanstack/react-router';
import {
  deleteAgent,
  DeployedAgentError,
  loadAgent,
  resolvedHarnessProfile,
  updateAgentRunBudget,
  updateAgentSystemPrompt,
} from '../../server/agents.ts';
import { listAgentTools } from '../../server/tools.ts';
import { listAgentMcpServers, redactMcpServer } from '../../server/library/mcp.ts';
import { listAgentChats, listGateways } from '../../server/runtime/gateways.ts';
import { listHeartbeats } from '../../server/runtime/heartbeats.ts';
import type { ApiHandlerCtx, RouteParams } from '../../server/api-route.ts';

type P = RouteParams<'/api/agents/$id/info'>;

// /api/agents/$id/info — the agent resource. A leaf sibling of chat/messages/
// heartbeats (a bare /api/agents/$id route would reparent those and break them).
//   GET    → full config (`helm agent get`)
//   PATCH  → update system prompt (`helm agent set-prompt`)
//   DELETE → remove the agent + its workspace (`helm agent rm`)
export const Route = createFileRoute('/api/agents/$id/info')({
  server: {
    handlers: {
      GET: ({ params }: ApiHandlerCtx<P>) => {
        const a = loadAgent(params.id);
        if (!a) return Response.json({ error: 'agent not found' }, { status: 404 });
        return Response.json({
          id: a.id,
          name: a.name,
          model: a.model ?? 'sonnet',
          isOperator: a.isOperator,
          hasSession: !!a.claudeSessionId,
          sessionScope: a.sessionScope,
          sessionRecall: a.sessionRecall,
          runBudgetPerHour: a.runBudgetPerHour,
          deployedTo: a.deployedTo,
          deployState: a.deployState,
          // The agent's own profile, what it actually runs with (fleet
          // defaults filled in), and what the CLI reported loading last turn.
          harness: a.harness,
          harnessEffective: resolvedHarnessProfile(a),
          lastHarness: a.lastHarness,
          systemPrompt: a.systemPrompt,
          tools: listAgentTools(a.id).map((t) => ({
            id: t.id,
            name: t.name,
            interpreter: t.interpreter,
            description: t.description,
          })),
          // Assigned MCP servers, redacted: env/header values never leave the daemon.
          mcpServers: listAgentMcpServers(a.id).map(redactMcpServer),
          // Tokens are secret — never expose them over the read API.
          gateways: listGateways(a.id).map((g) => ({
            id: g.id,
            type: g.type,
            enabled: g.enabled,
          })),
          chats: listAgentChats(a.id).map((c) => ({
            id: c.id,
            gatewayId: c.gatewayId,
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
        });
      },

      PATCH: async ({ params, request }: ApiHandlerCtx<P>) => {
        if (!loadAgent(params.id)) {
          return Response.json({ error: 'agent not found' }, { status: 404 });
        }
        let body: { systemPrompt?: string; runBudgetPerHour?: number | null };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }

        // Either field may be patched independently. `runBudgetPerHour: null`
        // clears the cap, so absence (undefined) is the "leave alone" signal.
        const patchesBudget = body.runBudgetPerHour !== undefined;
        if (!body.systemPrompt?.trim() && !patchesBudget) {
          return Response.json(
            { error: 'systemPrompt or runBudgetPerHour is required' },
            { status: 400 },
          );
        }
        if (patchesBudget) {
          const b = body.runBudgetPerHour;
          if (b !== null && (!Number.isInteger(b) || (b as number) < 1)) {
            return Response.json(
              { error: 'runBudgetPerHour must be a positive integer, or null to clear' },
              { status: 400 },
            );
          }
          updateAgentRunBudget(params.id, b as number | null);
        }
        if (body.systemPrompt?.trim()) updateAgentSystemPrompt(params.id, body.systemPrompt);
        return Response.json({ ok: true, id: params.id });
      },

      DELETE: ({ params }: ApiHandlerCtx<P>) => {
        if (!loadAgent(params.id)) {
          return Response.json({ error: 'agent not found' }, { status: 404 });
        }
        try {
          deleteAgent(params.id);
        } catch (err) {
          if (err instanceof DeployedAgentError) {
            return Response.json({ error: err.message }, { status: 409 });
          }
          throw err;
        }
        return Response.json({ ok: true, id: params.id });
      },
    },
  },
});
