/**
 * Smoke test for the shared tool library + per-agent assignment (no Claude /
 * Telegram needed).
 *
 *   pnpm tsx scripts/smoke-tools.ts
 *
 * Exercises the full lifecycle: create a library tool, assign it to two agents
 * (materialized on disk for both), edit it (re-materialized), unassign from one
 * (removed there only), delete it (removed everywhere). Cleans up after itself.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createAgent, deleteAgent } from '../src/server/agents.ts'
import {
  assignTool,
  createLibraryTool,
  deleteLibraryTool,
  toolFileName,
  unassignTool,
  updateLibraryTool,
} from '../src/server/tools.ts'
import { paths } from '../src/server/paths.ts'

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[smoke-tools] FAIL: ${msg}`)
    process.exit(1)
  }
  console.log(`[smoke-tools] ok: ${msg}`)
}

function isExecutable(path: string): boolean {
  return existsSync(path) && (statSync(path).mode & 0o111) !== 0
}

const a1 = createAgent({ name: 'Tool Smoke A', systemPrompt: 'Agent A.', allowedTools: null, model: 'sonnet' })
const a2 = createAgent({ name: 'Tool Smoke B', systemPrompt: 'Agent B.', allowedTools: null, model: 'sonnet' })
const file1 = (id: string) => `${paths.agentToolsDir(id)}/${toolFileName('Greet Person')}`

try {
  // Built-in heartbeat present on both even with no library tools assigned.
  assert(isExecutable(`${paths.agentToolsDir(a1.id)}/heartbeat`), 'agent A has built-in heartbeat')

  // Create a library tool — not on any agent's disk yet.
  const tool = createLibraryTool({
    name: 'Greet Person',
    description: 'Greets someone by name',
    interpreter: 'bash',
    source: 'echo "hello, $1"',
  })
  assert(!existsSync(file1(a1.id)), 'library tool not materialized before assignment')

  // Assign to A → materialized + documented for A only.
  assignTool(a1.id, tool.id)
  assert(isExecutable(file1(a1.id)), 'assigned tool materialized + executable on agent A')
  assert(
    readFileSync(paths.agentClaudeMd(a1.id), 'utf8').includes('### greet-person'),
    "agent A's CLAUDE.md documents the assigned tool",
  )
  assert(!existsSync(file1(a2.id)), 'agent B unaffected by A assignment')

  // Assign to B too → shared.
  assignTool(a2.id, tool.id)
  assert(isExecutable(file1(a2.id)), 'same library tool materialized on agent B')

  // Edit the library tool → re-materialized for all assignees.
  updateLibraryTool(tool.id, { source: 'echo "HELLO, $1"' })
  assert(readFileSync(file1(a1.id), 'utf8').includes('HELLO'), 'edit re-materialized for agent A')
  assert(readFileSync(file1(a2.id), 'utf8').includes('HELLO'), 'edit re-materialized for agent B')

  // Unassign from A only → removed there, kept on B.
  unassignTool(a1.id, tool.id)
  assert(!existsSync(file1(a1.id)), 'unassign removed tool from agent A')
  assert(existsSync(file1(a2.id)), 'agent B still has the tool')

  // Delete from library → removed from remaining assignee.
  deleteLibraryTool(tool.id)
  assert(!existsSync(file1(a2.id)), 'library delete removed tool from agent B')

  console.log('[smoke-tools] all checks passed')
} finally {
  deleteAgent(a1.id)
  deleteAgent(a2.id)
  console.log('[smoke-tools] cleaned up test agents')
}
