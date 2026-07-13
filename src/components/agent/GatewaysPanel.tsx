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
import { trpc } from '#/lib/trpc';

export function GatewaysPanel({ agentId }: { agentId: string }) {
  const utils = trpc.useUtils();
  const { data: gateways } = trpc.gateways.list.useQuery({ agentId });
  const { data: chats } = trpc.gateways.chats.useQuery({ agentId });
  const { data: agent } = trpc.agents.get.useQuery({ id: agentId });
  const [wizardOpen, setWizardOpen] = useState(false);

  const scopeMutation = trpc.agents.update.useMutation({
    onSuccess: () => utils.agents.get.invalidate({ id: agentId }),
  });
  const scope = agent?.sessionScope ?? 'chat';
  const recall = agent?.sessionRecall ?? 'none';

  const updateMutation = trpc.gateways.update.useMutation({
    onSuccess: () => utils.gateways.list.invalidate({ agentId }),
  });
  const deleteMutation = trpc.gateways.delete.useMutation({
    onSuccess: () => {
      utils.gateways.list.invalidate({ agentId });
      utils.gateways.chats.invalidate({ agentId });
    },
  });
  const updateChatMutation = trpc.gateways.updateChat.useMutation({
    onSuccess: () => utils.gateways.chats.invalidate({ agentId }),
  });

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Gateways</h2>
          <p className="text-muted-foreground text-sm">
            Connect a Telegram bot. This becomes the agent's voice — it gets a{' '}
            <code className="text-xs">send-telegram</code> tool and receives inbound messages as
            runs.
          </p>
        </div>
        <Button onClick={() => setWizardOpen(true)}>Add Telegram bot</Button>
      </div>

      {/* Session scope: isolated per chat vs. one shared memory. */}
      <div className="rounded-md border px-4 py-3">
        <p className="text-sm font-medium">Memory</p>
        <p className="text-muted-foreground text-sm">
          {scope === 'chat'
            ? 'Each chat (and the browser) has its own separate conversation.'
            : 'All chats and the browser share one conversation — the agent remembers across everyone.'}
        </p>
        <div className="mt-2 flex gap-2">
          <Button
            variant={scope === 'chat' ? 'default' : 'outline'}
            size="sm"
            disabled={scopeMutation.isPending || scope === 'chat'}
            onClick={() => scopeMutation.mutate({ id: agentId, sessionScope: 'chat' })}
          >
            Isolated per chat
          </Button>
          <Button
            variant={scope === 'agent' ? 'default' : 'outline'}
            size="sm"
            disabled={scopeMutation.isPending || scope === 'agent'}
            onClick={() => scopeMutation.mutate({ id: agentId, sessionScope: 'agent' })}
          >
            Shared
          </Button>
        </div>
      </div>

      {/* Cross-session recall: can the agent read across all its sessions? */}
      <div className="rounded-md border px-4 py-3">
        <p className="text-sm font-medium">Cross-session recall</p>
        <p className="text-muted-foreground text-sm">
          {recall === 'all'
            ? 'The agent can search across every session — it remembers people and topics from other conversations.'
            : "The agent only sees the current conversation. It can't recall other sessions."}
          {scope === 'agent'
            ? ' (No effect while memory is Shared — there is only one session.)'
            : ''}
        </p>
        <div className="mt-2 flex gap-2">
          <Button
            variant={recall === 'none' ? 'default' : 'outline'}
            size="sm"
            disabled={scopeMutation.isPending || recall === 'none'}
            onClick={() => scopeMutation.mutate({ id: agentId, sessionRecall: 'none' })}
          >
            Isolated
          </Button>
          <Button
            variant={recall === 'all' ? 'default' : 'outline'}
            size="sm"
            disabled={scopeMutation.isPending || recall === 'all'}
            onClick={() => scopeMutation.mutate({ id: agentId, sessionRecall: 'all' })}
          >
            Search all sessions
          </Button>
        </div>
      </div>

      {!gateways || gateways.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
          No gateway yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {gateways.map((g) => {
            const gwChats = (chats ?? []).filter((ch) => ch.gatewayId === g.id);
            return (
              <li key={g.id} className="rounded-md border px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">Telegram</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {g.enabled ? 'polling for messages' : 'disabled'}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={updateMutation.isPending}
                      onClick={() => updateMutation.mutate({ id: g.id, enabled: !g.enabled })}
                    >
                      {g.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={deleteMutation.isPending}
                      onClick={() => {
                        if (confirm('Remove this Telegram gateway?'))
                          deleteMutation.mutate({ id: g.id });
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </div>

                {/* Chats (conversations) under this gateway. */}
                {gwChats.length === 0 ? (
                  <p className="text-muted-foreground mt-3 text-sm">
                    No chats yet — message your bot to start a conversation.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-1.5 border-t pt-3">
                    {gwChats.map((ch) => (
                      <li key={ch.id} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate">
                          {ch.title ?? 'chat'}{' '}
                          <span className="text-muted-foreground text-xs">(id {ch.chatId})</span>
                          {ch.status === 'blocked' && (
                            <span className="text-destructive ml-2 text-xs">blocked</span>
                          )}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={updateChatMutation.isPending}
                          onClick={() =>
                            updateChatMutation.mutate({
                              id: ch.id,
                              status: ch.status === 'blocked' ? 'active' : 'blocked',
                            })
                          }
                        >
                          {ch.status === 'blocked' ? 'Unblock' : 'Block'}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {wizardOpen && <TelegramWizard agentId={agentId} onClose={() => setWizardOpen(false)} />}
    </section>
  );
}

function TelegramWizard({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [token, setToken] = useState('');
  const [verified, setVerified] = useState<{ username?: string; name: string } | null>(null);

  const verifyMutation = trpc.gateways.verifyToken.useMutation({
    onSuccess: (res) => {
      if (res.ok) setVerified({ username: res.username, name: res.name });
      else setVerified(null);
    },
  });
  const createMutation = trpc.gateways.create.useMutation({
    onSuccess: () => {
      utils.gateways.list.invalidate({ agentId });
      onClose();
    },
  });

  const verifyResult = verifyMutation.data;
  const busy = createMutation.isPending;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect a Telegram bot</DialogTitle>
          <DialogDescription>
            Create a bot with{' '}
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="underline">
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
                  setToken(e.target.value);
                  setVerified(null);
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
              <p className="text-destructive text-sm">{verifyResult.error}</p>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            After connecting, open your bot in Telegram and send it any message — that links the
            chat so the agent can reply and push heartbeat updates.
          </p>
          {createMutation.error && (
            <p className="text-destructive text-sm">{createMutation.error.message}</p>
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
  );
}
