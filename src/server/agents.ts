import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { agents } from '../db/schema.ts'
import { paths } from './paths.ts'
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
  writeFileSync(paths.agentClaudeMd(id), input.systemPrompt)

  const row = {
    id,
    name: input.name,
    systemPrompt: input.systemPrompt,
    allowedTools: input.allowedTools?.length ? input.allowedTools.join(',') : null,
    model: input.model ?? null,
    claudeSessionId: null,
    createdAt: new Date(),
  }
  db.insert(agents).values(row).run()
  return row as Agent
}

export function listAgents(): Agent[] {
  return db.select().from(agents).all()
}

export function loadAgent(id: string): Agent | null {
  return db.select().from(agents).where(eq(agents.id, id)).get() ?? null
}

export function updateAgentSystemPrompt(id: string, systemPrompt: string): void {
  db.update(agents).set({ systemPrompt }).where(eq(agents.id, id)).run()
  writeFileSync(paths.agentClaudeMd(id), systemPrompt)
}

export function updateAgentSessionId(id: string, sessionId: string): void {
  db.update(agents).set({ claudeSessionId: sessionId }).where(eq(agents.id, id)).run()
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
  return {
    id: a.id,
    workspaceDir: paths.agentWorkspaceDir(a.id),
    claudeSessionId: a.claudeSessionId,
    allowedTools: a.allowedTools ? a.allowedTools.split(',').map((s) => s.trim()) : null,
    model: a.model,
  }
}
