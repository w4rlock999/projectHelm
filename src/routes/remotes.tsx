import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { AddRemoteDialog } from '#/components/remotes/AddRemoteDialog';
import { Button } from '#/components/ui/button';
import { trpc, type Remote, type RemotePing } from '#/lib/trpc';

export const Route = createFileRoute('/remotes')({ component: RemotesPage });

type PingState = RemotePing | 'pending';

function RemotesPage() {
  const utils = trpc.useUtils();
  const { data: remotes, isLoading } = trpc.remotes.list.useQuery();
  const [adding, setAdding] = useState(false);
  const [pings, setPings] = useState<Record<string, PingState>>({});

  const pingMutation = trpc.remotes.ping.useMutation();
  const removeMutation = trpc.remotes.remove.useMutation({
    onSuccess: () => utils.remotes.list.invalidate(),
  });

  const ping = (id: string) => {
    setPings((p) => ({ ...p, [id]: 'pending' }));
    pingMutation.mutate(
      { id },
      {
        onSuccess: (res) => setPings((p) => ({ ...p, [id]: res })),
        onError: (err) =>
          setPings((p) => ({ ...p, [id]: { ok: false, error: err.message, kind: 'http' } })),
      },
    );
  };

  // Handshake each remote once when the list arrives; Ping re-checks on demand.
  const pinged = useRef(new Set<string>());
  useEffect(() => {
    for (const r of remotes ?? []) {
      if (!pinged.current.has(r.id)) {
        pinged.current.add(r.id);
        ping(r.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remotes]);

  return (
    <div className="mx-auto max-w-4xl p-8">
      <Button variant="ghost" asChild className="mb-4">
        <Link to="/">← Back to fleet</Link>
      </Button>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Remotes</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Remote deployment environments — VPSes running the helm daemon headlessly, reached over
            SSH. Set one up with <code className="text-xs">pnpm remote:init</code> on the VPS, then
            paste its connect code here.
          </p>
        </div>
        <Button onClick={() => setAdding(true)}>Add remote</Button>
      </header>

      {isLoading || !remotes ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : remotes.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-12 text-center text-sm">
          No remotes yet. Add one to deploy agents beyond this machine.
        </p>
      ) : (
        <ul className="space-y-2">
          {remotes.map((r) => (
            <RemoteRow
              key={r.id}
              remote={r}
              ping={pings[r.id]}
              onPing={() => ping(r.id)}
              onRemove={() => {
                if (
                  confirm(
                    `Remove "${r.name}"? This only unregisters it here — the remote daemon keeps running.`,
                  )
                )
                  removeMutation.mutate({ id: r.id });
              }}
              removing={removeMutation.isPending}
            />
          ))}
        </ul>
      )}

      {adding && <AddRemoteDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function RemoteRow({
  remote,
  ping,
  onPing,
  onRemove,
  removing,
}: {
  remote: Remote;
  ping: PingState | undefined;
  onPing: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const dot =
    ping === 'pending' || ping === undefined
      ? 'bg-muted-foreground/40 animate-pulse'
      : ping.ok
        ? 'bg-emerald-500'
        : 'bg-red-500';

  const info = ping && ping !== 'pending' && ping.ok ? ping.info : null;
  const version = info?.helmVersion ?? remote.lastVersion;
  const harnesses = info?.harnesses ?? remote.capabilities ?? [];
  const lastSeen = remote.lastSeenAt ? new Date(String(remote.lastSeenAt)) : null;

  return (
    <li className="rounded-md border px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-medium">
            <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${dot}`} />
            {remote.name}{' '}
            <span className="text-muted-foreground text-xs font-normal">{remote.sshTarget}</span>
          </p>
          <p className="text-muted-foreground mt-0.5 text-sm">
            {version ? `helm ${version}` : 'never reached'}
            {harnesses.map((h) => (
              <span key={h.type}>
                {' · '}
                {h.type} {h.version ?? '?'}
                {h.authOk ? '' : ' (auth ✗)'}
              </span>
            ))}
            {info ? ` · ${info.agentCount} agent${info.agentCount === 1 ? '' : 's'}` : ''}
            {!info && lastSeen ? ` · last seen ${lastSeen.toLocaleString()}` : ''}
          </p>
          {ping && ping !== 'pending' && !ping.ok && (
            <p className="text-destructive mt-1 text-sm">
              [{ping.kind}] {ping.error}
            </p>
          )}
          {ping && ping !== 'pending' && ping.ok && ping.warning && (
            <p className="mt-1 text-sm text-amber-600">{ping.warning}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" disabled={ping === 'pending'} onClick={onPing}>
            {ping === 'pending' ? 'Pinging…' : 'Ping'}
          </Button>
          <Button variant="ghost" size="sm" disabled={removing} onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>
    </li>
  );
}
