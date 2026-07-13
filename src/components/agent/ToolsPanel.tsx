import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '../ui/button';
import { ToolDialog } from '../tools/ToolDialog';
import { trpc, type AgentToolView } from '#/lib/trpc';

export function ToolsPanel({ agentId }: { agentId: string }) {
  const utils = trpc.useUtils();
  const { data: tools } = trpc.tools.forAgent.useQuery({ agentId });
  const [editing, setEditing] = useState<AgentToolView | null>(null);
  const [creating, setCreating] = useState(false);

  const invalidate = () => {
    utils.tools.forAgent.invalidate({ agentId });
    utils.tools.list.invalidate();
  };
  const assignMutation = trpc.tools.assign.useMutation({ onSuccess: invalidate });
  const unassignMutation = trpc.tools.unassign.useMutation({ onSuccess: invalidate });
  const toggling = assignMutation.isPending || unassignMutation.isPending;

  function toggle(t: AgentToolView) {
    if (t.assigned) unassignMutation.mutate({ agentId, toolId: t.id });
    else assignMutation.mutate({ agentId, toolId: t.id });
  }

  const assignedCount = tools?.filter((t) => t.assigned).length ?? 0;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Tools</h2>
          <p className="text-muted-foreground text-sm">
            Assign tools from the{' '}
            <Link to="/tools" className="underline">
              shared library
            </Link>{' '}
            to this agent. Assigned tools are written to its <code className="text-xs">tools/</code>{' '}
            and described in its CLAUDE.md. {assignedCount} assigned.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>New tool</Button>
      </div>

      {!tools || tools.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
          The tool library is empty.{' '}
          <button className="underline" onClick={() => setCreating(true)}>
            Create a tool
          </button>{' '}
          to assign it here. (The agent still has the built-in <code>heartbeat</code> tool.)
        </p>
      ) : (
        <ul className="space-y-2">
          {tools.map((t) => (
            <li
              key={t.id}
              className={
                'rounded-md border px-4 py-3 ' + (t.assigned ? 'bg-muted/30' : 'opacity-90')
              }
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {t.name}{' '}
                    <span className="text-muted-foreground text-xs font-normal">
                      ({t.interpreter})
                    </span>
                    {t.assigned ? (
                      <span className="ml-2 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600">
                        assigned
                      </span>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground text-sm">{t.description}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant={t.assigned ? 'outline' : 'default'}
                    size="sm"
                    disabled={toggling}
                    onClick={() => toggle(t)}
                  >
                    {t.assigned ? 'Unassign' : 'Assign'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(t)}>
                    Edit
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
