import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '#/components/ui/button';
import { describeMcpConfig, McpServerDialog } from '#/components/mcp/McpServerDialog';
import { trpc, type McpServerView } from '#/lib/trpc';

export const Route = createFileRoute('/mcp')({ component: McpLibraryPage });

function McpLibraryPage() {
  const utils = trpc.useUtils();
  const { data: servers, isLoading } = trpc.mcp.list.useQuery();
  const [editing, setEditing] = useState<McpServerView | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = () => {
    utils.mcp.list.invalidate();
    utils.mcp.forAgent.invalidate();
  };
  const deleteMutation = trpc.mcp.delete.useMutation({ onSuccess: refresh });

  return (
    <div className="mx-auto max-w-4xl p-8">
      <Button variant="ghost" asChild className="mb-4">
        <Link to="/">← Back to fleet</Link>
      </Button>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">MCP Servers</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Define an MCP server once, then assign it to any agent from that agent's Harness tab.
            Assigned servers are rendered into the agent's isolated MCP config; env and header
            values are stored as secrets and never shown again.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>New MCP server</Button>
      </header>

      {isLoading || !servers ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : servers.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-12 text-center text-sm">
          The library is empty. Add your first MCP server.
        </p>
      ) : (
        <ul className="space-y-2">
          {servers.map((s) => (
            <li key={s.id} className="rounded-md border px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {s.name}{' '}
                    <span className="text-muted-foreground text-xs font-normal">
                      ({s.transport}
                      {s.requires.length ? ` · needs ${s.requires.join(', ')}` : ''})
                    </span>
                  </p>
                  <p className="text-muted-foreground text-sm">{s.description}</p>
                  <p className="text-muted-foreground truncate font-mono text-xs">
                    {describeMcpConfig(s)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (
                        confirm(
                          `Delete "${s.name}" from the library? It will be removed from every agent it's assigned to.`,
                        )
                      )
                        deleteMutation.mutate({ id: s.id });
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
        <McpServerDialog
          server={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
