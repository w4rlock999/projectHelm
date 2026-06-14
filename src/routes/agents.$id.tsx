import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '#/components/ui/button'
import { ChatView } from '#/components/chat/ChatView'
import { ToolsPanel } from '#/components/agent/ToolsPanel'
import { ChannelsPanel } from '#/components/agent/ChannelsPanel'
import { HeartbeatsPanel } from '#/components/agent/HeartbeatsPanel'
import { trpc } from '#/lib/trpc'

export const Route = createFileRoute('/agents/$id')({ component: AgentPage })

const TABS = ['Chat', 'Tools', 'Interfaces', 'Heartbeats'] as const
type Tab = (typeof TABS)[number]

function AgentPage() {
  const { id } = Route.useParams()
  const [promptOpen, setPromptOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('Chat')

  const utils = trpc.useUtils()
  const { data: agent, error } = trpc.agents.get.useQuery({ id })
  const resetMutation = trpc.agents.resetSession.useMutation({
    onSuccess: () => {
      utils.agents.get.invalidate({ id })
      utils.agents.list.invalidate()
    },
  })

  function onReset() {
    if (!agent) return
    if (!confirm(`Reset conversation? "${agent.name}" will forget the chat history.`)) return
    resetMutation.mutate({ id: agent.id })
  }

  if (error) {
    return (
      <div className="mx-auto max-w-4xl p-8">
        <Button variant="ghost" asChild className="mb-4">
          <Link to="/">← Back</Link>
        </Button>
        <p className="text-sm text-destructive">{error.message}</p>
      </div>
    )
  }
  if (!agent) {
    return <p className="p-8 text-sm text-muted-foreground">Loading…</p>
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Button variant="ghost" asChild className="mb-4">
        <Link to="/">← Back</Link>
      </Button>

      <header className="flex items-start justify-between mb-4 gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold truncate">{agent.name}</h1>
          <p className="text-xs text-muted-foreground mt-1">
            model: {agent.model ?? 'sonnet'}
            {agent.claudeSessionId
              ? ` · session ${agent.claudeSessionId.slice(0, 8)}…`
              : ' · no session yet'}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPromptOpen((v) => !v)}
            aria-expanded={promptOpen}
          >
            {promptOpen ? 'Hide prompt' : 'Show prompt'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onReset}
            disabled={!agent.claudeSessionId || resetMutation.isPending}
          >
            Reset session
          </Button>
        </div>
      </header>

      {promptOpen ? (
        <section className="mb-4 rounded-md border bg-muted/30 px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground mb-1">System prompt (CLAUDE.md)</p>
          <pre className="text-xs whitespace-pre-wrap leading-relaxed">{agent.systemPrompt}</pre>
        </section>
      ) : null}

      <nav className="mb-4 flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              'px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ' +
              (tab === t
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground')
            }
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === 'Chat' && (
        <ChatView agent={agent} onSessionAppeared={() => utils.agents.get.invalidate({ id })} />
      )}
      {tab === 'Tools' && <ToolsPanel agentId={agent.id} />}
      {tab === 'Interfaces' && <ChannelsPanel agentId={agent.id} />}
      {tab === 'Heartbeats' && <HeartbeatsPanel agentId={agent.id} />}
    </div>
  )
}
