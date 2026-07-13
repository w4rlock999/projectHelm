import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '#/components/ui/button';
import { ChatView } from '#/components/chat/ChatView';
import { trpc } from '#/lib/trpc';

export const Route = createFileRoute('/captain')({ component: CaptainPage });

function CaptainPage() {
  const [promptOpen, setPromptOpen] = useState(false);
  const utils = trpc.useUtils();
  const { data: captain, error } = trpc.captain.get.useQuery();
  const resetMutation = trpc.captain.resetSession.useMutation({
    onSuccess: () => utils.captain.get.invalidate(),
  });

  function onReset() {
    if (!confirm('Reset helmCaptain conversation? It will forget the chat history.')) return;
    resetMutation.mutate();
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
  if (!captain) {
    return <p className="text-muted-foreground p-8 text-sm">Loading…</p>;
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Button variant="ghost" asChild className="mb-4">
        <Link to="/">← Back to fleet</Link>
      </Button>

      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <span aria-hidden>⎈</span> helmCaptain
          </h1>
          <p className="text-muted-foreground mt-1 text-xs">
            operator agent · model: {captain.model ?? 'sonnet'}
            {captain.claudeSessionId
              ? ` · session ${captain.claudeSessionId.slice(0, 8)}…`
              : ' · no session yet'}
          </p>
          <p className="text-muted-foreground mt-2 max-w-prose text-sm">
            Your control-plane operator. Ask it to help design agents, draft tools, and plan
            orchestration. (Direct fleet actions via helmCLI are coming — for now it advises and
            drafts.)
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPromptOpen((v) => !v)}
            aria-expanded={promptOpen}
          >
            {promptOpen ? 'Hide steering' : 'Show steering'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onReset}
            disabled={!captain.claudeSessionId || resetMutation.isPending}
          >
            Reset session
          </Button>
        </div>
      </header>

      {promptOpen ? (
        <section className="bg-muted/30 mb-4 rounded-md border px-4 py-3">
          <p className="text-muted-foreground mb-1 text-xs font-medium">Steering (CLAUDE.md)</p>
          <pre className="text-xs leading-relaxed whitespace-pre-wrap">{captain.systemPrompt}</pre>
        </section>
      ) : null}

      <ChatView agent={captain} onSessionAppeared={() => utils.captain.get.invalidate()} />
    </div>
  );
}
