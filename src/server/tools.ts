import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { agents, agentTools, connections, tools } from '../db/schema.ts'
import { paths } from './paths.ts'
import type { Tool } from '../db/schema.ts'

// `localhost` (not 127.0.0.1) so the baked tool scripts reach the daemon
// regardless of whether it binds IPv4 or IPv6 — Node's fetch tries both.
const BASE_URL = process.env.HELM_BASE_URL ?? 'http://localhost:3000'

const TOOLS_BLOCK_START = '<!-- helm:tools:start -->'
const TOOLS_BLOCK_END = '<!-- helm:tools:end -->'

const SHEBANGS: Record<string, string> = {
  bash: '#!/usr/bin/env bash',
  sh: '#!/usr/bin/env sh',
  node: '#!/usr/bin/env node',
  python: '#!/usr/bin/env python3',
  python3: '#!/usr/bin/env python3',
}

/** Filesystem-safe tool filename derived from the tool name. */
export function toolFileName(name: string): string {
  const safe = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return safe || 'tool'
}

// ── Tool library CRUD (definitions, owned by no agent) ──────────────────────

export interface CreateToolInput {
  name: string
  description: string
  interpreter?: string
  source: string
}

export function listLibraryTools(): Tool[] {
  return db.select().from(tools).all()
}

export function getLibraryTool(id: string): Tool | null {
  return db.select().from(tools).where(eq(tools.id, id)).get() ?? null
}

export function createLibraryTool(input: CreateToolInput): Tool {
  const now = new Date()
  const row: Tool = {
    id: randomUUID(),
    name: input.name,
    description: input.description,
    interpreter: input.interpreter?.trim() || 'bash',
    source: input.source,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(tools).values(row).run()
  return row
}

export function updateLibraryTool(
  id: string,
  patch: Partial<Pick<Tool, 'name' | 'description' | 'interpreter' | 'source'>>,
): Tool | null {
  const existing = db.select().from(tools).where(eq(tools.id, id)).get()
  if (!existing) return null
  db.update(tools).set({ ...patch, updatedAt: new Date() }).where(eq(tools.id, id)).run()
  // A library tool is shared — re-materialize every agent that has it assigned.
  for (const agentId of agentsUsingTool(id)) syncAgentTools(agentId)
  return db.select().from(tools).where(eq(tools.id, id)).get() ?? null
}

export function deleteLibraryTool(id: string): boolean {
  const existing = db.select().from(tools).where(eq(tools.id, id)).get()
  if (!existing) return false
  // Capture assignees before the FK cascade clears agent_tools.
  const affected = agentsUsingTool(id)
  db.delete(tools).where(eq(tools.id, id)).run()
  for (const agentId of affected) syncAgentTools(agentId)
  return true
}

// ── Assignments (agent ↔ library tool) ──────────────────────────────────────

/** Tool ids assigned to an agent. */
export function listAgentToolIds(agentId: string): string[] {
  return db
    .select({ toolId: agentTools.toolId })
    .from(agentTools)
    .where(eq(agentTools.agentId, agentId))
    .all()
    .map((r) => r.toolId)
}

/** Library tool definitions assigned to an agent. */
export function listAgentTools(agentId: string): Tool[] {
  const ids = listAgentToolIds(agentId)
  if (ids.length === 0) return []
  return db.select().from(tools).where(inArray(tools.id, ids)).all()
}

/** Agent ids that have a given library tool assigned. */
export function agentsUsingTool(toolId: string): string[] {
  return db
    .select({ agentId: agentTools.agentId })
    .from(agentTools)
    .where(eq(agentTools.toolId, toolId))
    .all()
    .map((r) => r.agentId)
}

export function assignTool(agentId: string, toolId: string): void {
  db.insert(agentTools).values({ agentId, toolId, createdAt: new Date() }).onConflictDoNothing().run()
  syncAgentTools(agentId)
}

export function unassignTool(agentId: string, toolId: string): void {
  db.delete(agentTools)
    .where(and(eq(agentTools.agentId, agentId), eq(agentTools.toolId, toolId)))
    .run()
  syncAgentTools(agentId)
}

// ── Materialization ─────────────────────────────────────────────────────────

/** True if the agent has a Telegram connection (so it gets a send-telegram tool). */
function agentHasConnection(agentId: string): boolean {
  return (
    db.select().from(connections).where(eq(connections.agentId, agentId)).all().length > 0
  )
}

/**
 * Rewrite `workspace/tools/` from scratch: built-in tools plus every library
 * tool assigned to this agent. The directory is cleared first so unassigned/
 * deleted tools don't linger.
 */
export function materializeAgentTools(agentId: string): void {
  const dir = paths.agentToolsDir(agentId)
  try {
    for (const entry of readdirSync(dir)) rmSync(`${dir}/${entry}`, { force: true })
  } catch {
    /* dir doesn't exist yet */
  }
  mkdirSync(dir, { recursive: true })

  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get()

  if (agent?.isOperator) {
    // helmCaptain: the helm CLI to inspect the fleet (read-only in part 1).
    writeExecutable(`${dir}/helm`, operatorCliSource())
  } else {
    // Built-in: heartbeat self-config (always present on regular agents).
    writeExecutable(`${dir}/heartbeat`, heartbeatToolSource(agentId))
    // Built-in: send-telegram (only when a connection exists).
    if (agentHasConnection(agentId)) {
      writeExecutable(`${dir}/send-telegram`, sendTelegramToolSource(agentId))
    }
  }

  // Assigned library tools (apply to both operator and regular agents).
  for (const tool of listAgentTools(agentId)) {
    const shebang = SHEBANGS[tool.interpreter] ?? `#!/usr/bin/env ${tool.interpreter}`
    const body = tool.source.startsWith('#!') ? tool.source : `${shebang}\n${tool.source}`
    writeExecutable(`${dir}/${toolFileName(tool.name)}`, body)
  }
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents.endsWith('\n') ? contents : `${contents}\n`)
  chmodSync(path, 0o755)
}

