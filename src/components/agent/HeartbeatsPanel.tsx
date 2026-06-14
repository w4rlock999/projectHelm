import { useState } from 'react'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'
import { trpc, type Heartbeat } from '#/lib/trpc'

const PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every minute', cron: '* * * * *' },
  { label: 'Every 30 min', cron: '*/30 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Daily 9am', cron: '0 9 * * *' },
]

export function HeartbeatsPanel({ agentId }: { agentId: string }) {
  const utils = trpc.useUtils()
  const { data: heartbeats } = trpc.heartbeats.list.useQuery({ agentId })
  const [editing, setEditing] = useState<Heartbeat | null>(null)
  const [creating, setCreating] = useState(false)

  const updateMutation = trpc.heartbeats.update.useMutation({
    onSuccess: () => utils.heartbeats.list.invalidate({ agentId }),
  })
  const deleteMutation = trpc.heartbeats.delete.useMutation({
    onSuccess: () => utils.heartbeats.list.invalidate({ agentId }),
  })

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Heartbeats</h2>
          <p className="text-sm text-muted-foreground">
            Cron-scheduled prompts fired into the agent — even when no one's chatting. The agent can
            also manage these itself via its <code className="text-xs">heartbeat</code> tool.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>New heartbeat</Button>
      </div>

      {!heartbeats || heartbeats.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No heartbeats yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {heartbeats.map((h) => (
            <li key={h.id} className="rounded-md border px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {h.name}{' '}
                    <code className="text-xs font-normal text-muted-foreground">{h.cron}</code>
                  </p>
                  <p className="text-sm text-muted-foreground line-clamp-2">{h.prompt}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {h.enabled ? 'active' : 'paused'} ·{' '}
                    {h.lastRunAt
                      ? `last ran ${new Date(h.lastRunAt).toLocaleString()}`
                      : 'never run'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={updateMutation.isPending}
                    onClick={() => updateMutation.mutate({ id: h.id, enabled: !h.enabled })}
                  >
                    {h.enabled ? 'Pause' : 'Resume'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditing(h)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (confirm(`Delete heartbeat "${h.name}"?`)) deleteMutation.mutate({ id: h.id })
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(creating || editing) && (
        <HeartbeatDialog
          agentId={agentId}
          heartbeat={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      )}
    </section>
  )
}

function HeartbeatDialog({
  agentId,
  heartbeat,
  onClose,
}: {
  agentId: string
  heartbeat: Heartbeat | null
  onClose: () => void
}) {
  const utils = trpc.useUtils()
  const [name, setName] = useState(heartbeat?.name ?? '')
  const [cron, setCron] = useState(heartbeat?.cron ?? '*/30 * * * *')
  const [prompt, setPrompt] = useState(heartbeat?.prompt ?? '')

  const onDone = () => {
    utils.heartbeats.list.invalidate({ agentId })
    onClose()
  }
  const createMutation = trpc.heartbeats.create.useMutation({ onSuccess: onDone })
  const updateMutation = trpc.heartbeats.update.useMutation({ onSuccess: onDone })
  const busy = createMutation.isPending || updateMutation.isPending
  const error = createMutation.error?.message ?? updateMutation.error?.message ?? null

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!cron.trim() || !prompt.trim()) return
    if (heartbeat) {
      updateMutation.mutate({ id: heartbeat.id, name: name || undefined, cron, prompt })
    } else {
      createMutation.mutate({ agentId, name: name || undefined, cron, prompt })
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{heartbeat ? 'Edit heartbeat' : 'New heartbeat'}</DialogTitle>
            <DialogDescription>
              On each tick, the prompt below is sent to the agent as a fresh message.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="hb-name">Name</Label>
              <Input
                id="hb-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. morning briefing"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="hb-cron">Schedule (cron)</Label>
              <Input
                id="hb-cron"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="*/30 * * * *"
                required
                className="font-mono"
              />
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.cron}
                    type="button"
                    onClick={() => setCron(p.cron)}
                    className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="hb-prompt">Prompt</Label>
              <Textarea
                id="hb-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Check the latest issues and message me a summary if anything is urgent."
                rows={5}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : heartbeat ? 'Save changes' : 'Create heartbeat'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
