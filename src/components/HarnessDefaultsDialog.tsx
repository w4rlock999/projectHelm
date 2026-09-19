import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import { cn } from '#/lib/utils';
import { monoMeta } from '#/lib/glass';
import { trpc } from '#/lib/trpc';
import { EMPTY_DRAFT, HarnessProfileForm, type ProfileDraft } from './agent/HarnessProfileForm';

// Fleet-wide harness defaults. Saving re-renders every agent that inherits a
// field, so this is deliberately a dialog with an explicit Save rather than
// live-updating controls.

export function HarnessDefaultsDialog({ trigger }: { trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const { data } = trpc.system.harnessDefaults.useQuery(undefined, { enabled: open });
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const save = trpc.system.setHarnessDefaults.useMutation({
    onSuccess: () => {
      utils.system.harnessDefaults.invalidate();
      utils.agents.harness.invalidate();
      setOpen(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className={cn(
              monoMeta,
              'text-[0.65rem] text-[var(--warm-ink-soft)] transition-colors hover:text-[var(--warm-ink)]',
            )}
          >
            Harness
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Fleet harness defaults</DialogTitle>
          <DialogDescription>
            Every agent's Claude Code inherits these where its own profile is unset. Saving
            re-renders the whole fleet; the change takes effect on each agent's next turn.
          </DialogDescription>
        </DialogHeader>

        <HarnessProfileForm
          value={draft}
          onChange={setDraft}
          inheritLabel="CLI default"
          disabled={save.isPending || !data}
        />

        {save.error ? <p className="text-destructive text-sm">{save.error.message}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !data}>
            {save.isPending ? 'Saving…' : 'Save defaults'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
