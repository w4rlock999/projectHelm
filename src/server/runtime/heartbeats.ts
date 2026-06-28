import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../../db/index.ts'
import { heartbeats } from '../../db/schema.ts'
import { cronMatches, isValidCron } from '../cron.ts'
import { loadAgent } from '../agents.ts'
import { runAgentTurn } from '../run.ts'
import { listAgentChats, resolveSessionStore } from './connections.ts'
import type { Heartbeat } from '../../db/schema.ts'

// ── CRUD service (shared by tRPC router + REST route) ───────────────────────

export interface CreateHeartbeatInput {
  agentId: string
  name?: string | null
  cron: string
  prompt: string
  targetType?: string | null
  targetChatId?: string | null
}

/** Validate the audience. v0 supports 'main' + 'chat'; 'all' is reserved. */
function validateTarget(targetType: string, targetChatId: string | null | undefined): void {
  if (targetType === 'main') return
  if (targetType === 'chat') {
    if (!targetChatId) throw new Error("targetChatId is required when targetType = 'chat'")
    return
  }
  if (targetType === 'all') throw new Error("targetType 'all' (broadcast) is not supported yet")
  throw new Error(`unknown targetType: ${targetType}`)
}

export function listHeartbeats(agentId: string): Heartbeat[] {
  return db.select().from(heartbeats).where(eq(heartbeats.agentId, agentId)).all()
}

export function createHeartbeat(input: CreateHeartbeatInput): Heartbeat {
  isValidCron(input.cron) // throws on a bad expression
  const targetType = input.targetType ?? 'main'
  validateTarget(targetType, input.targetChatId)
  const row: Heartbeat = {
    id: randomUUID(),
    agentId: input.agentId,
    name: input.name?.trim() || 'heartbeat',
    cron: input.cron.trim(),
    prompt: input.prompt,
    targetType,
    targetChatId: targetType === 'chat' ? (input.targetChatId ?? null) : null,
    enabled: true,
    lastRunAt: null,
    createdAt: new Date(),
  }
  db.insert(heartbeats).values(row).run()
  return row
}

export function updateHeartbeat(
  id: string,
  patch: Partial<Pick<Heartbeat, 'name' | 'cron' | 'prompt' | 'enabled' | 'targetType' | 'targetChatId'>>,
): Heartbeat | null {
  if (patch.cron) isValidCron(patch.cron)
  const existing = db.select().from(heartbeats).where(eq(heartbeats.id, id)).get()
  if (!existing) return null
  // Validate the resulting (possibly partial) target against the merged row.
  if (patch.targetType !== undefined || patch.targetChatId !== undefined) {
    const targetType = patch.targetType ?? existing.targetType
    const targetChatId = patch.targetChatId !== undefined ? patch.targetChatId : existing.targetChatId
    validateTarget(targetType, targetChatId)
    if (targetType !== 'chat') patch = { ...patch, targetChatId: null }
  }
  db.update(heartbeats).set(patch).where(eq(heartbeats.id, id)).run()
  return db.select().from(heartbeats).where(eq(heartbeats.id, id)).get() ?? null
}

export function deleteHeartbeat(id: string): boolean {
  const existing = db.select().from(heartbeats).where(eq(heartbeats.id, id)).get()
  if (!existing) return false
  db.delete(heartbeats).where(eq(heartbeats.id, id)).run()
  return true
}

// ── Scheduler ───────────────────────────────────────────────────────────────

// Heartbeats currently mid-run — skip re-firing until the prior turn finishes.
const running: Set<string> = (globalThis as any).__helmHbRunning ?? ((globalThis as any).__helmHbRunning = new Set())

let lastMinuteKey = -1

/** Start the once-per-minute heartbeat tick. Idempotent (guarded on globalThis). */
export function startHeartbeatScheduler(): void {
  if ((globalThis as any).__helmHbInterval) return
  // Tick every 30s but act only on minute boundaries, so we never miss or
  // double-fire a minute even with timer drift.
  ;(globalThis as any).__helmHbInterval = setInterval(tick, 30_000)
  tick()
}

function tick(): void {
  const now = new Date()
  const minuteKey = Math.floor(now.getTime() / 60_000)
  if (minuteKey === lastMinuteKey) return
  lastMinuteKey = minuteKey

  let due: Heartbeat[]
  try {
    due = db.select().from(heartbeats).all().filter((h) => h.enabled)
  } catch (err) {
    console.error('[helm] heartbeat tick failed to read db:', String(err))
    return
  }

  for (const hb of due) {
    let matches = false
    try {
      matches = cronMatches(hb.cron, now)
    } catch (err) {
      console.error(`[helm] invalid cron on heartbeat ${hb.id} ("${hb.cron}"):`, String(err))
      continue
    }
    if (!matches || running.has(hb.id)) continue

    running.add(hb.id)
    db.update(heartbeats).set({ lastRunAt: now }).where(eq(heartbeats.id, hb.id)).run()
    void fireHeartbeat(hb).finally(() => running.delete(hb.id))
  }
}

/** Resolve the heartbeat's audience and run the turn against the right session/chat. */
async function fireHeartbeat(hb: Heartbeat): Promise<void> {
  const agent = loadAgent(hb.agentId)
  if (!agent) return

  try {
    if (hb.targetType === 'chat' && hb.targetChatId) {
      // Deliver to a specific Telegram chat — run in that chat's session (under
      // sessionScope='chat') and inject HELM_CHAT_ID so send-telegram lands there.
      const chat = listAgentChats(agent.id).find((c) => c.chatId === hb.targetChatId)
      if (!chat) {
        console.error(`[helm] heartbeat ${hb.id}: target chat ${hb.targetChatId} not found — skipping`)
        return
      }
      if (chat.status === 'blocked') return
      await runAgentTurn(hb.agentId, hb.prompt, {
        source: `heartbeat:${hb.id}`,
        session: resolveSessionStore(agent, chat),
        chatId: hb.targetChatId,
      })
    } else {
      // 'main' — the agent/console session (default store), no Telegram target.
      await runAgentTurn(hb.agentId, hb.prompt, { source: `heartbeat:${hb.id}` })
    }
  } catch (err) {
    console.error(`[helm] heartbeat ${hb.id} run failed:`, String(err))
  }
}
