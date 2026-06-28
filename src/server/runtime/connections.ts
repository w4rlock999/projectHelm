import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index.ts'
import { connections, connectionsChat } from '../../db/schema.ts'
import { syncAgentTools } from '../tools.ts'
import { loadAgent } from '../agents.ts'
import { agentStore, runAgentTurn } from '../run.ts'
import type { SessionStore } from '../run.ts'
import { getMe, getUpdates, sendMessage } from '../connections/telegram.ts'
import type { Agent, Connection, ConnectionChat } from '../../db/schema.ts'

// ── Connection CRUD service (shared by tRPC router) ──────────────────────────

export interface CreateConnectionInput {
  agentId: string
  token: string
}

export function listConnections(agentId: string): Connection[] {
  return db.select().from(connections).where(eq(connections.agentId, agentId)).all()
}

/** Validate the token against Telegram, persist the connection, materialize the send tool, start polling. */
export async function createConnection(input: CreateConnectionInput): Promise<Connection & { botUsername?: string }> {
  const me = await getMe(input.token) // throws on bad token
  const row: Connection = {
    id: randomUUID(),
    agentId: input.agentId,
    type: 'telegram',
    token: input.token,
    pollOffset: 0,
    enabled: true,
    createdAt: new Date(),
  }
  db.insert(connections).values(row).run()
  syncAgentTools(input.agentId) // adds the send-telegram tool now that a connection exists
  reconcileConnections()
  return { ...row, botUsername: me.username }
}

export function updateConnection(
  id: string,
  patch: Partial<Pick<Connection, 'enabled'>>,
): Connection | null {
  const existing = db.select().from(connections).where(eq(connections.id, id)).get()
  if (!existing) return null
  db.update(connections).set(patch).where(eq(connections.id, id)).run()
  reconcileConnections()
  return db.select().from(connections).where(eq(connections.id, id)).get() ?? null
}

export function deleteConnection(id: string): string | null {
  const existing = db.select().from(connections).where(eq(connections.id, id)).get()
  if (!existing) return null
  db.delete(connections).where(eq(connections.id, id)).run()
  syncAgentTools(existing.agentId) // drops the send-telegram tool if no connections remain
  reconcileConnections()
  return existing.agentId
}

// ── Chat (conversation) service ──────────────────────────────────────────────

/** Chats belonging to any of an agent's connections. */
export function listAgentChats(agentId: string): ConnectionChat[] {
  const conns = listConnections(agentId)
  if (conns.length === 0) return []
  return conns.flatMap((c) =>
    db.select().from(connectionsChat).where(eq(connectionsChat.connectionId, c.id)).all(),
  )
}

export function getChatById(id: string): ConnectionChat | null {
  return db.select().from(connectionsChat).where(eq(connectionsChat.id, id)).get() ?? null
}

function getChat(connectionId: string, chatId: string): ConnectionChat | null {
  return (
    db
      .select()
      .from(connectionsChat)
      .where(and(eq(connectionsChat.connectionId, connectionId), eq(connectionsChat.chatId, chatId)))
      .get() ?? null
  )
}

/** Find-or-create the chat row for (connection, chatId); refresh title/last-seen. */
function upsertChat(
  connectionId: string,
  chatId: string,
  patch: { title?: string | null; lastMessageAt?: Date },
): ConnectionChat {
  const existing = getChat(connectionId, chatId)
  if (existing) {
    const next: Partial<ConnectionChat> = {}
    if (patch.title && patch.title !== existing.title) next.title = patch.title
    if (patch.lastMessageAt) next.lastMessageAt = patch.lastMessageAt
    if (Object.keys(next).length > 0) {
      db.update(connectionsChat).set(next).where(eq(connectionsChat.id, existing.id)).run()
    }
    return { ...existing, ...next }
  }
  const row: ConnectionChat = {
    id: randomUUID(),
    connectionId,
    chatId,
    claudeSessionId: null,
    title: patch.title ?? null,
    status: 'active',
    createdAt: new Date(),
    lastMessageAt: patch.lastMessageAt ?? null,
  }
  db.insert(connectionsChat).values(row).run()
  return row
}

export function setChatStatus(id: string, status: 'active' | 'blocked'): ConnectionChat | null {
  const existing = getChatById(id)
  if (!existing) return null
  db.update(connectionsChat).set({ status }).where(eq(connectionsChat.id, id)).run()
  return { ...existing, status }
}

// ── Session stores ───────────────────────────────────────────────────────────

