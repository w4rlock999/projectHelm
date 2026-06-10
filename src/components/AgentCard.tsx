import { Link } from '@tanstack/react-router'
import { Button } from './ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card'
import { trpc, type Agent } from '#/lib/trpc'

interface Props {
  agent: Agent
}

export function AgentCard({ agent }: Props) {
  const utils = trpc.useUtils()
  const resetMutation = trpc.agents.resetSession.useMutation({
    onSuccess: () => {
      utils.agents.list.invalidate()
      utils.agents.get.invalidate({ id: agent.id })
    },
  })
  const deleteMutation = trpc.agents.delete.useMutation({
    onSuccess: () => {
      utils.agents.list.invalidate()
    },
  })

  function onReset() {
    if (!confirm(`Reset conversation for "${agent.name}"? Chat history will be forgotten.`)) return
    resetMutation.mutate({ id: agent.id })
  }

  function onDelete() {
    if (!confirm(`Delete "${agent.name}"? This removes the agent and its workspace on disk.`)) return
    deleteMutation.mutate({ id: agent.id })
  }

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>{agent.name}</span>
          <span
            className={
              'text-xs font-normal px-2 py-0.5 rounded-full ' +
              (agent.claudeSessionId
                ? 'bg-emerald-500/10 text-emerald-600'
                : 'bg-muted text-muted-foreground')
            }
            title={
              agent.claudeSessionId ? `session ${agent.claudeSessionId}` : 'no active session'
            }
          >
            {agent.claudeSessionId ? 'session active' : 'no session'}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1">
        <p className="text-sm text-muted-foreground line-clamp-4 whitespace-pre-wrap">
          {agent.systemPrompt}
        </p>
        <p className="text-xs text-muted-foreground mt-3">
          model: {agent.model ?? 'sonnet'} · created {new Date(agent.createdAt).toLocaleString()}
        </p>
      </CardContent>
      <CardFooter className="gap-2">
        <Button asChild>
          <Link to="/agents/$id" params={{ id: agent.id }}>
            Open chat
          </Link>
        </Button>
        <Button
          variant="outline"
          onClick={onReset}
          disabled={!agent.claudeSessionId || resetMutation.isPending}
        >
          Reset session
        </Button>
        <Button
          variant="ghost"
          onClick={onDelete}
          className="ml-auto"
          disabled={deleteMutation.isPending}
        >
          Delete
        </Button>
      </CardFooter>
    </Card>
  )
}