/** Regenerate workspace/tools + CLAUDE.md for an agent. Call after any change. */
export function syncAgentTools(agentId: string): void {
  materializeAgentTools(agentId)
  renderClaudeMd(agentId)
}

// ── CLAUDE.md rendering ─────────────────────────────────────────────────────

/** Compose CLAUDE.md = agent system prompt + a managed tools block. */
export function renderClaudeMd(agentId: string): void {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (!agent) return

  const custom = listAgentTools(agentId)
  const hasConnection = agentHasConnection(agentId)

  const lines: string[] = [TOOLS_BLOCK_START, '', '## Tools available to you', '']
  lines.push(
    'You have local scripts in the `tools/` directory. Invoke them with the Bash tool',
    'from your working directory (e.g. `tools/heartbeat list`). Use them whenever your',
    'task or the situation calls for it — they are yours to use autonomously.',
    '',
  )

  if (agent.isOperator) {
    lines.push('### helm — inspect helmConsole (read-only for now)')
    lines.push(
      'Run these via Bash to see the live state of the fleet and the tool library.',
      'Always check live state with `helm` before answering questions about agents —',
      'never guess.',
      '```',
      'tools/helm context          # snapshot: all agents + the tool library',
      'tools/helm agent ls         # list agents',
      "tools/helm agent get <id>   # one agent's full config (prompt, tools, connections, heartbeats)",
      'tools/helm tool ls          # the shared tool library',
      '```',
      'Write commands (creating/configuring agents, authoring tools) are coming next —',
      'you cannot modify anything yet.',
      '',
    )
  } else {
    lines.push('### heartbeat — schedule recurring prompts to yourself')
    lines.push(
      'A heartbeat fires a prompt into you on a cron schedule, even when no one is',
      'chatting. Manage your own heartbeats:',
      '```',
      'tools/heartbeat list',
      'tools/heartbeat add --cron "*/30 * * * *" --prompt "Check the news and tell me anything important"',
      'tools/heartbeat update <id> --cron "0 9 * * *" --prompt "..." --name "..."',
      'tools/heartbeat enable <id>',
      'tools/heartbeat disable <id>',
      'tools/heartbeat rm <id>',
      '```',
      'Cron is standard 5-field: `minute hour day-of-month month day-of-week`.',
      '',
      '**Where a heartbeat is delivered (`--target`).** Default is `main` — the',
      'fired turn runs in this (console) session and is not sent anywhere unless you',
      'call send-telegram. Use `--target chat --chat <id>` to fire the heartbeat',
      'inside a specific Telegram chat (it runs in that chat and send-telegram',
      'defaults to replying there). The `<id>` is the `Chat ID` shown at the top of',
      'an inbound Telegram message.',
      '```',
      'tools/heartbeat add --cron "0 9 * * *" --prompt "Good morning!" --target chat --chat 847392011',
      '```',
      '',
    )

    if (hasConnection) {
      lines.push('### send-telegram — your voice on Telegram')
      lines.push(
        'This tool is the ONLY way to deliver a message to the user on Telegram.',
        'Your normal turn/reply text is NOT sent to them — it is only logged. To',
        'actually reach the user you must call this tool:',
        '```',
        'tools/send-telegram "your message here"            # reply to the current chat',
        'tools/send-telegram --chat <id> "your message"     # send to a specific chat',
        '```',
        'By default it replies to the chat the current turn belongs to. Use `--chat',
        '<id>` to target a different chat (the `Chat ID` is shown at the top of an',
        'inbound Telegram message).',
        '**Responding to messages from external connections.** Some turns are not from',
        'the local console but arrive from an external connection (Telegram). These are',
        'clearly marked at the top of the prompt with the connection and sender (e.g.',
        '`[Inbound message via Telegram]`). When a turn is marked that way, the person',
        'is NOT watching your reply text — you MUST answer them by calling',
        '`send-telegram` (it replies to that same chat by default). Compose your full',
        'reply, send it with the tool, then finish the turn. The same applies to any',
        'proactive or heartbeat update you want the user to actually see.',
        '',
      )
    }
  }

  for (const tool of custom) {
    lines.push(`### ${toolFileName(tool.name)} — ${tool.description}`)
    lines.push('```', `tools/${toolFileName(tool.name)} [args]`, '```', '')
  }

  lines.push(TOOLS_BLOCK_END)
  const block = lines.join('\n')

  const claudeMd = `${agent.systemPrompt.trim()}\n\n${block}\n`
  mkdirSync(paths.agentWorkspaceDir(agentId), { recursive: true })
  writeFileSync(paths.agentClaudeMd(agentId), claudeMd)
}

