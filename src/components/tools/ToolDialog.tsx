import { useState } from 'react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { trpc, type Tool } from '#/lib/trpc';

const INTERPRETERS = ['bash', 'sh', 'node', 'python3'] as const;
type Interpreter = (typeof INTERPRETERS)[number];

const PLACEHOLDER: Record<Interpreter, string> = {
  bash: 'echo "hello from $1"',
  sh: 'echo "hello from $1"',
  node: 'console.log("hello from", process.argv[2])',
  python3: 'import sys\nprint("hello from", sys.argv[1] if len(sys.argv) > 1 else "")',
};

interface Props {
  /** Edit an existing library tool, or null to create a new one. */
  tool: Tool | null;
  /** When creating, also assign the new tool to this agent (author-and-assign). */
  assignToAgentId?: string;
  onClose: () => void;
  onSaved?: () => void;
}

/** Shared create/edit form for a library tool — used by /tools and the agent panel. */
export function ToolDialog({ tool, assignToAgentId, onClose, onSaved }: Props) {
  const [name, setName] = useState(tool?.name ?? '');
  const [description, setDescription] = useState(tool?.description ?? '');
  const [interpreter, setInterpreter] = useState<Interpreter>(
    (tool?.interpreter as Interpreter) ?? 'bash',
  );
  const [source, setSource] = useState(tool?.source ?? '');

  const done = () => {
    onSaved?.();
    onClose();
  };
  const createMutation = trpc.tools.create.useMutation({ onSuccess: done });
  const updateMutation = trpc.tools.update.useMutation({ onSuccess: done });
  const busy = createMutation.isPending || updateMutation.isPending;
  const error = createMutation.error?.message ?? updateMutation.error?.message ?? null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !description.trim() || !source.trim()) return;
    if (tool) {
      updateMutation.mutate({ id: tool.id, name, description, interpreter, source });
    } else {
      createMutation.mutate({
        name,
        description,
        interpreter,
        source,
        assignTo: assignToAgentId ? [assignToAgentId] : undefined,
      });
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{tool ? 'Edit tool' : 'New tool'}</DialogTitle>
            <DialogDescription>
              {tool ? (
                <>Edits the library tool — changes apply to every agent it's assigned to.</>
              ) : assignToAgentId ? (
                <>Creates a library tool and assigns it to this agent.</>
              ) : (
                <>Creates a tool in the shared library. Assign it to agents afterward.</>
              )}{' '}
              Agents invoke it as <code className="text-xs">tools/&lt;name&gt;</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <div className="grid gap-2">
                <Label htmlFor="tool-name">Name</Label>
                <Input
                  id="tool-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. fetch-weather"
                  required
                  autoFocus
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="tool-interp">Interpreter</Label>
                <select
                  id="tool-interp"
                  value={interpreter}
                  onChange={(e) => setInterpreter(e.target.value as Interpreter)}
                  className="border-input h-9 rounded-md border bg-transparent px-3 text-sm shadow-sm"
                >
                  {INTERPRETERS.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tool-desc">Description (told to the agent)</Label>
              <Input
                id="tool-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What it does and when to use it"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tool-src">Script</Label>
              <Textarea
                id="tool-src"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder={PLACEHOLDER[interpreter]}
                rows={10}
                required
                className="font-mono text-xs"
              />
              <p className="text-muted-foreground text-xs">
                A shebang is added automatically based on the interpreter (omit it unless you need a
                specific one).
              </p>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : tool ? 'Save changes' : 'Create tool'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
