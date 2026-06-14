import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../../db/index.ts'
import { channels } from '../../db/schema.ts'
import { syncAgentTools } from '../tools.ts'
import { runAgentTurn } from '../run.ts'
import { getMe, getUpdates, sendMessage } from '../channels/telegram.ts'
import type { Channel } from '../../db/schema.ts'

// ── CRUD service (shared by tRPC router) ────────────────────────────────────

export interface CreateChannelInput {
  agentId: string
  token: string
  chatId?: string | null
}

export function listChannels(agentId: string): Channel[] {
  return db.select().from(channels).where(eq(channels.agentId, agentId)).all()
}

/** Validate the token against Telegram, persist the channel, materialize the send tool, start polling. */
export async function createChannel(input: CreateChannelInput): Promise<Channel> {
  const me = await getMe(input.token) // throws on bad token
  const row: Channel = {
    id: randomUUID(),
    agentId: input.agentId,
    type: 'telegram',
    token: input.token,
    chatId: input.chatId ?? null,
    pollOffset: 0,
    enabled: true,
    createdAt: new Date(),
  }
  db.insert(channels).values(row).run()
  syncAgentTools(input.agentId) // adds the send-telegram tool now that a channel exists
  reconcileChannels()
  return { ...row, botUsername: me.username } as Channel & { botUsername?: string }
}

export function updateChannel(
  id: string,
  patch: Partial<Pick<Channel, 'enabled' | 'chatId'>>,
): Channel | null {
  const existing = db.select().from(channels).where(eq(channels.id, id)).get()
  if (!existing) return null
  db.update(channels).set(patch).where(eq(channels.id, id)).run()
  reconcileChannels()
  return db.select().from(channels).where(eq(channels.id, id)).get() ?? null
}

export function deleteChannel(id: string): string | null {
  const existing = db.select().from(channels).where(eq(channels.id, id)).get()
  if (!existing) return null
  db.delete(channels).where(eq(channels.id, id)).run()
  syncAgentTools(existing.agentId) // drops the send-telegram tool if no channels remain
  reconcileChannels()
  return existing.agentId
}

/** Send text to an agent's linked Telegram chat. Used by the `send-telegram` tool. */
export async function sendToAgentChannels(agentId: string, text: string): Promise<{ sent: number }> {
  const rows = listChannels(agentId).filter((c) => c.enabled && c.chatId)
  if (rows.length === 0) {
    throw new Error('no linked Telegram chat — message the bot first to establish a chat')
  }
  let sent = 0
  for (const c of rows) {
    await sendMessage(c.token, c.chatId as string, text)
    sent++
  }
  return { sent }
}

// ── Poller management ───────────────────────────────────────────────────────

interface ActivePoller {
  abort: AbortController
}

// Stored on globalThis so HMR / repeated imports don't spawn duplicate loops.
const pollers: Map<string, ActivePoller> =
  (globalThis as any).__helmPollers ?? ((globalThis as any).__helmPollers = new Map())

/** Start pollers for enabled channels, stop pollers for ones gone/disabled. */
export function reconcileChannels(): void {
  const enabled = new Map(
    db
      .select()
      .from(channels)
      .all()
      .filter((c) => c.enabled)
      .map((c) => [c.id, c] as const),
  )

  // Stop pollers no longer wanted.
  for (const [id, poller] of pollers) {
    if (!enabled.has(id)) {
      poller.abort.abort()
      pollers.delete(id)
    }
  }
  // Start missing pollers.
  for (const [id, channel] of enabled) {
    if (!pollers.has(id)) {
      const abort = new AbortController()
      pollers.set(id, { abort })
      void pollLoop(channel, abort.signal)
    }
  }
}

async function pollLoop(channel: Channel, signal: AbortSignal): Promise<void> {
  let offset = channel.pollOffset
  while (!signal.aborted) {
    let updates
    try {
      updates = await getUpdates(channel.token, offset, { timeout: 30, signal })
    } catch (err) {
      if (signal.aborted) break
      console.error(`[helm] telegram poll error (channel ${channel.id}):`, String(err))
      await sleep(5000, signal)
      continue
    }

    for (const u of updates) {
      offset = u.update_id + 1
      const msg = u.message
      const text = msg?.text?.trim()
      // Persist offset + learned chatId immediately so we never reprocess.
      const patch: Partial<Channel> = { pollOffset: offset }
      if (msg && !channel.chatId) {
        channel.chatId = String(msg.chat.id)
        patch.chatId = channel.chatId
      }
      db.update(channels).set(patch).where(eq(channels.id, channel.id)).run()
      if (!text) continue

      try {
        // Run the agent on the inbound message. The agent replies via its
        // send-telegram tool (steered by CLAUDE.md) — we don't auto-reply here.
        await runAgentTurn(channel.agentId, text, { source: `telegram:${msg!.chat.id}` })
      } catch (err) {
        console.error(`[helm] agent run failed for channel ${channel.id}:`, String(err))
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}
