import { sql } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  allowedTools: text('allowed_tools'),
  model: text('model'),
  // The session resumed when a turn's scope resolves to the agent: the browser
  // console, `target='main'` heartbeats, and *every* turn when sessionScope is
  // 'agent'. Per-chat sessions (sessionScope='chat') live on gatewaysChat.
  claudeSessionId: text('claude_session_id'),
  // 'chat' = each Telegram chat is its own isolated session; 'agent' = one
  // shared session across all chats + browser + heartbeats. New agents default
  // to 'chat' (isolated); the migration flips pre-existing agents to 'agent'.
  sessionScope: text('session_scope').notNull().default('chat'),
  // Cross-session recall authz — a single coarse knob (no per-principal ACL).
  // 'none' = the agent only ever sees the current session's store; 'all' = it
  // may read across *every* one of its session stores (exposed as
  // HELM_SESSIONS_DIR). Under 'none' the agent loses context between sessions.
  // New agents default to 'none' (isolated).
  sessionRecall: text('session_recall').notNull().default('none'),
  // helmCaptain — the operator agent that manages the fleet. Exactly one row
  // has this set; it's hidden from the normal fleet list and gets its own
  // chat surface. Everything else (runner, sessions, logs) is shared.
  isOperator: integer('is_operator', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// The shared tool library: user-authored custom tool *definitions*, owned by no
// single agent. Agents reference them via `agentTools`. When an agent is
// assigned a tool, it's materialized to that agent's `workspace/tools/<name>`
// (executable) and described in its CLAUDE.md so it can invoke it via Bash.
// Built-in tools (heartbeat, send-telegram) are generated at materialization
// time and do NOT live here.
export const tools = sqliteTable('tools', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  // Interpreter used for the shebang + filename extension, e.g. 'bash' | 'node' | 'python3'.
  interpreter: text('interpreter').notNull().default('bash'),
  source: text('source').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Many-to-many: which library tools each agent has been assigned. Assigning a
// tool materializes it into the agent's workspace; unassigning removes it.
export const agentTools = sqliteTable(
  'agent_tools',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    toolId: text('tool_id')
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.toolId] })],
);

// A gateway is the agent's credentialed binding to a messaging platform
// (v0: Telegram only) — its outbound voice (the `send-telegram` tool) and
// inbound ear (a getUpdates long-poll loop feeds messages back as agent runs).
// Individual conversations under a gateway are rows in `gateways_chat`.
export const gateways = sqliteTable('gateways', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  type: text('type').notNull().default('telegram'),
  // BotFather token. Plaintext for v0 (TODO: encrypt at rest).
  token: text('token').notNull(),
  // getUpdates cursor (last update_id + 1). Per-bot — one long-poll per token.
  pollOffset: integer('poll_offset').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// One conversation under a gateway, keyed by Telegram chat.id — the
// principal. Holds the per-chat Claude session (when the agent's sessionScope
// is 'chat'), a status gate, and a human-readable title for the UI.
export const gatewaysChat = sqliteTable(
  'gateways_chat',
  {
    id: text('id').primaryKey(),
    gatewayId: text('gateway_id')
      .notNull()
      .references(() => gateways.id, { onDelete: 'cascade' }),
    // Telegram chat.id. For DMs this equals the user's id; for groups it's the
    // room. The unit of session isolation and the outbound reply target.
    chatId: text('chat_id').notNull(),
    // Per-chat session, resumed when sessionScope='chat'. Null until first turn.
    claudeSessionId: text('claude_session_id'),
    // Display only: chat.title for groups, first_name/@username for DMs.
    title: text('title'),
    // 'active' | 'blocked' — blocked chats don't spawn turns.
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    lastMessageAt: integer('last_message_at', { mode: 'timestamp' }),
  },
  (t) => [uniqueIndex('gateway_chat_uq').on(t.gatewayId, t.chatId)],
);

// A registered remote deployment environment: a VPS running this same helm
// daemon headlessly (docs/helmship-plan.md). Reached over an SSH tunnel; the
// pairing token authenticates every request to its /api surface.
export const remotes = sqliteTable('remotes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // 'user@host[:port]' — handed to the system ssh, so ~/.ssh/config, keys and
  // the agent all apply.
  sshTarget: text('ssh_target').notNull(),
  // Port the remote daemon listens on (bound to 127.0.0.1 on the remote).
  helmPort: integer('helm_port').notNull().default(5555),
  // Pairing token. Plaintext for v1 (same posture as gateways.token —
  // encrypt-at-rest is a later milestone).
  token: text('token').notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  lastVersion: text('last_version'),
  // Harness capabilities advertised by the last successful handshake.
  capabilities: text('capabilities', { mode: 'json' }).$type<
    { type: string; version: string | null; authOk: boolean }[]
  >(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Cron-scheduled prompts fired into the agent by the wrapper. The agent can
// self-manage these via the built-in `heartbeat` tool.
export const heartbeats = sqliteTable('heartbeats', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // Standard 5-field cron: `min hour dom month dow`.
  cron: text('cron').notNull(),
  prompt: text('prompt').notNull(),
  // Audience for the fired turn: 'main' = the agent/console session (today's
  // behavior — reaches Telegram only if the agent calls send-telegram --chat);
  // 'chat' = a specific Telegram chat (delivers there, runs in that chat's
  // session under sessionScope='chat'). 'all' (broadcast) is reserved.
  targetType: text('target_type').notNull().default('main'),
  // Telegram chat.id when targetType = 'chat'.
  targetChatId: text('target_chat_id'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Tool = typeof tools.$inferSelect;
export type AgentTool = typeof agentTools.$inferSelect;
export type Gateway = typeof gateways.$inferSelect;
export type GatewayChat = typeof gatewaysChat.$inferSelect;
export type Heartbeat = typeof heartbeats.$inferSelect;
export type Remote = typeof remotes.$inferSelect;
