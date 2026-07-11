import { createWriteStream, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runClaude } from './adapter/claude.ts'
import { agentRuntime, loadAgent, updateAgentSessionId } from './agents.ts'
import { paths } from './paths.ts'
import type { ClaudeEvent } from './adapter/types.ts'
import type { Agent } from '../db/schema.ts'

export interface AgentTurnResult {
  runId: string
  text: string
  sessionId: string | null
  code: number | null
  isError: boolean
}

/**
 * The session a turn resumes/persists. Decoupling this from the agent lets a
 * turn run against either the agent's shared session (browser, heartbeats,
 * sessionScope='agent') or a per-chat session (sessionScope='chat').
 */
export interface SessionStore {
  get(): string | null
  set(sid: string): void
}

/** Agent-backed session: the shared `agents.claudeSessionId`. The default. */
export function agentStore(agent: Pick<Agent, 'id' | 'claudeSessionId'>): SessionStore {
  let current = agent.claudeSessionId
  return {
    get: () => current,
    set: (sid) => {
      current = sid
      updateAgentSessionId(agent.id, sid)
    },
  }
}

// Per-agent serialization. Headless triggers (heartbeats, inbound gateway
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
  opts: {
    source?: string
    signal?: AbortSignal
    /** Session to resume/persist. Defaults to the agent's shared session. */
    session?: SessionStore
    /**
     * Durable session-store dir key (see resolveSessionKey in runtime/gateways).
     * Defaults to 'shared' — the agent-scope / console / 'main'-heartbeat session.
     */
    sessionKey?: string
    /** Telegram chat this turn belongs to; injected as HELM_CHAT_ID. */
    chatId?: string
    /** Per-event hook (e.g. SSE streaming for the browser chat route). */
    onEvent?: (evt: ClaudeEvent) => void
    /** Fired once with the runId before streaming starts. */
    onRunId?: (runId: string) => void
  } = {},
): Promise<AgentTurnResult> {
  return enqueue(agentId, async () => {
    const agent = loadAgent(agentId)
    if (!agent) throw new Error(`agent ${agentId} not found`)

    const runId = randomUUID()
    opts.onRunId?.(runId)
    mkdirSync(paths.agentLogsDir(agent.id), { recursive: true })
    const logStream = createWriteStream(paths.agentLogFile(agent.id, runId), { flags: 'a' })
    logStream.write(
      JSON.stringify({ type: 'helm_meta', source: opts.source ?? 'manual', prompt, runId }) + '\n',
    )

    const session = opts.session ?? agentStore(agent)
    let text = ''
    let sessionId: string | null = session.get()
    let isError = false
    const signal = opts.signal ?? new AbortController().signal

    // Durable data plane, exposed to the turn's tools as env paths (cwd stays the
    // shared workspace). The agent store is shared across the agent's sessions;
    // the session store is per-conversation ('shared' unless the caller passed a
    // chat key). Per-chat session stores are created here on first use.
    const storeDir = paths.agentStoreDir(agentId)
    const sessionStoreDir = paths.agentSessionStoreDir(agentId, opts.sessionKey ?? 'shared')
    mkdirSync(storeDir, { recursive: true })
    mkdirSync(sessionStoreDir, { recursive: true })
    // Cross-session recall is a per-agent authz control (not a caller opt): when
    // enabled, expose the parent of all session stores so the agent can read
    // across its own sessions. Under 'none' the var is absent and each turn sees
    // only its own HELM_SESSION_STORE_DIR.
    const sessionsRootDir = agent.sessionRecall === 'all' ? paths.agentSessionsDir(agentId) : null

    try {
      const { code } = await runClaude({
        // Resume the store's session (per-chat or agent), not whatever the
        // agent row happens to hold.
        agent: { ...agentRuntime(agent), claudeSessionId: session.get() },
        prompt,
        signal,
        env: {
          HELM_AGENT_STORE_DIR: storeDir,
          HELM_SESSION_STORE_DIR: sessionStoreDir,
          ...(sessionsRootDir ? { HELM_SESSIONS_DIR: sessionsRootDir } : {}),
          ...(opts.chatId ? { HELM_CHAT_ID: opts.chatId } : {}),
        },
        onEvent: (evt: ClaudeEvent) => {
          logStream.write(JSON.stringify(evt) + '\n')
          opts.onEvent?.(evt)
          if (evt.type === 'result') {
            text = evt.result ?? ''
            isError = evt.is_error
          }
        },
        onLog: () => {
          /* stdout already captured via onEvent; stderr is debug-only */
        },
        onSessionId: (sid) => {
          if (sid !== sessionId) {
            sessionId = sid
            session.set(sid)
          }
        },
      })
      return { runId, text, sessionId, code, isError }
    } finally {
      logStream.end()
    }
  })
}
