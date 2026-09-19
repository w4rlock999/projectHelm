import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { AddRemoteDialog } from '#/components/remotes/AddRemoteDialog';
import { Button } from '#/components/ui/button';
import { claudeSkew, type SkewLevel } from '#/lib/harness-version';
import { trpc, type Remote, type RemotePing } from '#/lib/trpc';

export const Route = createFileRoute('/remotes')({ component: RemotesPage });

type PingState = RemotePing | 'pending';

/** What this machine runs — the local half of every version comparison below. */
interface LocalSide {
  helmVersion: string;
  build: string;
  claudeVersion: string | null;
}

function RemotesPage() {
  const utils = trpc.useUtils();
  const { data: remotes, isLoading } = trpc.remotes.list.useQuery();
  const { data: system } = trpc.system.status.useQuery();
  const local: LocalSide | null = system
    ? { helmVersion: system.version, build: system.build, claudeVersion: system.harness.version }
    : null;
  const [adding, setAdding] = useState(false);
  const [pings, setPings] = useState<Record<string, PingState>>({});

  const pingMutation = trpc.remotes.ping.useMutation();
  const removeMutation = trpc.remotes.remove.useMutation({
    onSuccess: () => utils.remotes.list.invalidate(),
    // Removing a remote that still hosts agents is refused server-side — say so
    // rather than failing silently.
    onError: (err) => alert(err.message),
  });
  const pauseMutation = trpc.remotes.setPaused.useMutation();

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
              local={local}
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
              pausing={pauseMutation.isPending && pauseMutation.variables?.id === r.id}
              onSetPaused={(paused) => {
                pauseMutation.mutate(
                  { id: r.id, paused, reason: paused ? 'paused from the console' : undefined },
                  { onSuccess: () => ping(r.id) },
                );
              }}
            />
          ))}
        </ul>
      )}

      {adding && <AddRemoteDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

/** Badge colour for a version comparison: amber = warning, red = ship will refuse. */
const SKEW_CLASS: Record<SkewLevel, string> = {
  same: '',
  patch: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  minor: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  unknown: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};

function SkewBadge({ level, title }: { level: SkewLevel; title: string }) {
  if (level === 'same') return null;
  return (
    <span
      title={title}
      className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${SKEW_CLASS[level]}`}
    >
      {level === 'patch' ? 'patch drift' : level === 'minor' ? 'version mismatch' : 'unknown'}
    </span>
  );
}

function RemoteRow({
  remote,
  local,
  ping,
  onPing,
  onRemove,
  removing,
  onSetPaused,
  pausing,
}: {
  remote: Remote;
  local: LocalSide | null;
  ping: PingState | undefined;
  onPing: () => void;
  onRemove: () => void;
  removing: boolean;
  onSetPaused: (paused: boolean) => void;
  pausing: boolean;
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
  // Same version, different code: HELM_VERSION rarely moves between deploys,
  // so the build sha is what actually tells the two daemons apart.
  const buildDiffers =
    info?.helmBuild !== undefined &&
    local !== null &&
    info.helmVersion === local.helmVersion &&
    info.helmBuild !== local.build;

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
            {info?.helmBuild ? (
              <span
                className="font-mono text-xs"
                title={buildDiffers ? `local build is ${local?.build}` : undefined}
              >
                {' '}
                ({info.helmBuild}
                {buildDiffers ? ' ≠ local' : ''})
              </span>
            ) : null}
            {harnesses.map((h) => {
              const skew =
                h.type === 'claude-code' && local
                  ? claudeSkew(local.claudeVersion, h.version)
                  : null;
              return (
                <span key={h.type}>
                  {' · '}
                  {h.type} {h.version ?? '?'}
                  {h.authOk ? '' : ' (auth ✗)'}
                  {skew && <SkewBadge level={skew.level} title={skew.message ?? ''} />}
                </span>
              );
            })}
            {info ? ` · ${info.agentCount} agent${info.agentCount === 1 ? '' : 's'}` : ''}
            {info?.deployedAgentCount ? ` (${info.deployedAgentCount} deployed)` : ''}
            {!info && lastSeen ? ` · last seen ${lastSeen.toLocaleString()}` : ''}
          </p>
          {info?.paused && (
            <p className="mt-1 text-sm text-amber-600">
              Runs are paused on this remote — its heartbeats and gateways accept nothing.
            </p>
          )}
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
          {info?.paused !== undefined && (
            <Button
              variant="outline"
              size="sm"
              disabled={pausing}
              onClick={() => onSetPaused(!info.paused)}
            >
              {pausing ? '…' : info.paused ? 'Resume' : 'Pause'}
            </Button>
          )}
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
