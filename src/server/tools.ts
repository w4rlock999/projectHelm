import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { agents, agentTools, gateways, tools } from '../db/schema.ts';
import { paths } from './paths.ts';
import type { Tool } from '../db/schema.ts';
// Built-in tool scripts live as real files under builtin-tools/ and are inlined
// here as text at build time (Vite `?raw`). They are self-contained standalone
// scripts run by the agent; per-agent values (HELM_AGENT_ID) and the daemon URL
// (HELM_BASE_URL) reach them via the environment the daemon spawns the agent
// with, so no per-agent baking/interpolation is needed.
import heartbeatToolSource from './builtin-tools/heartbeat.mjs?raw';
import operatorCliSource from './builtin-tools/helm.mjs?raw';
import sendTelegramToolSource from './builtin-tools/send-telegram.mjs?raw';

const TOOLS_BLOCK_START = '<!-- helm:tools:start -->';
const TOOLS_BLOCK_END = '<!-- helm:tools:end -->';

const SHEBANGS: Record<string, string> = {
  bash: '#!/usr/bin/env bash',
  sh: '#!/usr/bin/env sh',
  node: '#!/usr/bin/env node',
  python: '#!/usr/bin/env python3',
  python3: '#!/usr/bin/env python3',
};

/** Filesystem-safe tool filename derived from the tool name. */
export function toolFileName(name: string): string {
  const safe = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || 'tool';
}

// ── Tool library CRUD (definitions, owned by no agent) ──────────────────────

export interface CreateToolInput {
  name: string;
  description: string;
  interpreter?: string;
  source: string;
}

export function listLibraryTools(): Tool[] {
  return db.select().from(tools).all();
}

export function getLibraryTool(id: string): Tool | null {
  return db.select().from(tools).where(eq(tools.id, id)).get() ?? null;
}

export function createLibraryTool(input: CreateToolInput): Tool {
  const now = new Date();
  const row: Tool = {
    id: randomUUID(),
    name: input.name,
    description: input.description,
    interpreter: input.interpreter?.trim() || 'bash',
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(tools).values(row).run();
  return row;
}

export function updateLibraryTool(
  id: string,
  patch: Partial<Pick<Tool, 'name' | 'description' | 'interpreter' | 'source'>>,
): Tool | null {
  const existing = db.select().from(tools).where(eq(tools.id, id)).get();
  if (!existing) return null;
  db.update(tools)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tools.id, id))
    .run();
  // A library tool is shared — re-materialize every agent that has it assigned.
  for (const agentId of agentsUsingTool(id)) syncAgentTools(agentId);
  return db.select().from(tools).where(eq(tools.id, id)).get() ?? null;
}

export function deleteLibraryTool(id: string): boolean {
  const existing = db.select().from(tools).where(eq(tools.id, id)).get();
  if (!existing) return false;
  // Capture assignees before the FK cascade clears agent_tools.
  const affected = agentsUsingTool(id);
  db.delete(tools).where(eq(tools.id, id)).run();
  for (const agentId of affected) syncAgentTools(agentId);
  return true;
}

// ── Assignments (agent ↔ library tool) ──────────────────────────────────────

/** Tool ids assigned to an agent. */
export function listAgentToolIds(agentId: string): string[] {
  return db
    .select({ toolId: agentTools.toolId })
    .from(agentTools)
    .where(eq(agentTools.agentId, agentId))
    .all()
    .map((r) => r.toolId);
}

/** Library tool definitions assigned to an agent. */
export function listAgentTools(agentId: string): Tool[] {
  const ids = listAgentToolIds(agentId);
  if (ids.length === 0) return [];
  return db.select().from(tools).where(inArray(tools.id, ids)).all();
}

/** Agent ids that have a given library tool assigned. */
export function agentsUsingTool(toolId: string): string[] {
  return db
    .select({ agentId: agentTools.agentId })
    .from(agentTools)
    .where(eq(agentTools.toolId, toolId))
    .all()
    .map((r) => r.agentId);
}

export function assignTool(agentId: string, toolId: string): void {
  db.insert(agentTools)
    .values({ agentId, toolId, createdAt: new Date() })
    .onConflictDoNothing()
    .run();
  syncAgentTools(agentId);
}

export function unassignTool(agentId: string, toolId: string): void {
  db.delete(agentTools)
    .where(and(eq(agentTools.agentId, agentId), eq(agentTools.toolId, toolId)))
    .run();
  syncAgentTools(agentId);
}

// ── Materialization ─────────────────────────────────────────────────────────

/** True if the agent has a Telegram gateway (so it gets a send-telegram tool). */
function agentHasGateway(agentId: string): boolean {
  return db.select().from(gateways).where(eq(gateways.agentId, agentId)).all().length > 0;
}

/**
 * Rewrite `workspace/tools/` from scratch: built-in tools plus every library
 * tool assigned to this agent. The directory is cleared first so unassigned/
 * deleted tools don't linger.
 */
