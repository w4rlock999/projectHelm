import { sql } from 'drizzle-orm'
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  allowedTools: text('allowed_tools'),
  model: text('model'),
  claudeSessionId: text('claude_session_id'),
  // helmCaptain — the operator agent that manages the fleet. Exactly one row
  // has this set; it's hidden from the normal fleet list and gets its own
  // chat surface. Everything else (runner, sessions, logs) is shared.
  isOperator: integer('is_operator', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

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
})

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
)

// Messaging-app interfaces. v0 supports Telegram only. The channel is the
// agent's outbound voice (it exposes a `send-telegram` tool) and inbound ear
// (a getUpdates long-poll loop feeds messages back as agent runs).
export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  type: text('type').notNull().default('telegram'),
  // BotFather token. Plaintext for v0 (TODO: encrypt at rest).
  token: text('token').notNull(),
  // Target chat for outbound sends; learned from the first inbound message
  // or set manually. Null until a chat is linked.
  chatId: text('chat_id'),
  // getUpdates cursor (last update_id + 1).
  pollOffset: integer('poll_offset').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

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
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export type Agent = typeof agents.$inferSelect
export type NewAgent = typeof agents.$inferInsert
export type Tool = typeof tools.$inferSelect
export type AgentTool = typeof agentTools.$inferSelect
export type Channel = typeof channels.$inferSelect
export type Heartbeat = typeof heartbeats.$inferSelect
