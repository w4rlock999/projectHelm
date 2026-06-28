/**
 * Re-materialize tools + re-render CLAUDE.md for every agent. Run after changing
 * renderClaudeMd / materializeAgentTools so existing agents pick up the new
 * managed tools block without needing a tool/connection mutation to trigger a sync.
 */
import { db } from '../src/db/index.ts'
import { agents } from '../src/db/schema.ts'
import { syncAgentTools } from '../src/server/tools.ts'

for (const a of db.select().from(agents).all()) {
  syncAgentTools(a.id)
  console.log(`resynced ${a.name} (${a.id})`)
}
