import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import { ChatView } from '#/components/chat/ChatView';
import { cn } from '#/lib/utils';
import { monoMeta } from '#/lib/glass';
import { trpc } from '#/lib/trpc';

/**
 * helmCaptain chat, rendered inline as the main card's content (replacing
 * the fleet) when the home route carries `?chat=captain`. It opens with a
 * short boot animation before swapping in the live chat.
 */
export function CaptainPanel() {
  const utils = trpc.useUtils();
  const { data: captain, error } = trpc.captain.get.useQuery();
  const resetMutation = trpc.captain.resetSession.useMutation({
    onSuccess: () => utils.captain.get.invalidate(),
  });

  // Hold the boot animation for a beat so it always reads, even when the
  // captain query resolves instantly from cache.
  const [booting, setBooting] = useState(true);
  useEffect(() => {
    const id = setTimeout(() => setBooting(false), 1100);
    return () => clearTimeout(id);
  }, []);

  const ready = !booting && Boolean(captain);

  function onReset() {
    if (!captain?.claudeSessionId || resetMutation.isPending) return;
    if (!confirm('Reset helmCaptain conversation? It will forget the chat history.')) return;
    resetMutation.mutate();
  }

  return (
    <div className="captain-enter flex flex-1 flex-col">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span aria-hidden className="text-3xl leading-none">
            ⎈
          </span>
          <div className="leading-tight">
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--warm-ink)] sm:text-3xl">
              helmCaptain
            </h1>
            <p className={cn(monoMeta, 'mt-1 text-[0.6rem] text-[var(--warm-ink-faint)]')}>
              operator · {captain?.model ?? 'sonnet'}
              {captain?.claudeSessionId
                ? ` · session ${captain.claudeSessionId.slice(0, 8)}…`
                : ' · no session yet'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onReset}
            disabled={!captain?.claudeSessionId || resetMutation.isPending}
            title="Reset session"
            className={cn(
              monoMeta,
              'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[0.6rem] text-[var(--warm-ink-soft)] transition-colors hover:bg-white/10 hover:text-[var(--warm-ink)] disabled:opacity-30',
            )}
          >
            <RotateCcw className="size-3.5" />
            reset
          </button>
          <Link
            to="/"
            search={{}}
            className={cn(
              monoMeta,
              'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[0.6rem] text-[var(--warm-ink-soft)] no-underline transition-colors hover:bg-white/10 hover:text-[var(--warm-ink)]',
            )}
          >
            <ArrowLeft className="size-3.5" />
            back to fleet
          </Link>
        </div>
      </div>

      <p className="mt-3 max-w-prose text-sm text-[var(--warm-ink-soft)]">
        Your control-plane operator — ask it to help design agents, draft tools, and plan
        orchestration.
      </p>

      <div className="mt-6 flex min-h-0 flex-1 flex-col">
        {error ? (
          <p className="text-sm text-red-200">{error.message}</p>
        ) : ready && captain ? (
          <ChatView
            agent={captain}
            variant="glass"
            heightClassName="min-h-0 flex-1"
            onSessionAppeared={() => utils.captain.get.invalidate()}
          />
        ) : (
          <CaptainBoot />
        )}
      </div>
    </div>
  );
}

/** The "cool loading thing": a turning helm with a sonar ring and a shimmer bar. */
function CaptainBoot() {
  return (
    <div
      className="flex min-h-[18rem] flex-1 flex-col items-center justify-center gap-7"
      role="status"
      aria-label="Waking helmCaptain"
    >
      <div className="relative flex size-20 items-center justify-center">
        <span className="captain-ring absolute size-20 rounded-full border border-[rgba(232,142,94,0.55)]" />
        <span className="captain-ring absolute size-20 rounded-full border border-[rgba(232,142,94,0.35)] [animation-delay:0.6s]" />
        <span aria-hidden className="captain-helm text-5xl leading-none">
          ⎈
        </span>
      </div>
      <div className="flex flex-col items-center gap-3">
        <p className={cn(monoMeta, 'text-[0.65rem] text-[var(--warm-ink-soft)]')}>
          Waking helmCaptain…
        </p>
        <div className="h-1 w-52 overflow-hidden rounded-full bg-white/10">
          <div className="captain-shimmer h-full w-full rounded-full" />
        </div>
      </div>
    </div>
  );
}
