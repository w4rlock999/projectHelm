import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AgentCard } from '#/components/AgentCard'
import { CreateAgentDialog } from '#/components/CreateAgentDialog'
import { trpc } from '#/lib/trpc'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const navigate = useNavigate()
  const { data: agents, error, isLoading } = trpc.agents.list.useQuery()

  return (
    <div className="mx-auto max-w-6xl p-8">
      <header className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">projectHelm</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Wrap Claude Code into custom agents. Local agent factory POC.
          </p>
        </div>
        <CreateAgentDialog
          onCreated={(a) => {
            navigate({ to: '/agents/$id', params: { id: a.id } })
          }}
        />
      </header>

      {error ? (
        <div className="text-sm text-destructive mb-4">{error.message}</div>
      ) : null}

      {isLoading || !agents ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : agents.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <h2 className="text-lg font-medium">No agents yet</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Create your first wrapped agent to get started.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((a) => (
            <AgentCard key={a.id} agent={a} />
          ))}
        </div>
      )}
    </div>
  )
}