export function materializeAgentTools(agentId: string): void {
  const dir = paths.agentToolsDir(agentId);
  try {
    for (const entry of readdirSync(dir)) rmSync(`${dir}/${entry}`, { force: true });
  } catch {
    /* dir doesn't exist yet */
  }
  mkdirSync(dir, { recursive: true });

  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();

  if (agent?.isOperator) {
    // helmCaptain: the helm CLI to inspect the fleet (read-only in part 1).
    writeExecutable(`${dir}/helm`, operatorCliSource);
  } else {
    // Built-in: heartbeat self-config (always present on regular agents).
    writeExecutable(`${dir}/heartbeat`, heartbeatToolSource);
    // Built-in: send-telegram (only when a gateway exists).
    if (agentHasGateway(agentId)) {
      writeExecutable(`${dir}/send-telegram`, sendTelegramToolSource);
    }
  }

  // Assigned library tools (apply to both operator and regular agents).
  for (const tool of listAgentTools(agentId)) {
    const shebang = SHEBANGS[tool.interpreter] ?? `#!/usr/bin/env ${tool.interpreter}`;
    const body = tool.source.startsWith('#!') ? tool.source : `${shebang}\n${tool.source}`;
    writeExecutable(`${dir}/${toolFileName(tool.name)}`, body);
  }
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents.endsWith('\n') ? contents : `${contents}\n`);
  chmodSync(path, 0o755);
}

/** Regenerate workspace/tools + CLAUDE.md for an agent. Call after any change. */
export function syncAgentTools(agentId: string): void {
  materializeAgentTools(agentId);
  renderClaudeMd(agentId);
}

// ── CLAUDE.md rendering ─────────────────────────────────────────────────────

/** Compose CLAUDE.md = agent system prompt + a managed tools block. */
export function renderClaudeMd(agentId: string): void {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent) return;

  const custom = listAgentTools(agentId);
  const hasGateway = agentHasGateway(agentId);

  const lines: string[] = [TOOLS_BLOCK_START, '', '## Tools available to you', ''];
  lines.push(
    'You have local scripts in the `tools/` directory. Invoke them with the Bash tool',
    'from your working directory (e.g. `tools/heartbeat list`). Use them whenever your',
    'task or the situation calls for it — they are yours to use autonomously.',
    '',
  );

  if (agent.isOperator) {
    lines.push('### helm — inspect helmConsole (read-only for now)');
    lines.push(
      'Run these via Bash to see the live state of the fleet and the tool library.',
      'Always check live state with `helm` before answering questions about agents —',
      'never guess.',
      '```',
      'tools/helm context          # snapshot: all agents + the tool library',
      'tools/helm agent ls         # list agents',
      "tools/helm agent get <id>   # one agent's full config (prompt, tools, gateways, heartbeats)",
      'tools/helm tool ls          # the shared tool library',
      '```',
      'Write commands (creating/configuring agents, authoring tools) are coming next —',
      'you cannot modify anything yet.',
      '',
    );
  } else {
    lines.push('### heartbeat — schedule recurring prompts to yourself');
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
    );

    if (hasGateway) {
      lines.push('### send-telegram — your voice on Telegram');
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
        '**Responding to messages from external gateways.** Some turns are not from',
        'the local console but arrive from an external gateway (Telegram). These are',
        'clearly marked at the top of the prompt with the gateway and sender (e.g.',
        '`[Inbound message via Telegram]`). When a turn is marked that way, the person',
        'is NOT watching your reply text — you MUST answer them by calling',
        '`send-telegram` (it replies to that same chat by default). Compose your full',
        'reply, send it with the tool, then finish the turn. The same applies to any',
        'proactive or heartbeat update you want the user to actually see.',
        '',
      );
    }
  }

  for (const tool of custom) {
    lines.push(`### ${toolFileName(tool.name)} — ${tool.description}`);
    lines.push('```', `tools/${toolFileName(tool.name)} [args]`, '```', '');
  }

  lines.push('## Your data');
  lines.push(
    'You have two durable stores, provided as environment variables (use them from',
    'the Bash tool, e.g. `ls "$HELM_SESSION_STORE_DIR"`). They persist across turns',
    'and survive tool/CLAUDE.md regeneration — unlike the workspace.',
    '',
    '- **`$HELM_AGENT_STORE_DIR`** — your agent store, shared across all of your',
    '  sessions. Keep durable notes, reference material, and artifacts here',
    '  (e.g. `$HELM_AGENT_STORE_DIR/artifacts/`).',
    '- **`$HELM_SESSION_STORE_DIR`** — private storage for the current session',
    '  (conversation) only. Use it for context and memory specific to whoever you',
    '  are talking to now.',
    '',
  );
  if (agent.sessionRecall === 'all') {
    lines.push(
      '- **`$HELM_SESSIONS_DIR`** — a **read-only** view of *all* your session',
      '  stores (one subdirectory per session; the current one is also your',
      '  `$HELM_SESSION_STORE_DIR`). Grep across it to recall what happened in your',
      '  other conversations. Write only to `$HELM_SESSION_STORE_DIR`, never here.',
      '',
    );
  }
  if (agent.sessionScope === 'chat') {
    lines.push(
      agent.sessionRecall === 'all'
        ? 'Your sessions are separate per chat — each conversation writes to its own ' +
            '`$HELM_SESSION_STORE_DIR` — but you may *read* across all of them via ' +
            '`$HELM_SESSIONS_DIR` above.'
        : 'Your sessions are isolated per chat: each conversation has its own ' +
            '`$HELM_SESSION_STORE_DIR` and cannot read the others.',
      'Treat `$HELM_AGENT_STORE_DIR` as **read-only** — anything written there',
      'becomes visible to every session, so keep private, per-person data in',
      '`$HELM_SESSION_STORE_DIR`, never in the agent store.',
      '',
    );
  }

  lines.push(TOOLS_BLOCK_END);
  const block = lines.join('\n');

  const claudeMd = `${agent.systemPrompt.trim()}\n\n${block}\n`;
  mkdirSync(paths.agentWorkspaceDir(agentId), { recursive: true });
  writeFileSync(paths.agentClaudeMd(agentId), claudeMd);
}
