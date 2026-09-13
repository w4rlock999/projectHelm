import { useState } from 'react';
import { Button } from '#/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog';
import { trpc } from '#/lib/trpc';

/**
 * Ship an agent to a remote.
 *
 * Ship is an ownership *transfer*, not a copy, so this dialog is deliberately
 * explicit about what stops happening locally — and about the one thing that
 * does not travel, the Claude session.
 */
export function ShipDialog({
  agentId,
  agentName,
  onClose,
}: {
  agentId: string;
  agentName: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const { data: remotes, isLoading } = trpc.remotes.list.useQuery();
  const [remoteId, setRemoteId] = useState<string | null>(null);
  const [withoutData, setWithoutData] = useState(false);

  const ship = trpc.ship.ship.useMutation({
    onSuccess: () => {
      utils.agents.get.invalidate({ id: agentId });
      utils.ship.status.invalidate({ agentId });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ship “{agentName}”</DialogTitle>
          <DialogDescription>
            The agent <strong>moves</strong> to the remote. Its heartbeats and Telegram gateways
            stop running here and start running there. Recall it to bring it back.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {isLoading ? (
            <p className="text-muted-foreground text-sm">Loading remotes…</p>
          ) : !remotes?.length ? (
            <p className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
              No remotes registered. Add one on the Remotes page first.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {remotes.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setRemoteId(r.id)}
                    className={
                      'w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ' +
                      (remoteId === r.id ? 'border-primary bg-muted/50' : 'hover:bg-muted/30')
                    }
                  >
                    <span className="font-medium">{r.name}</span>{' '}
                    <span className="text-muted-foreground text-xs">{r.sshTarget}</span>
                    {r.lastVersion ? (
                      <span className="text-muted-foreground text-xs"> · helm {r.lastVersion}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={withoutData}
              onChange={(e) => setWithoutData(e.target.checked)}
            />
            <span>
              Leave the data plane behind
              <span className="text-muted-foreground block text-xs">
                The agent's store and session files normally travel with it. Skipping them makes the
                transfer faster but the agent arrives with no memory of past work.
              </span>
            </span>
          </label>

          <p className="text-muted-foreground text-xs">
            Claude sessions can't move between machines, so the shipped agent starts a fresh
            conversation. Continuity comes from its data plane.
          </p>

          {ship.error ? <p className="text-destructive text-sm">{ship.error.message}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={ship.isPending}>
            Cancel
          </Button>
          <Button
            disabled={!remoteId || ship.isPending}
            onClick={() => remoteId && ship.mutate({ agentId, remoteId, withoutData })}
          >
            {ship.isPending ? 'Starting…' : 'Ship'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
