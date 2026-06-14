import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../../db/index.ts'
import { heartbeats } from '../../db/schema.ts'
import { cronMatches, isValidCron } from '../cron.ts'
import { runAgentTurn } from '../run.ts'
import type { Heartbeat } from '../../db/schema.ts'

// ── CRUD service (shared by tRPC router + REST route) ───────────────────────

export interface CreateHeartbeatInput {
  agentId: string
  name?: string | null
  cron: string
  prompt: string
}

export function listHeartbeats(agentId: string): Heartbeat[] {
  return db.select().from(heartbeats).where(eq(heartbeats.agentId, agentId)).all()
}

export function createHeartbeat(input: CreateHeartbeatInput): Heartbeat {
  isValidCron(input.cron) // throws on a bad expression
  const row: Heartbeat = {
    id: randomUUID(),
    agentId: input.agentId,
    name: input.name?.trim() || 'heartbeat',
    cron: input.cron.trim(),
    prompt: input.prompt,
    enabled: true,
    lastRunAt: null,
    createdAt: new Date(),
  }
  db.insert(heartbeats).values(row).run()
  return row
}

export function updateHeartbeat(
  id: string,
  patch: Partial<Pick<Heartbeat, 'name' | 'cron' | 'prompt' | 'enabled'>>,
): Heartbeat | null {
  if (patch.cron) isValidCron(patch.cron)
  const existing = db.select().from(heartbeats).where(eq(heartbeats.id, id)).get()
  if (!existing) return null
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
    runAgentTurn(hb.agentId, hb.prompt, { source: `heartbeat:${hb.id}` })
      .catch((err) => console.error(`[helm] heartbeat ${hb.id} run failed:`, String(err)))
      .finally(() => running.delete(hb.id))
  }
}
