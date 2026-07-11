import { mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { agents } from '../db/schema.ts'
import { paths } from './paths.ts'
import { syncAgentTools } from './tools.ts'
import { DEFAULT_ALLOWED_TOOLS } from './adapter/claude.ts'
import type { Agent } from '../db/schema.ts'

export interface CreateAgentInput {
  name: string
  systemPrompt: string
  allowedTools?: string[] | null
  model?: string | null
}

export function createAgent(input: CreateAgentInput): Agent {
  const id = randomUUID()
  const workspaceDir = paths.agentWorkspaceDir(id)
  const logsDir = paths.agentLogsDir(id)
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(logsDir, { recursive: true })
  // Durable data plane: the agent store (shared) and the 'shared' session store
  // (used by the agent-scope session, console, and 'main' heartbeats). Per-chat
  // session stores are created lazily on first turn. ('shared' mirrors
  // SHARED_SESSION_KEY in runtime/gateways.ts — kept literal here to avoid a
  // circular import.)
  mkdirSync(paths.agentStoreArtifactsDir(id), { recursive: true })
  mkdirSync(paths.agentSessionStoreArtifactsDir(id, 'shared'), { recursive: true })

  const row = {
    id,
    name: input.name,
    systemPrompt: input.systemPrompt,
    allowedTools: input.allowedTools?.length ? input.allowedTools.join(',') : null,
    model: input.model ?? null,
    claudeSessionId: null,
    // New agents default to isolated per-chat sessions...
    sessionScope: 'chat' as const,
    // ...and to no cross-session recall (each session is context-isolated).
    sessionRecall: 'none' as const,
    isOperator: false,
    createdAt: new Date(),
  }
  db.insert(agents).values(row).run()
  // Materializes built-in tools (heartbeat) + writes CLAUDE.md with the tools block.
  syncAgentTools(id)
  return row as Agent
}

/** The user-facing fleet — excludes the operator (helmCaptain). */
export function listAgents(): Agent[] {
  return db.select().from(agents).where(eq(agents.isOperator, false)).all()
}

export function loadAgent(id: string): Agent | null {
  return db.select().from(agents).where(eq(agents.id, id)).get() ?? null
}

export function updateAgentSystemPrompt(id: string, systemPrompt: string): void {
  db.update(agents).set({ systemPrompt }).where(eq(agents.id, id)).run()
  // Re-render CLAUDE.md so the managed tools block is preserved below the prompt.
  syncAgentTools(id)
}

export function updateAgentSessionId(id: string, sessionId: string): void {
  db.update(agents).set({ claudeSessionId: sessionId }).where(eq(agents.id, id)).run()
}

/** 'chat' = isolated per Telegram chat; 'agent' = one shared session for everything. */
export function updateAgentSessionScope(id: string, sessionScope: 'chat' | 'agent'): void {
  db.update(agents).set({ sessionScope }).where(eq(agents.id, id)).run()
}

/**
 * 'none' = the agent only sees the current session's store; 'all' = it may read
 * across every session store (exposed as HELM_SESSIONS_DIR). Re-renders CLAUDE.md
 * so the "Your data" block reflects the new recall permission.
 */
export function updateAgentSessionRecall(id: string, sessionRecall: 'none' | 'all'): void {
  db.update(agents).set({ sessionRecall }).where(eq(agents.id, id)).run()
  syncAgentTools(id)
}

export function resetAgentSession(id: string): void {
  db.update(agents).set({ claudeSessionId: null }).where(eq(agents.id, id)).run()
}

export function deleteAgent(id: string): void {
  db.delete(agents).where(eq(agents.id, id)).run()
  rmSync(paths.agentDir(id), { recursive: true, force: true })
}

export function agentRuntime(a: Agent): {
  id: string
  workspaceDir: string
  claudeSessionId: string | null
  allowedTools?: string[] | null
  model?: string | null
} {
  // Every agent invokes tools via Bash — regular agents have the built-in
  // heartbeat tool, and helmCaptain now has the helm CLI — so Bash is always
  // in the allow-list.
  const base = a.allowedTools
    ? a.allowedTools.split(',').map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_ALLOWED_TOOLS]
  if (!base.includes('Bash')) base.push('Bash')

  return {
    id: a.id,
    workspaceDir: paths.agentWorkspaceDir(a.id),
    claudeSessionId: a.claudeSessionId,
    allowedTools: base,
    model: a.model,
  }
}
