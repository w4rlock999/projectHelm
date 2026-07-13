import { useState } from 'react';
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
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { cn } from '#/lib/utils';
import { trpc, type Agent } from '#/lib/trpc';

// Warm matte-glass field styling so the dialog matches the home theme.
// `!` forces the background over the app's unlayered global CSS, which would
// otherwise win against Tailwind's layered utilities and render fields white.
const warmField =
  'border-white/15! bg-black/20! text-[#fbf0e8]! placeholder:text-[rgba(251,240,232,0.4)] ' +
  'focus-visible:border-white/30! focus-visible:ring-white/15';

interface Props {
  onCreated: (agent: Agent) => void;
  /** Custom trigger element; falls back to the default button. */
  trigger?: React.ReactNode;
}

export function CreateAgentDialog({ onCreated, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');

  const utils = trpc.useUtils();
  const createMutation = trpc.agents.create.useMutation({
    onSuccess: (agent) => {
      utils.agents.list.invalidate();
      onCreated(agent);
      setOpen(false);
      setName('');
      setSystemPrompt('');
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !systemPrompt.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      systemPrompt: systemPrompt.trim(),
    });
  }

  const busy = createMutation.isPending;
  const error = createMutation.error?.message ?? null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger ?? <Button>New Agent</Button>}</DialogTrigger>
      <DialogContent
        className={cn(
          'rounded-3xl border-white/15 bg-[#241510]/90 text-[#fbf0e8] backdrop-blur-2xl sm:max-w-lg',
          'shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_30px_80px_rgba(10,6,4,0.6)]',
          '[&_[data-slot=dialog-close]]:text-[rgba(251,240,232,0.6)] [&_[data-slot=dialog-close]]:hover:opacity-100',
        )}
      >
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="text-[#fbf0e8]">Create a new agent</DialogTitle>
            <DialogDescription className="text-[rgba(251,240,232,0.62)]">
              Wraps a Claude Code instance steered by the role you describe below. The role is
              written to{' '}
              <code className="rounded border border-white/15! bg-black/25! px-1.5 py-0.5 text-xs text-[#fbf0e8]!">
                CLAUDE.md
              </code>{' '}
              in the agent's workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name" className="text-[rgba(251,240,232,0.72)]">
                Name
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Pirate Translator"
                required
                autoFocus
                className={warmField}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="systemPrompt" className="text-[rgba(251,240,232,0.72)]">
                Role / system prompt
              </Label>
              <Textarea
                id="systemPrompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="You translate every reply into pirate-speak. Stay in character."
                rows={6}
                required
                className={warmField}
              />
            </div>
            {error ? <p className="text-sm text-red-300">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="text-[rgba(251,240,232,0.62)] hover:bg-white/10 hover:text-[#fbf0e8]"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy}
              className="bg-[#fbf0e8] text-[#2c1a14] hover:bg-white disabled:opacity-60"
            >
              {busy ? 'Creating…' : 'Create agent'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
