import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  allowedTools: text('allowed_tools'),
  model: text('model'),
  claudeSessionId: text('claude_session_id'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export type Agent = typeof agents.$inferSelect
export type NewAgent = typeof agents.$inferInsert
