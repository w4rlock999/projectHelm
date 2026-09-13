import { useState } from 'react';
import { Button } from '#/components/ui/button';
import { trpc, type Run } from '#/lib/trpc';

// The run ledger, per agent. Before this the only record of a turn was an
// .ndjson file nothing read back, so refusals and headless failures were
// invisible — a heartbeat that never fired looked identical to one that did.

const STATUS_STYLES: Record<string, string> = {
  ok: 'bg-emerald-500',
  error: 'bg-red-500',
  refused: 'bg-amber-500',
  interrupted: 'bg-muted-foreground/50',
  running: 'bg-blue-500 animate-pulse',
  queued: 'bg-muted-foreground/40 animate-pulse',
};

const REFUSAL_LABELS: Record<string, string> = {
  budget: 'hourly run budget reached',
  paused: 'daemon paused',
  deployed: 'agent is deployed to a remote',
  transferring: 'agent is mid-transfer',
};

function duration(r: Run): string | null {
  if (!r.endedAt || !r.startedAt) return null;
  const ms = new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime();
  if (ms < 0) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function RunsPanel({ agentId }: { agentId: string }) {
  const { data, isLoading, refetch, isFetching } = trpc.agents.runs.useQuery({ id: agentId });
  const [expanded, setExpanded] = useState<string | null>(null);

  if (isLoading) return <p className="text-muted-foreground text-sm">Loading…</p>;

  const runs = data ?? [];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Every turn, from every source — console, heartbeats, and gateways.
        </p>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => refetch()}>
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {runs.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-12 text-center text-sm">
          No runs yet.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {runs.map((r) => {
            const dot = STATUS_STYLES[r.status] ?? 'bg-muted-foreground/40';
            const isOpen = expanded === r.id;
            return (
              <li key={r.id} className="rounded-md border px-3 py-2">
                <button
                  className="flex w-full items-start gap-2 text-left"
                  onClick={() => setExpanded(isOpen ? null : r.id)}
                  aria-expanded={isOpen}
                >
                  <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${dot}`} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-xs">{r.source}</span>
                      <span className="text-muted-foreground text-xs">
                        {new Date(r.startedAt).toLocaleString()}
                        {duration(r) ? ` · ${duration(r)}` : ''}
                      </span>
                    </span>
                    <span className="text-muted-foreground mt-0.5 block truncate text-sm">
                      {r.status === 'refused'
                        ? `Refused — ${REFUSAL_LABELS[r.refusedReason ?? ''] ?? r.refusedReason}`
                        : r.prompt}
                    </span>
                  </span>
                </button>
                {isOpen && (
                  <div className="mt-2 space-y-2 border-t pt-2">
                    <div>
                      <p className="text-muted-foreground mb-0.5 text-xs font-medium">Prompt</p>
                      <pre className="text-xs whitespace-pre-wrap">{r.prompt}</pre>
                    </div>
                    {r.resultText && (
                      <div>
                        <p className="text-muted-foreground mb-0.5 text-xs font-medium">
                          {r.isError ? 'Error' : 'Result'}
                        </p>
                        <pre
                          className={
                            'text-xs whitespace-pre-wrap ' + (r.isError ? 'text-destructive' : '')
                          }
                        >
                          {r.resultText}
                        </pre>
                      </div>
                    )}
                    <p className="text-muted-foreground font-mono text-[11px]">
                      run {r.id}
                      {r.exitCode !== null ? ` · exit ${r.exitCode}` : ''}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
