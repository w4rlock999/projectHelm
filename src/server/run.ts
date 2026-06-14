import { createWriteStream, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runClaude } from './adapter/claude.ts'
import { agentRuntime, loadAgent, updateAgentSessionId } from './agents.ts'
import { paths } from './paths.ts'
import type { ClaudeEvent } from './adapter/types.ts'

export interface AgentTurnResult {
  runId: string
  text: string
  sessionId: string | null
  code: number | null
  isError: boolean
}

// Per-agent serialization. Headless triggers (heartbeats, inbound channel
// messages) can fire concurrently for the same agent; running two `--resume`
// turns against one Claude session at once corrupts it. We chain each agent's
// turns through a single in-flight promise so they execute one at a time.
const agentChains = new Map<string, Promise<unknown>>()

function enqueue<T>(agentId: string, task: () => Promise<T>): Promise<T> {
  const prev = agentChains.get(agentId) ?? Promise.resolve()
  const next = prev.then(task, task)
  // Keep the chain alive but don't leak rejections into the next link's catch.
  agentChains.set(
    agentId,
    next.catch(() => undefined),
  )
  return next
}

/**
 * Run one headless agent turn to completion and return the final assistant
 * text. Reuses the same `runClaude` primitive and `.ndjson` run logs as the SSE
 * chat route, persists the resolved session id, and serializes turns per agent.
 *
 * The SSE chat route keeps its own streaming path; this is for triggers that
 * just need the result (cron heartbeats, inbound Telegram messages).
 */
export function runAgentTurn(
  agentId: string,
  prompt: string,
  opts: { source?: string; signal?: AbortSignal } = {},
): Promise<AgentTurnResult> {
  return enqueue(agentId, async () => {
    const agent = loadAgent(agentId)
    if (!agent) throw new Error(`agent ${agentId} not found`)

    const runId = randomUUID()
    mkdirSync(paths.agentLogsDir(agent.id), { recursive: true })
    const logStream = createWriteStream(paths.agentLogFile(agent.id, runId), { flags: 'a' })
    logStream.write(
      JSON.stringify({ type: 'helm_meta', source: opts.source ?? 'manual', prompt, runId }) + '\n',
    )

    let text = ''
    let sessionId: string | null = agent.claudeSessionId
    let isError = false
    const signal = opts.signal ?? new AbortController().signal

    try {
      const { code } = await runClaude({
        agent: agentRuntime(agent),
        prompt,
        signal,
        onEvent: (evt: ClaudeEvent) => {
          logStream.write(JSON.stringify(evt) + '\n')
          if (evt.type === 'result') {
            text = evt.result ?? ''
            isError = evt.is_error
          }
        },
        onLog: () => {
          /* stdout already captured via onEvent; stderr is debug-only */
        },
        onSessionId: (sid) => {
          sessionId = sid
          if (sid !== agent.claudeSessionId) updateAgentSessionId(agent.id, sid)
        },
      })
      return { runId, text, sessionId, code, isError }
    } finally {
      logStream.end()
    }
  })
}
