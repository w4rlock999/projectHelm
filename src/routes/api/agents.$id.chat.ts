import { createFileRoute } from "@tanstack/react-router";
import { createWriteStream, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runClaude } from "../../server/adapter/claude.ts";
import {
  agentRuntime,
  loadAgent,
  updateAgentSessionId,
} from "../../server/agents.ts";
import { paths } from "../../server/paths.ts";
import type { ApiHandlerCtx, RouteParams } from "../../server/api-route.ts";
import type { ClaudeEvent } from "../../server/adapter/types.ts";

export const Route = createFileRoute("/api/agents/$id/chat")({
  server: {
    handlers: {
      POST: async ({
        params,
        request,
      }: ApiHandlerCtx<RouteParams<"/api/agents/$id/chat">>) => {
        const agent = loadAgent(params.id);
        if (!agent) {
          return Response.json({ error: "agent not found" }, { status: 404 });
        }
        let body: { message?: string };
        try {
          body = (await request.json()) as { message?: string };
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }
        const message = body.message?.toString().trim();
        if (!message) {
          return Response.json(
            { error: "message is required" },
            { status: 400 },
          );
        }

        const runId = randomUUID();
        mkdirSync(paths.agentLogsDir(agent.id), { recursive: true });
        const logStream = createWriteStream(
          paths.agentLogFile(agent.id, runId),
          {
            flags: "a",
          },
        );

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (eventName: string, data: unknown) => {
              const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
              try {
                controller.enqueue(encoder.encode(payload));
              } catch {
                /* downstream closed */
              }
            };

            // Tell the client which runId this stream belongs to (for log retrieval).
            send("open", { runId, agentId: agent.id });

            try {
              const result = await runClaude({
                agent: agentRuntime(agent),
                prompt: message,
                signal: request.signal,
                onEvent: (evt: ClaudeEvent) => {
                  logStream.write(JSON.stringify(evt) + "\n");
                  send("claude", evt);
                },
                onLog: () => {
                  /* stdout already covered via onEvent; stderr is debug-only */
                },
                onSessionId: (sid) => {
                  if (sid !== agent.claudeSessionId) {
                    updateAgentSessionId(agent.id, sid);
                  }
                },
              });
              send("end", { code: result.code });
            } catch (err) {
              send("error", {
                message: err instanceof Error ? err.message : String(err),
              });
            } finally {
              logStream.end();
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            }
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});
