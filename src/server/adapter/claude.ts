import { spawn } from 'node:child_process'
import type { AdapterContext, AgentAdapter, ClaudeEvent } from './types.ts'

const DEFAULT_MODEL = 'sonnet'

// Tools pre-granted when an agent doesn't declare its own allow-list.
// In `-p` mode, Claude Code cannot ask interactively — so anything NOT in
// --allowedTools is denied and surfaces as an "X needs permission" message
// in the assistant's response. This default is the safe-non-destructive set
// (file IO scoped to workspace cwd + web access). Bash is intentionally
// excluded — agents that need shell exec must opt in via their allowedTools.
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
]

export const claudeAdapter: AgentAdapter = {
  type: 'claude-code',
  execute(ctx) {
    return runClaude(ctx)
  },
}

export function runClaude(ctx: AdapterContext): Promise<{ code: number | null }> {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ]

  if (ctx.agent.claudeSessionId) {
    args.push('--resume', ctx.agent.claudeSessionId)
  }
  const allowedTools =
    ctx.agent.allowedTools && ctx.agent.allowedTools.length > 0
      ? ctx.agent.allowedTools
      : DEFAULT_ALLOWED_TOOLS
  args.push('--allowedTools', allowedTools.join(','))
  args.push('--model', ctx.agent.model ?? DEFAULT_MODEL)

  const proc = spawn('claude', args, {
    cwd: ctx.agent.workspaceDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: ctx.env ? { ...process.env, ...ctx.env } : process.env,
  })

  proc.stdin.write(ctx.prompt)
  proc.stdin.end()

  const onAbort = () => {
    if (!proc.killed) proc.kill('SIGTERM')
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })

  let buf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    ctx.onLog('stdout', chunk)
    buf += chunk
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let evt: ClaudeEvent
      try {
        evt = JSON.parse(line) as ClaudeEvent
      } catch {
        continue
      }
      if (evt.type === 'system' && evt.subtype === 'init') {
        ctx.onSessionId(evt.session_id)
      }
      ctx.onEvent(evt)
    }
  })

  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => ctx.onLog('stderr', chunk))

  return new Promise((resolve, reject) => {
    proc.on('error', (err) => {
      ctx.signal.removeEventListener('abort', onAbort)
      reject(err)
    })
    proc.on('close', (code) => {
      ctx.signal.removeEventListener('abort', onAbort)
      resolve({ code })
    })
  })
}
