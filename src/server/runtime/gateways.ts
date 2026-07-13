import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { gateways, gatewaysChat } from '../../db/schema.ts';
import { SHARED_SESSION_KEY } from '../paths.ts';
import { syncAgentTools } from '../tools.ts';
import { loadAgent } from '../agents.ts';
import { agentStore, runAgentTurn } from '../run.ts';
import type { SessionStore } from '../run.ts';
import { getMe, getUpdates, sendMessage } from '../gateways/telegram.ts';
import type { Agent, Gateway, GatewayChat } from '../../db/schema.ts';

// ── Gateway CRUD service (shared by tRPC router) ─────────────────────────────

export interface CreateGatewayInput {
  agentId: string;
  token: string;
}

export function listGateways(agentId: string): Gateway[] {
  return db.select().from(gateways).where(eq(gateways.agentId, agentId)).all();
}

/** Validate the token against Telegram, persist the gateway, materialize the send tool, start polling. */
export async function createGateway(
  input: CreateGatewayInput,
): Promise<Gateway & { botUsername?: string }> {
  const me = await getMe(input.token); // throws on bad token
  const row: Gateway = {
    id: randomUUID(),
    agentId: input.agentId,
    type: 'telegram',
    token: input.token,
    pollOffset: 0,
    enabled: true,
    createdAt: new Date(),
  };
  db.insert(gateways).values(row).run();
  syncAgentTools(input.agentId); // adds the send-telegram tool now that a gateway exists
  reconcileGateways();
  return { ...row, botUsername: me.username };
}

export function updateGateway(
  id: string,
  patch: Partial<Pick<Gateway, 'enabled'>>,
): Gateway | null {
  const existing = db.select().from(gateways).where(eq(gateways.id, id)).get();
  if (!existing) return null;
  db.update(gateways).set(patch).where(eq(gateways.id, id)).run();
  reconcileGateways();
  return db.select().from(gateways).where(eq(gateways.id, id)).get() ?? null;
}

export function deleteGateway(id: string): string | null {
  const existing = db.select().from(gateways).where(eq(gateways.id, id)).get();
  if (!existing) return null;
  db.delete(gateways).where(eq(gateways.id, id)).run();
  syncAgentTools(existing.agentId); // drops the send-telegram tool if no gateways remain
  reconcileGateways();
  return existing.agentId;
}

// ── Chat (conversation) service ──────────────────────────────────────────────

/** Chats belonging to any of an agent's gateways. */
export function listAgentChats(agentId: string): GatewayChat[] {
  const gws = listGateways(agentId);
  if (gws.length === 0) return [];
  return gws.flatMap((g) =>
    db.select().from(gatewaysChat).where(eq(gatewaysChat.gatewayId, g.id)).all(),
  );
}

export function getChatById(id: string): GatewayChat | null {
  return db.select().from(gatewaysChat).where(eq(gatewaysChat.id, id)).get() ?? null;
}

function getChat(gatewayId: string, chatId: string): GatewayChat | null {
  return (
    db
      .select()
      .from(gatewaysChat)
      .where(and(eq(gatewaysChat.gatewayId, gatewayId), eq(gatewaysChat.chatId, chatId)))
      .get() ?? null
  );
}

/** Find-or-create the chat row for (gateway, chatId); refresh title/last-seen. */
function upsertChat(
  gatewayId: string,
  chatId: string,
  patch: { title?: string | null; lastMessageAt?: Date },
): GatewayChat {
  const existing = getChat(gatewayId, chatId);
  if (existing) {
    const next: Partial<GatewayChat> = {};
    if (patch.title && patch.title !== existing.title) next.title = patch.title;
    if (patch.lastMessageAt) next.lastMessageAt = patch.lastMessageAt;
    if (Object.keys(next).length > 0) {
      db.update(gatewaysChat).set(next).where(eq(gatewaysChat.id, existing.id)).run();
    }
    return { ...existing, ...next };
  }
  const row: GatewayChat = {
    id: randomUUID(),
    gatewayId,
    chatId,
    claudeSessionId: null,
    title: patch.title ?? null,
    status: 'active',
    createdAt: new Date(),
    lastMessageAt: patch.lastMessageAt ?? null,
  };
  db.insert(gatewaysChat).values(row).run();
  return row;
}

export function setChatStatus(id: string, status: 'active' | 'blocked'): GatewayChat | null {
  const existing = getChatById(id);
  if (!existing) return null;
  db.update(gatewaysChat).set({ status }).where(eq(gatewaysChat.id, id)).run();
  return { ...existing, status };
}

// ── Session stores ───────────────────────────────────────────────────────────

/** Per-chat session, persisted on the gatewaysChat row. */
export function chatStore(chat: Pick<GatewayChat, 'id' | 'claudeSessionId'>): SessionStore {
  let current = chat.claudeSessionId;
  return {
    get: () => current,
    set: (sid) => {
      current = sid;
      db.update(gatewaysChat)
        .set({ claudeSessionId: sid })
        .where(eq(gatewaysChat.id, chat.id))
        .run();
    },
  };
}

