import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from './schema.ts'
import { paths } from '../server/paths.ts'

mkdirSync(dirname(paths.dbFile), { recursive: true })

const sqlite = new Database(paths.dbFile)
sqlite.pragma('journal_mode = WAL')
// Enforce onDelete:'cascade' — deleting an agent removes its tools/channels/
// heartbeats so the scheduler/pollers never operate on orphans.
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })
export { schema }