// ── Built-in tool sources ───────────────────────────────────────────────────
// Plain CommonJS-compatible Node scripts (global fetch, no imports). Written
// with string concatenation only — no template literals / `${}` inside — so
// they embed cleanly here. AGENT_ID and BASE are injected per agent.

function heartbeatToolSource(agentId: string): string {
  return `#!/usr/bin/env node
'use strict';
const AGENT_ID = ${JSON.stringify(agentId)};
const BASE = ${JSON.stringify(BASE_URL)};
const argv = process.argv.slice(2);
const cmd = argv[0];

function flags(args) {
  const out = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.indexOf('--') === 0) {
      const k = a.slice(2);
      const v = (i + 1 < args.length && args[i + 1].indexOf('--') !== 0) ? args[++i] : 'true';
      out[k] = v;
    } else pos.push(a);
  }
  return { out, pos };
}

async function api(method, path, body) {
  const res = await fetch(BASE + '/api/agents/' + AGENT_ID + path, {
    method: method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) { console.error('error ' + res.status + ': ' + text); process.exit(1); }
  return text ? JSON.parse(text) : null;
}

(async function () {
  if (cmd === 'list' || !cmd) {
    const hb = await api('GET', '/heartbeats');
    console.log(JSON.stringify(hb, null, 2));
  } else if (cmd === 'add') {
    const f = flags(argv.slice(1)).out;
    if (!f.cron || !f.prompt) {
      console.error('usage: heartbeat add --cron "<expr>" --prompt "<text>" [--name "<name>"] [--target main|chat] [--chat <id>]');
      process.exit(1);
    }
    if (f.target === 'chat' && !f.chat) {
      console.error('--target chat requires --chat <id>');
      process.exit(1);
    }
    const body = { cron: f.cron, prompt: f.prompt, name: f.name };
    if (f.target) body.targetType = f.target;
    if (f.chat) body.targetChatId = f.chat;
    const r = await api('POST', '/heartbeats', body);
    console.log('created heartbeat ' + r.id);
  } else if (cmd === 'update') {
    const id = argv[1];
    const f = flags(argv.slice(2)).out;
    const patch = {};
    if (f.cron) patch.cron = f.cron;
    if (f.prompt) patch.prompt = f.prompt;
    if (f.name) patch.name = f.name;
    if (f.enabled !== undefined) patch.enabled = f.enabled === 'true';
    if (f.target) patch.targetType = f.target;
    if (f.chat) patch.targetChatId = f.chat;
    await api('PATCH', '/heartbeats/' + id, patch);
    console.log('updated ' + id);
  } else if (cmd === 'rm') {
    await api('DELETE', '/heartbeats/' + argv[1]);
    console.log('removed ' + argv[1]);
  } else if (cmd === 'enable' || cmd === 'disable') {
    await api('PATCH', '/heartbeats/' + argv[1], { enabled: cmd === 'enable' });
    console.log(cmd + 'd ' + argv[1]);
  } else {
    console.error('unknown command: ' + cmd);
    process.exit(1);
  }
})().catch(function (e) { console.error(String(e)); process.exit(1); });
`
}

