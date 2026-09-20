import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '../ui/button';
import { describeMcpConfig, McpServerDialog } from '../mcp/McpServerDialog';
import { trpc, type AgentMcpServerView } from '#/lib/trpc';

// The agent's MCP servers: the library with an assign toggle per entry, like
// ToolsPanel. Lives inside the Harness tab because an assigned server is
// rendered into the agent's isolated mcp.json and granted on its allow-list —
// it is part of how its Claude Code is spawned, not a workspace script.

export function McpServersPanel({
  agentId,
  lastObserved,
}: {
  agentId: string;
  /** `lastHarness.mcpServers` — the status each assigned server had last turn. */
  lastObserved?: { name: string; status: string }[];
}) {
  const utils = trpc.useUtils();
  const { data: servers } = trpc.mcp.forAgent.useQuery({ agentId });
  const [editing, setEditing] = useState<AgentMcpServerView | null>(null);
  const [creating, setCreating] = useState(false);

  const invalidate = () => {
    utils.mcp.forAgent.invalidate({ agentId });
    utils.mcp.list.invalidate();
    utils.agents.harness.invalidate({ id: agentId });
  };
  const assign = trpc.mcp.assign.useMutation({ onSuccess: invalidate });
  const unassign = trpc.mcp.unassign.useMutation({ onSuccess: invalidate });
  const toggling = assign.isPending || unassign.isPending;
  const status = new Map((lastObserved ?? []).map((s) => [s.name, s.status]));

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-medium">MCP servers</h3>
          <p className="text-muted-foreground text-sm">
            Assign servers from the{' '}
            <Link to="/mcp" className="underline">
              MCP library
            </Link>
            . Each one is rendered into this agent's isolated MCP config and its tools are granted
            as <code className="text-xs">mcp__&lt;name&gt;</code> from the next turn.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          New MCP server
        </Button>
      </div>

      {!servers || servers.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
          No MCP servers in the library yet.{' '}
          <button className="underline" onClick={() => setCreating(true)}>
            Add one
          </button>{' '}
          to give this agent tools beyond the built-ins.
        </p>
      ) : (
        <ul className="space-y-2">
          {servers.map((s) => {
            const st = s.assigned ? status.get(s.name) : undefined;
            return (
              <li
                key={s.id}
                className={
                  'rounded-md border px-4 py-3 ' + (s.assigned ? 'bg-muted/30' : 'opacity-90')
                }
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {s.name}{' '}
                      <span className="text-muted-foreground text-xs font-normal">
                        ({s.transport})
                      </span>
                      {s.assigned ? (
                        <span className="ml-2 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600">
                          assigned
                        </span>
                      ) : null}
                      {st ? (
                        <span
                          className={
                            'ml-2 rounded-full px-2 py-0.5 text-xs ' +
                            (st === 'connected'
                              ? 'bg-emerald-500/10 text-emerald-600'
                              : 'bg-amber-500/10 text-amber-700')
                          }
                          title="status on the agent's last turn"
                        >
                          {st}
                        </span>
                      ) : s.assigned ? (
                        <span
                          className="text-muted-foreground ml-2 text-xs"
                          title="no turn has run since it was assigned"
                        >
                          not yet observed
                        </span>
                      ) : null}
                    </p>
                    <p className="text-muted-foreground text-sm">{s.description}</p>
                    <p className="text-muted-foreground truncate font-mono text-xs">
                      {describeMcpConfig(s)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant={s.assigned ? 'outline' : 'default'}
                      size="sm"
                      disabled={toggling}
                      onClick={() =>
                        s.assigned
                          ? unassign.mutate({ agentId, serverId: s.id })
                          : assign.mutate({ agentId, serverId: s.id })
                      }
                    >
                      {s.assigned ? 'Unassign' : 'Assign'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(s)}>
                      Edit
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {(creating || editing) && (
        <McpServerDialog
          server={editing}
          assignToAgentId={creating ? agentId : undefined}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={invalidate}
        />
      )}
    </section>
  );
}
