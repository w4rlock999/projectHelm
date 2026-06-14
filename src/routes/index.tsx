import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { AgentCard } from '#/components/AgentCard'
import { CreateAgentDialog } from '#/components/CreateAgentDialog'
import { Button } from '#/components/ui/button'
import { trpc } from '#/lib/trpc'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const navigate = useNavigate()
  const { data: agents, error, isLoading } = trpc.agents.list.useQuery()

  return (
    <div className="mx-auto max-w-6xl p-8">
      <header className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">helmConsole</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Wrap Claude Code into custom agents. Local agent factory POC.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link to="/tools">Tool Library</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/captain">⎈ helmCaptain</Link>
          </Button>
          <CreateAgentDialog
            onCreated={(a) => {
              navigate({ to: '/agents/$id', params: { id: a.id } })
            }}
          />
        </div>
      </header>

      <Link
        to="/captain"
        className="mb-6 flex items-center justify-between rounded-lg border bg-muted/30 px-5 py-4 transition-colors hover:bg-muted/50"
      >
        <div>
          <p className="font-medium">⎈ Chat with helmCaptain</p>
          <p className="text-sm text-muted-foreground">
            Your operator agent — design agents, draft tools, and plan orchestration.
          </p>
        </div>
        <span className="text-muted-foreground" aria-hidden>
          →
        </span>
      </Link>

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
