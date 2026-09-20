import { useEffect, useState } from 'react';
import { Button } from '#/components/ui/button';
import { trpc } from '#/lib/trpc';
import { EMPTY_DRAFT, HarnessProfileForm, type ProfileDraft } from './HarnessProfileForm';

// The agent's harness: what helm spawns its Claude Code with (the profile),
// and what the CLI reported actually loading on the last turn (the
// fingerprint). Both exist because the second is how the first is verified.

function same(a: ProfileDraft, b: ProfileDraft): boolean {
  return (
    a.effort === b.effort &&
    a.permissionMode === b.permissionMode &&
    a.maxTurns === b.maxTurns &&
    a.fallbackModel === b.fallbackModel
  );
}

export function HarnessPanel({ agentId }: { agentId: string }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.agents.harness.useQuery({ id: agentId });
  const { data: defaults } = trpc.system.harnessDefaults.useQuery();
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);

  useEffect(() => {
    if (data) setDraft(data.own ?? EMPTY_DRAFT);
  }, [data]);

  const invalidate = () => {
    utils.agents.harness.invalidate({ id: agentId });
    utils.agents.get.invalidate({ id: agentId });
  };
  const update = trpc.agents.update.useMutation({ onSuccess: invalidate });

  if (isLoading || !data) return <p className="text-muted-foreground text-sm">Loading…</p>;

  const own = data.own ?? EMPTY_DRAFT;
  const dirty = !same(draft, own);
  const isEmpty = same(draft, EMPTY_DRAFT);
  const last = data.lastObserved;

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Harness profile</h2>
        <p className="text-muted-foreground text-sm">
          How this agent's Claude Code is spawned. It runs isolated from this machine's{' '}
          <code className="text-xs">~/.claude</code>: only what helm renders loads. A field left to
          inherit takes the fleet default.
        </p>
      </div>

      <HarnessProfileForm
        value={draft}
        onChange={setDraft}
        inheritLabel="Fleet default"
        inherited={defaults ?? null}
        disabled={update.isPending}
      />

      {update.error ? <p className="text-destructive text-sm">{update.error.message}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || update.isPending}
          onClick={() => update.mutate({ id: agentId, harness: isEmpty ? null : draft })}
        >
          {update.isPending ? 'Saving…' : 'Save profile'}
        </Button>
        <Button size="sm" variant="outline" disabled={!dirty} onClick={() => setDraft(own)}>
          Revert
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={data.own === null || update.isPending}
          onClick={() => update.mutate({ id: agentId, harness: null })}
        >
          Clear (use fleet defaults)
        </Button>
        <span className="text-muted-foreground ml-auto text-xs">
          effective: {describe(data.effective)}
        </span>
      </div>

      <div>
        <h3 className="text-base font-medium">Last observed harness</h3>
        <p className="text-muted-foreground mb-2 text-sm">
          What the CLI reported loading on this agent's most recent turn.
        </p>
        {!last ? (
          <p className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
            No turn has run yet.
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border px-4 py-3 text-sm">
            <Row k="captured" v={new Date(last.capturedAt).toLocaleString()} />
            <Row k="claude" v={last.claudeVersion ?? '?'} />
            <Row k="model" v={last.model ?? '?'} />
            <Row k="permission mode" v={last.permissionMode ?? '?'} />
            <Row k="tools" v={`${last.tools.length}`} />
            <Row k="skills" v={list(last.skills)} />
            <Row k="plugins" v={list(last.plugins.map((p) => p.name))} />
            <Row k="mcp servers" v={list(last.mcpServers.map((s) => `${s.name} (${s.status})`))} />
            <Row k="subagents" v={list(last.agents)} />
          </dl>
        )}
      </div>
    </section>
  );
}

function describe(p: ProfileDraft): string {
  const parts = [
    p.effort ? `effort ${p.effort}` : null,
    p.permissionMode ? `mode ${p.permissionMode}` : null,
    p.maxTurns ? `≤${p.maxTurns} turns` : null,
    p.fallbackModel ? `fallback ${p.fallbackModel}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'CLI defaults';
}

function list(xs: string[]): string {
  return xs.length === 0
    ? 'none'
    : xs.length > 12
      ? `${xs.length}: ${xs.slice(0, 12).join(', ')}…`
      : xs.join(', ');
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 break-words">{v}</dd>
    </>
  );
}
