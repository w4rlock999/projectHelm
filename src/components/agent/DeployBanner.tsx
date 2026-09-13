import { Button } from '#/components/ui/button';
import { trpc, type Agent } from '#/lib/trpc';

// Deployment state for an agent, plus live transfer progress.
//
// A transfer takes minutes and runs in the background, so this polls while one
// is in flight. The 'stranded' case gets the most space on purpose: it is the
// only state that needs a human decision, because guessing wrong either leaves
// the agent dead or leaves two copies answering the same Telegram bot.

const PHASE_LABELS: Record<string, string> = {
  claim: 'claiming',
  preflight: 'checking the remote',
  deactivate: 'stopping local pollers',
  export: 'building the bundle',
  upload: 'transferring',
  activate: 'starting on the remote',
  commit: 'finishing up',
  done: 'done',
  rollback: 'rolled back',
  stranded: 'needs a decision',
};

export function DeployBanner({ agent }: { agent: Agent }) {
  const utils = trpc.useUtils();
  const inFlight = agent.deployState === 'shipping' || agent.deployState === 'recalling';

  const { data: transfer } = trpc.ship.status.useQuery(
    { agentId: agent.id },
    {
      refetchInterval: inFlight ? 2000 : false,
      enabled: Boolean(agent.deployState),
    },
  );

  const resolve = trpc.ship.resolve.useMutation({
    onSuccess: () => {
      utils.agents.get.invalidate({ id: agent.id });
      utils.agents.list.invalidate();
    },
  });

  if (!agent.deployState) return null;

  const last = transfer?.log?.[transfer.log.length - 1];

  if (agent.deployState === 'stranded') {
    return (
      <section className="mb-4 rounded-md border border-red-500/40 bg-red-500/5 px-4 py-3">
        <p className="text-sm font-medium text-red-600">Transfer outcome unknown</p>
        <p className="text-muted-foreground mt-1 text-sm">
          {agent.deployError ??
            'The connection dropped at a point where the remote may or may not have taken this agent.'}{' '}
          Check the remote before deciding — marking it local while the remote is also running it
          would put two pollers on the same Telegram bot.
        </p>
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate({ agentId: agent.id, decision: 'deployed' })}
          >
            The remote has it
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate({ agentId: agent.id, decision: 'local' })}
          >
            Run it here
          </Button>
        </div>
      </section>
    );
  }

  if (inFlight) {
    return (
      <section className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-amber-700">
          <span aria-hidden className="size-2 animate-pulse rounded-full bg-amber-500" />
          {agent.deployState === 'shipping' ? 'Shipping' : 'Recalling'} —{' '}
          {PHASE_LABELS[transfer?.phase ?? ''] ?? transfer?.phase ?? 'starting'}
        </p>
        {last ? <p className="text-muted-foreground mt-1 text-sm">{last.message}</p> : null}
      </section>
    );
  }

  return (
    <section className="bg-muted/30 mb-4 rounded-md border px-4 py-3">
      <p className="text-sm font-medium">Deployed to a remote</p>
      <p className="text-muted-foreground mt-1 text-sm">
        This agent runs on its remote, not here. Its local heartbeats and gateways are inert and
        runs against it are refused. Recall it to chat with it or edit it.
      </p>
      {agent.deployError ? (
        <p className="mt-1 text-sm text-amber-600">Last transfer note: {agent.deployError}</p>
      ) : null}
    </section>
  );
}
