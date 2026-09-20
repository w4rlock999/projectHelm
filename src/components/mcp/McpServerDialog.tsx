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
import { trpc, type McpServerView } from '#/lib/trpc';

// Create/edit form for a library MCP server — used by /mcp and the agent's
// Harness tab. Secrets: an existing server's env/header values arrive as
// `<set>` and are sent back as `<set>`, which the server resolves to the stored
// value; typing over one replaces it.

const RUNTIMES = ['npx', 'uvx', 'node', 'python3'] as const;
type Runtime = (typeof RUNTIMES)[number];
type Transport = 'stdio' | 'http';

interface Props {
  server: McpServerView | null;
  /** When creating, also assign the new server to this agent. */
  assignToAgentId?: string;
  onClose: () => void;
  onSaved?: () => void;
}

/** `KEY=VALUE` lines ↔ record. */
function toLines(rec: Record<string, string>): string {
  return Object.entries(rec)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}
function fromLines(text: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return `"${line}" is not KEY=VALUE`;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

export function McpServerDialog({ server, assignToAgentId, onClose, onSaved }: Props) {
  const c = server?.config;
  const [name, setName] = useState(server?.name ?? '');
  const [description, setDescription] = useState(server?.description ?? '');
  const [transport, setTransport] = useState<Transport>(c?.transport ?? 'stdio');
  const [command, setCommand] = useState<Runtime>(
    c?.transport === 'stdio' ? (c.command as Runtime) : 'npx',
  );
  const [args, setArgs] = useState(c?.transport === 'stdio' ? c.args.join('\n') : '');
  const [env, setEnv] = useState(c?.transport === 'stdio' ? toLines(c.env) : '');
  const [url, setUrl] = useState(c?.transport === 'http' ? c.url : '');
  const [headers, setHeaders] = useState(c?.transport === 'http' ? toLines(c.headers) : '');
  const [localError, setLocalError] = useState<string | null>(null);

  const done = () => {
    onSaved?.();
    onClose();
  };
  const createMutation = trpc.mcp.create.useMutation({ onSuccess: done });
  const updateMutation = trpc.mcp.update.useMutation({ onSuccess: done });
  const busy = createMutation.isPending || updateMutation.isPending;
  const error =
    localError ?? createMutation.error?.message ?? updateMutation.error?.message ?? null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    let config;
    if (transport === 'stdio') {
      const envRec = fromLines(env);
      if (typeof envRec === 'string') return setLocalError(`env: ${envRec}`);
      config = {
        transport: 'stdio' as const,
        command,
        args: args
          .split('\n')
          .map((a) => a.trim())
          .filter(Boolean),
        env: envRec,
      };
    } else {
      const hdr = fromLines(headers);
      if (typeof hdr === 'string') return setLocalError(`headers: ${hdr}`);
      config = { transport: 'http' as const, url: url.trim(), headers: hdr };
    }
    if (server) {
      updateMutation.mutate({ id: server.id, name, description, config });
    } else {
      createMutation.mutate({
        name,
        description,
        config,
        assignTo: assignToAgentId ? [assignToAgentId] : undefined,
      });
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{server ? 'Edit MCP server' : 'New MCP server'}</DialogTitle>
            <DialogDescription>
              {server ? (
                <>Edits the library entry — every agent it's assigned to reconnects next turn.</>
              ) : assignToAgentId ? (
                <>Adds a server to the library and assigns it to this agent.</>
              ) : (
                <>Adds a server to the shared library. Assign it to agents afterward.</>
              )}{' '}
              Its tools reach the agent as <code className="text-xs">mcp__&lt;name&gt;__*</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <div className="grid gap-2">
                <Label htmlFor="mcp-name">Name</Label>
                <Input
                  id="mcp-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. fetch"
                  pattern="[a-z0-9][a-z0-9_-]{0,63}"
                  title="lowercase letters, digits, - or _"
                  required
                  autoFocus
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mcp-transport">Transport</Label>
                <select
                  id="mcp-transport"
                  value={transport}
                  onChange={(e) => setTransport(e.target.value as Transport)}
                  className="border-input h-9 rounded-md border bg-transparent px-3 text-sm shadow-sm"
                >
                  <option value="stdio">stdio (local process)</option>
                  <option value="http">http (remote URL)</option>
                </select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mcp-desc">Description (told to the agent)</Label>
              <Input
                id="mcp-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What it provides and when to use it"
                required
              />
            </div>

            {transport === 'stdio' ? (
              <>
                <div className="grid grid-cols-[auto_1fr] gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="mcp-cmd">Runtime</Label>
                    <select
                      id="mcp-cmd"
                      value={command}
                      onChange={(e) => setCommand(e.target.value as Runtime)}
                      className="border-input h-9 rounded-md border bg-transparent px-3 text-sm shadow-sm"
                    >
                      {RUNTIMES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="mcp-args">Arguments (one per line)</Label>
                    <Textarea
                      id="mcp-args"
                      value={args}
                      onChange={(e) => setArgs(e.target.value)}
                      placeholder={'-y\n@modelcontextprotocol/server-fetch'}
                      rows={3}
                      className="font-mono text-xs"
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="mcp-env">Environment (KEY=VALUE per line)</Label>
                  <Textarea
                    id="mcp-env"
                    value={env}
                    onChange={(e) => setEnv(e.target.value)}
                    placeholder="API_KEY=…"
                    rows={3}
                    className="font-mono text-xs"
                  />
                  <p className="text-muted-foreground text-xs">
                    Values are secrets: stored ones show as <code>&lt;set&gt;</code> and stay
                    unchanged unless you type over them.
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="mcp-url">URL</Label>
                  <Input
                    id="mcp-url"
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="mcp-headers">Headers (Name=value per line)</Label>
                  <Textarea
                    id="mcp-headers"
                    value={headers}
                    onChange={(e) => setHeaders(e.target.value)}
                    placeholder="Authorization=Bearer …"
                    rows={3}
                    className="font-mono text-xs"
                  />
                  <p className="text-muted-foreground text-xs">
                    Values are secrets: stored ones show as <code>&lt;set&gt;</code> and stay
                    unchanged unless you type over them.
                  </p>
                </div>
              </>
            )}
            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : server ? 'Save changes' : 'Add server'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One-line summary of a redacted config, for lists. */
export function describeMcpConfig(s: McpServerView): string {
  const c = s.config;
  if (c.transport === 'stdio') {
    const env = Object.keys(c.env);
    return `${c.command} ${c.args.join(' ')}${env.length ? ` · env ${env.join(', ')}` : ''}`;
  }
  const hdr = Object.keys(c.headers);
  return `${c.url}${hdr.length ? ` · headers ${hdr.join(', ')}` : ''}`;
}