// The helm CLI (operator-only). Talks to the daemon's REST endpoints; fleet ops
// need no agent id, only BASE. Read + write commands.
function operatorCliSource(): string {
  // Runs as an ES module (the repo's package.json has "type":"module"), so use
  // a static import for fs rather than require().
  return `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const BASE = ${JSON.stringify(BASE_URL)};
const argv = process.argv.slice(2);
const cmd = argv[0];
const sub = argv[1];

function flags(args) {
  const out = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.indexOf('--') === 0) {
      const k = a.slice(2);
      const v = (i + 1 < args.length && args[i + 1].indexOf('--') !== 0) ? args[++i] : 'true';
      out[k] = v;
    } else pos.push(a);
  }
  return { out: out, pos: pos };
}

// Resolve --<key> inline, or --<key>-file <path> (preferred for multi-line text).
function readArg(f, key) {
  if (f[key] !== undefined) return f[key];
  if (f[key + '-file'] !== undefined) return readFileSync(f[key + '-file'], 'utf8');
  return undefined;
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method: method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) { console.error('error ' + res.status + ': ' + text); process.exit(1); }
  return text ? JSON.parse(text) : null;
}
function get(path) { return call('GET', path); }

function out(v) { console.log(JSON.stringify(v, null, 2)); }

function usage() {
  console.log(
    'helm — manage helmConsole\\n' +
    'read:\\n' +
    '  helm context\\n' +
    '  helm agent ls\\n' +
    '  helm agent get <id>\\n' +
    '  helm tool ls\\n' +
    'write:\\n' +
    '  helm agent new --name <n> --prompt|--prompt-file <p> [--model <m>]\\n' +
    '  helm agent set-prompt <id> --prompt|--prompt-file <p>\\n' +
    '  helm agent rm <id>\\n' +
    '  helm tool author --name <n> --desc <d> --interp <bash|node|python3> --source|--source-file <s> [--assign <agentId>]\\n' +
    '  helm tool set <id> [--desc <d>] [--source|--source-file <s>] [--interp <i>]\\n' +
    '  helm tool rm <id>\\n' +
    '  helm tool assign <toolId> --agent <agentId>\\n' +
    '  helm tool unassign <toolId> --agent <agentId>'
  );
}

(async function () {
  if (!cmd || cmd === 'help' || cmd === '--help') { usage(); return; }

  if (cmd === 'context') {
    out({ agents: await get('/api/agents/list'), library: await get('/api/tools') });

  } else if (cmd === 'agent') {
    if (sub === 'ls') { out(await get('/api/agents/list')); }
    else if (sub === 'get') {
      if (!argv[2]) { console.error('usage: helm agent get <id>'); process.exit(1); }
      out(await get('/api/agents/' + argv[2] + '/info'));
    } else if (sub === 'new') {
      const f = flags(argv.slice(2)).out;
      const prompt = readArg(f, 'prompt');
      if (!f.name || !prompt) { console.error('usage: helm agent new --name <n> --prompt|--prompt-file <p> [--model <m>]'); process.exit(1); }
      const r = await call('POST', '/api/agents/create', { name: f.name, systemPrompt: prompt, model: f.model });
      console.log('created agent ' + r.id);
    } else if (sub === 'set-prompt') {
      const id = argv[2];
      const f = flags(argv.slice(3)).out;
      const prompt = readArg(f, 'prompt');
      if (!id || !prompt) { console.error('usage: helm agent set-prompt <id> --prompt|--prompt-file <p>'); process.exit(1); }
      await call('PATCH', '/api/agents/' + id + '/info', { systemPrompt: prompt });
      console.log('updated prompt for ' + id);
    } else if (sub === 'rm') {
      if (!argv[2]) { console.error('usage: helm agent rm <id>'); process.exit(1); }
      await call('DELETE', '/api/agents/' + argv[2] + '/info');
      console.log('removed agent ' + argv[2]);
    } else { console.error('unknown: helm agent ' + (sub || '')); process.exit(1); }

  } else if (cmd === 'tool') {
    if (sub === 'ls') { out(await get('/api/tools')); }
    else if (sub === 'author') {
      const f = flags(argv.slice(2)).out;
      const source = readArg(f, 'source');
      if (!f.name || !f.desc || !source) { console.error('usage: helm tool author --name <n> --desc <d> --interp <i> --source|--source-file <s> [--assign <agentId>]'); process.exit(1); }
      const body = { name: f.name, description: f.desc, interpreter: f.interp || 'bash', source: source };
      if (f.assign) body.assignTo = [f.assign];
      const r = await call('POST', '/api/tools', body);
      console.log('authored tool ' + r.id + (f.assign ? ' (assigned to ' + f.assign + ')' : ''));
    } else if (sub === 'set') {
      const id = argv[2];
      const f = flags(argv.slice(3)).out;
      if (!id) { console.error('usage: helm tool set <id> [--desc <d>] [--source|--source-file <s>] [--interp <i>]'); process.exit(1); }
      const patch = {};
      if (f.name) patch.name = f.name;
      if (f.desc) patch.description = f.desc;
      if (f.interp) patch.interpreter = f.interp;
      const source = readArg(f, 'source');
      if (source !== undefined) patch.source = source;
      await call('PATCH', '/api/tools/' + id, patch);
      console.log('updated tool ' + id);
    } else if (sub === 'rm') {
      if (!argv[2]) { console.error('usage: helm tool rm <id>'); process.exit(1); }
      await call('DELETE', '/api/tools/' + argv[2]);
      console.log('removed tool ' + argv[2]);
    } else if (sub === 'assign' || sub === 'unassign') {
      const toolId = argv[2];
      const f = flags(argv.slice(3)).out;
      if (!toolId || !f.agent) { console.error('usage: helm tool ' + sub + ' <toolId> --agent <agentId>'); process.exit(1); }
      if (sub === 'assign') { await call('POST', '/api/agents/' + f.agent + '/tools', { toolId: toolId }); console.log('assigned ' + toolId + ' to ' + f.agent); }
      else { await call('DELETE', '/api/agents/' + f.agent + '/tools/' + toolId); console.log('unassigned ' + toolId + ' from ' + f.agent); }
    } else { console.error('unknown: helm tool ' + (sub || '')); process.exit(1); }

  } else { console.error('unknown command: ' + cmd); usage(); process.exit(1); }
})().catch(function (e) { console.error(String(e)); process.exit(1); });
`
}

function sendTelegramToolSource(agentId: string): string {
  return `#!/usr/bin/env node
'use strict';
const AGENT_ID = ${JSON.stringify(agentId)};
const BASE = ${JSON.stringify(BASE_URL)};

// Parse an optional --chat <id>; everything else joins into the message text.
const argv = process.argv.slice(2);
let chatId = process.env.HELM_CHAT_ID || undefined;
const parts = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--chat') { chatId = argv[++i]; continue; }
  parts.push(argv[i]);
}
const text = parts.join(' ').trim();
if (!text) { console.error('usage: send-telegram [--chat <id>] "<message>"'); process.exit(1); }

(async function () {
  const res = await fetch(BASE + '/api/agents/' + AGENT_ID + '/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: text, chatId: chatId }),
  });
  const t = await res.text();
  if (!res.ok) { console.error('send failed ' + res.status + ': ' + t); process.exit(1); }
  console.log('sent');
})().catch(function (e) { console.error(String(e)); process.exit(1); });
`
}