/**
 * Pick the session store for a turn: isolated per-chat only when the agent opts
 * in (sessionScope='chat') AND there is a chat; otherwise the shared agent
 * session (browser, heartbeats, and every turn under sessionScope='agent').
 */
export function resolveSessionStore(
  agent: Pick<Agent, 'id' | 'claudeSessionId' | 'sessionScope'>,
  chat: GatewayChat | null,
): SessionStore {
  return agent.sessionScope === 'chat' && chat ? chatStore(chat) : agentStore(agent);
}

/** Re-exported from paths.ts (the shared home) for callers already importing from here. */
export { SHARED_SESSION_KEY };

/**
 * Pick the durable session-store directory key for a turn — the data-plane
 * sibling of `resolveSessionStore`. Isolated per chat (keyed by the stable
 * gateways_chat.id) only when the agent opts in (sessionScope='chat') AND
 * there is a chat; otherwise the shared session store.
 */
export function resolveSessionKey(
  agent: Pick<Agent, 'sessionScope'>,
  chat: GatewayChat | null,
): string {
  return agent.sessionScope === 'chat' && chat ? chat.id : SHARED_SESSION_KEY;
}

// ── Outbound ──────────────────────────────────────────────────────────────────

/** Send text to a specific Telegram chat of an agent. Used by the send-telegram tool. */
export async function sendToChat(
  agentId: string,
  chatId: string,
  text: string,
): Promise<{ sent: number }> {
  const gws = listGateways(agentId).filter((g) => g.enabled);
  for (const g of gws) {
    const chat = getChat(g.id, chatId);
    if (chat) {
      await sendMessage(g.token, chatId, text);
      return { sent: 1 };
    }
  }
  throw new Error(`no Telegram chat ${chatId} linked to this agent`);
}

// ── Poller management ───────────────────────────────────────────────────────

interface ActivePoller {
  abort: AbortController;
}

// Stored on globalThis so HMR / repeated imports don't spawn duplicate loops.
const pollers: Map<string, ActivePoller> =
  (globalThis as any).__helmPollers ?? ((globalThis as any).__helmPollers = new Map());

/** Start pollers for enabled gateways, stop pollers for ones gone/disabled. */
export function reconcileGateways(): void {
  const enabled = new Map(
    db
      .select()
      .from(gateways)
      .all()
      .filter((g) => g.enabled)
      .map((g) => [g.id, g] as const),
  );

  // Stop pollers no longer wanted.
  for (const [id, poller] of pollers) {
    if (!enabled.has(id)) {
      poller.abort.abort();
      pollers.delete(id);
    }
  }
  // Start missing pollers.
  for (const [id, gateway] of enabled) {
    if (!pollers.has(id)) {
      const abort = new AbortController();
      pollers.set(id, { abort });
      void pollLoop(gateway, abort.signal);
    }
  }
}

async function pollLoop(gateway: Gateway, signal: AbortSignal): Promise<void> {
  let offset = gateway.pollOffset;
  while (!signal.aborted) {
    let updates;
    try {
      updates = await getUpdates(gateway.token, offset, { timeout: 30, signal });
    } catch (err) {
      if (signal.aborted) break;
      console.error(`[helm] telegram poll error (gateway ${gateway.id}):`, String(err));
      await sleep(5000, signal);
      continue;
    }

    for (const u of updates) {
      offset = u.update_id + 1;
      // Persist offset immediately so we never reprocess.
      db.update(gateways).set({ pollOffset: offset }).where(eq(gateways.id, gateway.id)).run();

      const msg = u.message;
      const text = msg?.text?.trim();
      if (!msg) continue;

      const from = msg.from;
      const title = msg.chat.title ?? from?.first_name ?? from?.username ?? null;
      const chat = upsertChat(gateway.id, String(msg.chat.id), {
        title,
        lastMessageAt: new Date(),
      });
      if (!text) continue;
      // Gate: blocked chats don't spawn turns.
      if (chat.status === 'blocked') continue;

      const agent = loadAgent(gateway.agentId);
      if (!agent) continue;

      try {
        // Run the agent on the inbound message. We frame it as an external-gateway
        // message (sender + chat context) so the agent knows it must reply via its
        // send-telegram tool — its plain turn text is NOT delivered to Telegram.
        // The behavioural "how to respond" lives in CLAUDE.md (renderClaudeMd).
        const senderName = from?.first_name ?? from?.username ?? 'unknown';
        const senderHandle = from?.username ? ` (@${from.username})` : '';
        const framed =
          `[Inbound message via Telegram]\n` +
          `Gateway: telegram\n` +
          `From: ${senderName}${senderHandle}\n` +
          `Chat ID: ${msg.chat.id}\n\n` +
          `${text}\n\n` +
          `(This message arrived from an external gateway. Reply to this person by ` +
          `calling the send-telegram tool — your normal reply text is not delivered to them.)`;
        await runAgentTurn(gateway.agentId, framed, {
          source: `telegram:${msg.chat.id}`,
          session: resolveSessionStore(agent, chat),
          sessionKey: resolveSessionKey(agent, chat),
          chatId: String(msg.chat.id),
        });
      } catch (err) {
        console.error(`[helm] agent run failed for gateway ${gateway.id}:`, String(err));
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
