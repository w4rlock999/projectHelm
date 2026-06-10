import { useState } from 'react'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'
import { trpc, type Agent } from '#/lib/trpc'

interface Props {
  onCreated: (agent: Agent) => void
}

export function CreateAgentDialog({ onCreated }: Props) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')

  const utils = trpc.useUtils()
  const createMutation = trpc.agents.create.useMutation({
    onSuccess: (agent) => {
      utils.agents.list.invalidate()
      onCreated(agent)
      setOpen(false)
      setName('')
      setSystemPrompt('')
    },
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !systemPrompt.trim()) return
    createMutation.mutate({
      name: name.trim(),
      systemPrompt: systemPrompt.trim(),
    })
  }

  const busy = createMutation.isPending
  const error = createMutation.error?.message ?? null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New Agent</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Create a new agent</DialogTitle>
            <DialogDescription>
              Wraps a Claude Code instance steered by the role you describe below. The role is
              written to <code className="text-xs">CLAUDE.md</code> in the agent's workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Pirate Translator"
                required
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="systemPrompt">Role / system prompt</Label>
              <Textarea
                id="systemPrompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="You translate every reply into pirate-speak. Stay in character."
                rows={6}
                required
              />
            </div>
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create agent'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
