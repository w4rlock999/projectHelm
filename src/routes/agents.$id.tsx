import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '#/components/ui/button';
import { ChatView } from '#/components/chat/ChatView';
import { ToolsPanel } from '#/components/agent/ToolsPanel';
import { GatewaysPanel } from '#/components/agent/GatewaysPanel';
import { HeartbeatsPanel } from '#/components/agent/HeartbeatsPanel';
import { trpc } from '#/lib/trpc';

export const Route = createFileRoute('/agents/$id')({ component: AgentPage });

const TABS = ['Chat', 'Tools', 'Gateways', 'Heartbeats'] as const;
type Tab = (typeof TABS)[number];

function AgentPage() {
  const { id } = Route.useParams();
  const [promptOpen, setPromptOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('Chat');

  const utils = trpc.useUtils();
  const { data: agent, error } = trpc.agents.get.useQuery({ id });
  const resetMutation = trpc.agents.resetSession.useMutation({
    onSuccess: () => {
      utils.agents.get.invalidate({ id });
      utils.agents.list.invalidate();
    },
  });

  function onReset() {
    if (!agent) return;
    if (!confirm(`Reset conversation? "${agent.name}" will forget the chat history.`)) return;
    resetMutation.mutate({ id: agent.id });
  }

  if (error) {
    return (
      <div className="mx-auto max-w-4xl p-8">
        <Button variant="ghost" asChild className="mb-4">
          <Link to="/">← Back</Link>
        </Button>
        <p className="text-destructive text-sm">{error.message}</p>
      </div>
    );
  }
  if (!agent) {
    return <p className="text-muted-foreground p-8 text-sm">Loading…</p>;
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Button variant="ghost" asChild className="mb-4">
        <Link to="/">← Back</Link>
      </Button>

      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold">{agent.name}</h1>
          <p className="text-muted-foreground mt-1 text-xs">
            model: {agent.model ?? 'sonnet'}
            {agent.claudeSessionId
              ? ` · session ${agent.claudeSessionId.slice(0, 8)}…`
              : ' · no session yet'}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPromptOpen((v) => !v)}
            aria-expanded={promptOpen}
          >
            {promptOpen ? 'Hide prompt' : 'Show prompt'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onReset}
            disabled={!agent.claudeSessionId || resetMutation.isPending}
          >
            Reset session
          </Button>
        </div>
      </header>

      {promptOpen ? (
        <section className="bg-muted/30 mb-4 rounded-md border px-4 py-3">
          <p className="text-muted-foreground mb-1 text-xs font-medium">
            System prompt (CLAUDE.md)
          </p>
          <pre className="text-xs leading-relaxed whitespace-pre-wrap">{agent.systemPrompt}</pre>
        </section>
      ) : null}

      <nav className="mb-4 flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ' +
              (tab === t
                ? 'border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent')
            }
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === 'Chat' && (
        <ChatView agent={agent} onSessionAppeared={() => utils.agents.get.invalidate({ id })} />
      )}
      {tab === 'Tools' && <ToolsPanel agentId={agent.id} />}
      {tab === 'Gateways' && <GatewaysPanel agentId={agent.id} />}
      {tab === 'Heartbeats' && <HeartbeatsPanel agentId={agent.id} />}
    </div>
  );
}
