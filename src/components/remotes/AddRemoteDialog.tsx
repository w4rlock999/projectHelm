import { useState } from 'react';
import { Button } from '#/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog';
import { Input } from '#/components/ui/input';
import { Label } from '#/components/ui/label';
import { trpc } from '#/lib/trpc';

/**
 * Add-remote dialog. The `add` mutation performs the first handshake through
 * the SSH tunnel before saving, so a bad code/target/token never creates a
 * row — errors surface right here.
 */
export function AddRemoteDialog({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const [manual, setManual] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [sshTarget, setSshTarget] = useState('');
  const [helmPort, setHelmPort] = useState('5555');
  const [token, setToken] = useState('');

  const addMutation = trpc.remotes.add.useMutation({
    onSuccess: () => {
      utils.remotes.list.invalidate();
      onClose();
    },
  });

  const canSubmit = manual ? sshTarget.trim() && token.trim() : code.trim();
  const busy = addMutation.isPending;

  const submit = () => {
    addMutation.mutate(
      manual
        ? {
            name: name.trim() || undefined,
            sshTarget: sshTarget.trim(),
            helmPort: Number(helmPort) || 5555,
            token: token.trim(),
          }
        : { name: name.trim() || undefined, connectCode: code.trim() },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a remote</DialogTitle>
          <DialogDescription>
            On the VPS, run <code className="text-xs">pnpm remote:init</code> and paste the{' '}
            <code className="text-xs">helm-connect:</code> code it prints. Connecting verifies the
            remote over SSH before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {!manual ? (
            <div className="grid gap-2">
              <Label htmlFor="remote-code">Connect code</Label>
              <Input
                id="remote-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="helm-connect:eyJ2IjoxLC…"
                autoFocus
              />
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="remote-ssh">SSH target</Label>
                <Input
                  id="remote-ssh"
                  value={sshTarget}
                  onChange={(e) => setSshTarget(e.target.value)}
                  placeholder="user@host[:port]"
                  autoFocus
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="remote-port">Helm port (on the remote)</Label>
                <Input
                  id="remote-port"
                  value={helmPort}
                  onChange={(e) => setHelmPort(e.target.value)}
                  placeholder="5555"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="remote-token">Pairing token</Label>
                <Input
                  id="remote-token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="helm_rt_…"
                />
              </div>
            </>
          )}

          <div className="grid gap-2">
            <Label htmlFor="remote-name">Name (optional)</Label>
            <Input
              id="remote-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="defaults to the host"
            />
          </div>

          <button
            type="button"
            className="text-muted-foreground w-fit text-xs underline"
            onClick={() => setManual((m) => !m)}
          >
            {manual ? 'Paste a connect code instead' : 'Enter fields manually instead'}
          </button>

          {addMutation.error && (
            <p className="text-destructive text-sm">{addMutation.error.message}</p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit || busy} onClick={submit}>
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
