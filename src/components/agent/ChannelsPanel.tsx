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
import { trpc } from '#/lib/trpc'

export function ChannelsPanel({ agentId }: { agentId: string }) {
  const utils = trpc.useUtils()
  const { data: channels } = trpc.channels.list.useQuery({ agentId })
  const [wizardOpen, setWizardOpen] = useState(false)

  const updateMutation = trpc.channels.update.useMutation({
    onSuccess: () => utils.channels.list.invalidate({ agentId }),
  })
  const deleteMutation = trpc.channels.delete.useMutation({
    onSuccess: () => utils.channels.list.invalidate({ agentId }),
  })

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Interfaces</h2>
          <p className="text-sm text-muted-foreground">
            Connect a Telegram bot. This becomes the agent's voice — it gets a{' '}
            <code className="text-xs">send-telegram</code> tool and receives inbound messages as
            runs.
          </p>
        </div>
        <Button onClick={() => setWizardOpen(true)}>Add Telegram bot</Button>
      </div>

      {!channels || channels.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No interface connected yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {channels.map((c) => (
            <li key={c.id} className="rounded-md border px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">Telegram</p>
                  <p className="text-sm text-muted-foreground">
                    {c.chatId ? (
                      <>chat linked (id {c.chatId})</>
                    ) : (
                      <>not linked yet — message your bot to establish a chat</>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {c.enabled ? 'polling for messages' : 'disabled'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={updateMutation.isPending}
                    onClick={() => updateMutation.mutate({ id: c.id, enabled: !c.enabled })}
                  >
                    {c.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (confirm('Remove this Telegram interface?')) deleteMutation.mutate({ id: c.id })
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {wizardOpen && <TelegramWizard agentId={agentId} onClose={() => setWizardOpen(false)} />}
    </section>
  )
}

function TelegramWizard({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const utils = trpc.useUtils()
  const [token, setToken] = useState('')
  const [verified, setVerified] = useState<{ username?: string; name: string } | null>(null)

  const verifyMutation = trpc.channels.verifyToken.useMutation({
    onSuccess: (res) => {
      if (res.ok) setVerified({ username: res.username, name: res.name })
      else setVerified(null)
    },
  })
  const createMutation = trpc.channels.create.useMutation({
    onSuccess: () => {
      utils.channels.list.invalidate({ agentId })
      onClose()
    },
  })

  const verifyResult = verifyMutation.data
  const busy = createMutation.isPending

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect a Telegram bot</DialogTitle>
          <DialogDescription>
            Create a bot with{' '}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              @BotFather
            </a>{' '}
            (send <code className="text-xs">/newbot</code>), then paste the token it gives you.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="tg-token">Bot token</Label>
            <div className="flex gap-2">
              <Input
                id="tg-token"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value)
                  setVerified(null)
                }}
                placeholder="123456:ABC-DEF…"
                autoFocus
              />
              <Button
                type="button"
                variant="outline"
                disabled={!token.trim() || verifyMutation.isPending}
                onClick={() => verifyMutation.mutate({ token: token.trim() })}
              >
                {verifyMutation.isPending ? 'Verifying…' : 'Verify'}
              </Button>
            </div>
            {verifyResult?.ok && verified && (
              <p className="text-sm text-emerald-600">
                ✓ {verified.name}
                {verified.username ? ` (@${verified.username})` : ''}
              </p>
            )}
            {verifyResult && !verifyResult.ok && (
              <p className="text-sm text-destructive">{verifyResult.error}</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            After connecting, open your bot in Telegram and send it any message — that links the
            chat so the agent can reply and push heartbeat updates.
          </p>
          {createMutation.error && (
            <p className="text-sm text-destructive">{createMutation.error.message}</p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!token.trim() || busy}
            onClick={() => createMutation.mutate({ agentId, token: token.trim() })}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
