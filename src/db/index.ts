import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from './schema.ts'
import { paths } from '../server/paths.ts'

mkdirSync(dirname(paths.dbFile), { recursive: true })

const sqlite = new Database(paths.dbFile)
sqlite.pragma('journal_mode = WAL')

export const db = drizzle(sqlite, { schema })
export { schema }
