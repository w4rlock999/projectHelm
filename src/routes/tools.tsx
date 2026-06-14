import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '#/components/ui/button'
import { ToolDialog } from '#/components/tools/ToolDialog'
import { trpc, type Tool } from '#/lib/trpc'

export const Route = createFileRoute('/tools')({ component: ToolLibraryPage })

function ToolLibraryPage() {
  const utils = trpc.useUtils()
  const { data: tools, isLoading } = trpc.tools.list.useQuery()
  const [editing, setEditing] = useState<Tool | null>(null)
  const [creating, setCreating] = useState(false)

  const deleteMutation = trpc.tools.delete.useMutation({
    onSuccess: () => utils.tools.list.invalidate(),
  })

  const refresh = () => {
    utils.tools.list.invalidate()
    // forAgent views depend on the library too.
    utils.tools.forAgent.invalidate()
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <Button variant="ghost" asChild className="mb-4">
        <Link to="/">← Back to fleet</Link>
      </Button>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Tool Library</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Author a tool once, then assign it to any agent from that agent's Tools tab. Built-in
            tools (heartbeat, send-telegram) aren't shown here — they're generated per agent.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>New tool</Button>
      </header>

      {isLoading || !tools ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tools.length === 0 ? (
        <p className="rounded-md border border-dashed p-12 text-center text-sm text-muted-foreground">
          The library is empty. Create your first tool.
        </p>
      ) : (
        <ul className="space-y-2">
          {tools.map((t) => (
            <li key={t.id} className="rounded-md border px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {t.name}{' '}
                    <span className="text-xs font-normal text-muted-foreground">
                      ({t.interpreter})
                    </span>
                  </p>
                  <p className="text-sm text-muted-foreground">{t.description}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditing(t)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (
                        confirm(
                          `Delete "${t.name}" from the library? It will be removed from every agent it's assigned to.`,
                        )
                      )
                        deleteMutation.mutate({ id: t.id })
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(creating || editing) && (
        <ToolDialog
          tool={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
          onSaved={refresh}
        />
      )}
    </div>
  )
}
