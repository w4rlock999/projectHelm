import { Button } from '#/components/ui/button';
import { trpc } from '#/lib/trpc';

// A paused daemon silently refuses every turn — heartbeats stop firing and
// Telegram messages go unanswered. That has to be impossible to miss, or the
// next person to look wastes an afternoon debugging a fleet that is working
// exactly as instructed.
export function PausedBanner() {
  const utils = trpc.useUtils();
  const { data } = trpc.system.status.useQuery(undefined, {
    refetchInterval: 15_000,
    // The switch may be flipped by an agent or the CLI, not just this tab.
    refetchOnWindowFocus: true,
  });
  const resume = trpc.system.resume.useMutation({
    onSuccess: () => utils.system.status.invalidate(),
  });

  if (!data?.paused) return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-red-600 px-4 py-2 text-sm text-white"
    >
      <span className="font-medium">Runs are paused</span>
      {data.reason ? <span className="opacity-90">· {data.reason}</span> : null}
      {data.since ? (
        <span className="opacity-75">· since {new Date(data.since).toLocaleString()}</span>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        className="ml-1 h-6 border-white/40 bg-transparent px-2 text-xs text-white hover:bg-white/15 hover:text-white"
        disabled={resume.isPending}
        onClick={() => resume.mutate()}
      >
        {resume.isPending ? 'Resuming…' : 'Resume'}
      </Button>
    </div>
  );
}