/** Per-chat session, persisted on the connectionsChat row. */
export function chatStore(chat: Pick<ConnectionChat, 'id' | 'claudeSessionId'>): SessionStore {
  let current = chat.claudeSessionId
  return {
    get: () => current,
    set: (sid) => {
      current = sid
      db.update(connectionsChat).set({ claudeSessionId: sid }).where(eq(connectionsChat.id, chat.id)).run()
    },
  }
}

/**
 * Pick the session store for a turn: isolated per-chat only when the agent opts
 * in (sessionScope='chat') AND there is a chat; otherwise the shared agent
 * session (browser, heartbeats, and every turn under sessionScope='agent').
 */
export function resolveSessionStore(
  agent: Pick<Agent, 'id' | 'claudeSessionId' | 'sessionScope'>,
  chat: ConnectionChat | null,
): SessionStore {
  return agent.sessionScope === 'chat' && chat ? chatStore(chat) : agentStore(agent)
}

// ── Outbound ──────────────────────────────────────────────────────────────────

/** Send text to a specific Telegram chat of an agent. Used by the send-telegram tool. */
export async function sendToChat(agentId: string, chatId: string, text: string): Promise<{ sent: number }> {
  const conns = listConnections(agentId).filter((c) => c.enabled)
  for (const c of conns) {
    const chat = getChat(c.id, chatId)
    if (chat) {
      await sendMessage(c.token, chatId, text)
      return { sent: 1 }
    }
  }
  throw new Error(`no Telegram chat ${chatId} linked to this agent`)
}

// ── Poller management ───────────────────────────────────────────────────────

interface ActivePoller {
  abort: AbortController
}

// Stored on globalThis so HMR / repeated imports don't spawn duplicate loops.
const pollers: Map<string, ActivePoller> =
  (globalThis as any).__helmPollers ?? ((globalThis as any).__helmPollers = new Map())

/** Start pollers for enabled connections, stop pollers for ones gone/disabled. */
export function reconcileConnections(): void {
  const enabled = new Map(
    db
      .select()
      .from(connections)
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
  for (const [id, connection] of enabled) {
    if (!pollers.has(id)) {
      const abort = new AbortController()
      pollers.set(id, { abort })
      void pollLoop(connection, abort.signal)
    }
  }
}

async function pollLoop(connection: Connection, signal: AbortSignal): Promise<void> {
  let offset = connection.pollOffset
  while (!signal.aborted) {
    let updates
    try {
      updates = await getUpdates(connection.token, offset, { timeout: 30, signal })
    } catch (err) {
      if (signal.aborted) break
      console.error(`[helm] telegram poll error (connection ${connection.id}):`, String(err))
      await sleep(5000, signal)
      continue
    }

    for (const u of updates) {
      offset = u.update_id + 1
      // Persist offset immediately so we never reprocess.
      db.update(connections).set({ pollOffset: offset }).where(eq(connections.id, connection.id)).run()

      const msg = u.message
      const text = msg?.text?.trim()
      if (!msg) continue

      const from = msg.from
      const title = msg.chat.title ?? from?.first_name ?? from?.username ?? null
      const chat = upsertChat(connection.id, String(msg.chat.id), {
        title,
        lastMessageAt: new Date(),
      })
      if (!text) continue
      // Gate: blocked chats don't spawn turns.
      if (chat.status === 'blocked') continue

      const agent = loadAgent(connection.agentId)
      if (!agent) continue

      try {
        // Run the agent on the inbound message. We frame it as an external-connection
        // message (sender + chat context) so the agent knows it must reply via its
        // send-telegram tool — its plain turn text is NOT delivered to Telegram.
        // The behavioural "how to respond" lives in CLAUDE.md (renderClaudeMd).
        const senderName = from?.first_name ?? from?.username ?? 'unknown'
        const senderHandle = from?.username ? ` (@${from.username})` : ''
        const framed =
          `[Inbound message via Telegram]\n` +
          `Connection: telegram\n` +
          `From: ${senderName}${senderHandle}\n` +
          `Chat ID: ${msg.chat.id}\n\n` +
          `${text}\n\n` +
          `(This message arrived from an external connection. Reply to this person by ` +
          `calling the send-telegram tool — your normal reply text is not delivered to them.)`
        await runAgentTurn(connection.agentId, framed, {
          source: `telegram:${msg.chat.id}`,
          session: resolveSessionStore(agent, chat),
          chatId: String(msg.chat.id),
        })
      } catch (err) {
        console.error(`[helm] agent run failed for connection ${connection.id}:`, String(err))
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
