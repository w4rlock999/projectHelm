import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '#/components/ui/button'
import { ChatView } from '#/components/chat/ChatView'
import { trpc } from '#/lib/trpc'

export const Route = createFileRoute('/agents/$id')({ component: AgentPage })

function AgentPage() {
  const { id } = Route.useParams()
  const [promptOpen, setPromptOpen] = useState(false)

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

      <ChatView
        agent={agent}
        onSessionAppeared={() => utils.agents.get.invalidate({ id })}
      />
    </div>
  )
}
