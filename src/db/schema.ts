import { sql } from 'drizzle-orm';
import type { HarnessFingerprint } from '../server/harness/fingerprint.ts';
import type { HarnessProfile } from '../server/harness/profile.ts';
import type { McpServerConfig, Runtime } from '../server/library/mcp-schema.ts';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  allowedTools: text('allowed_tools'),
  model: text('model'),
  // The session resumed when a turn's scope resolves to the agent: the browser
  // console, `target='main'` heartbeats, and *every* turn when sessionScope is
  // 'agent'. Per-chat sessions (sessionScope='chat') live on gatewaysChat.
  claudeSessionId: text('claude_session_id'),
  // 'chat' = each Telegram chat is its own isolated session; 'agent' = one
  // shared session across all chats + browser + heartbeats. New agents default
  // to 'chat' (isolated); the migration flips pre-existing agents to 'agent'.
  sessionScope: text('session_scope').notNull().default('chat'),
  // Cross-session recall authz — a single coarse knob (no per-principal ACL).
  // 'none' = the agent only ever sees the current session's store; 'all' = it
  // may read across *every* one of its session stores (exposed as
  // HELM_SESSIONS_DIR). Under 'none' the agent loses context between sessions.
  // New agents default to 'none' (isolated).
  sessionRecall: text('session_recall').notNull().default('none'),
  // helmCaptain — the operator agent that manages the fleet. Exactly one row
  // has this set; it's hidden from the normal fleet list and gets its own
  // chat surface. Everything else (runner, sessions, logs) is shared.
  isOperator: integer('is_operator', { mode: 'boolean' }).notNull().default(false),
  // ── Deployment (helmship M-remote-2) ──────────────────────────────────────
  // The remote this agent lives on. Deliberately NOT a FK: ON DELETE SET NULL
  // would silently mark a still-running remote agent as local, and CASCADE
  // would delete it outright. `removeRemote` guards instead.
  deployedTo: text('deployed_to'),
  // The single "is this agent locally live?" predicate. null = this daemon owns
  // it and may run it. Non-null = the run gate refuses, reconcileGateways()
  // drops its pollers, and the heartbeat tick skips it:
  //   'shipping'   local→remote transfer in flight
  //   'deployed'   settled on deployedTo
  //   'recalling'  remote→local transfer in flight
  //   'stranded'   transfer outcome unknown; needs an operator decision
  // Written BEFORE deactivation so a crash mid-transfer restarts with the agent
  // still deactivated — otherwise two pollers could hold one bot token.
  deployState: text('deploy_state'),
  deployedAt: integer('deployed_at', { mode: 'timestamp' }),
  // Last transfer failure, surfaced in the console. Cleared on the next attempt.
  deployError: text('deploy_error'),
  // Rolling-window cap on turns from ALL sources (heartbeat, gateway, console).
  // null = unlimited. Enforced centrally in src/server/runs.ts.
  runBudgetPerHour: integer('run_budget_per_hour'),
  // ── Harness (harness ownership H0) ────────────────────────────────────────
  // What Claude Code actually loaded on this agent's most recent turn (from
  // the `system/init` event): CLI version, resolved model, skills, plugins,
  // MCP servers with status. Names and statuses only — never config. Shown in
  // the console and compared across the ship seam. Null until the first turn.
  lastHarness: text('last_harness', { mode: 'json' }).$type<HarnessFingerprint>(),
  // ── Harness profile (harness ownership H1) ────────────────────────────────
  // The agent's own effort / permission mode / max turns / fallback model.
  // Every field nullable; null here (or a null row) inherits the fleet default
  // in `settings['harness.defaults']`. Rendered to argv by agentRuntime().
  harness: text('harness', { mode: 'json' }).$type<HarnessProfile>(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// The shared tool library: user-authored custom tool *definitions*, owned by no
// single agent. Agents reference them via `agentTools`. When an agent is
// assigned a tool, it's materialized to that agent's `workspace/tools/<name>`
// (executable) and described in its CLAUDE.md so it can invoke it via Bash.
// Built-in tools (heartbeat, send-telegram) are generated at materialization
// time and do NOT live here.
export const tools = sqliteTable('tools', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  // Interpreter used for the shebang + filename extension, e.g. 'bash' | 'node' | 'python3'.
  interpreter: text('interpreter').notNull().default('bash'),
  source: text('source').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Many-to-many: which library tools each agent has been assigned. Assigning a
// tool materializes it into the agent's workspace; unassigning removes it.
export const agentTools = sqliteTable(
  'agent_tools',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    toolId: text('tool_id')
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.toolId] })],
);

// ── MCP server library (harness H2) ─────────────────────────────────────────
// Shared MCP server *definitions*, owned by no agent. Assigning one to an agent
// renders it into that agent's isolated `harness/mcp.json` and grants
// `mcp__<name>` on its allow-list. `name` is unique: it is the key in mcp.json
// and the prefix of every tool the server exposes, so two servers with one
// name could not both be assigned to an agent.
export const mcpServers = sqliteTable(
  'mcp_servers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    // McpServerConfig (library/mcp-schema.ts): stdio (runtime command + args +
    // env) or http (url + headers). Env/header values are secrets, plaintext
    // at rest like gateways.token — redacted on every read surface.
    config: text('config', { mode: 'json' }).$type<McpServerConfig>().notNull(),
    // Runtimes the server needs on the machine that runs the agent (the stdio
    // command is always among them). Ship preflight checks the remote has them.
    requires: text('requires', { mode: 'json' }).$type<Runtime[]>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex('mcp_servers_name_uq').on(t.name)],
);

// Many-to-many: which library MCP servers each agent has. Mirrors agent_tools.
export const agentMcpServers = sqliteTable(
  'agent_mcp_servers',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    mcpServerId: text('mcp_server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.mcpServerId] })],
);

// A gateway is the agent's credentialed binding to a messaging platform
// (v0: Telegram only) — its outbound voice (the `send-telegram` tool) and
// inbound ear (a getUpdates long-poll loop feeds messages back as agent runs).
// Individual conversations under a gateway are rows in `gateways_chat`.
export const gateways = sqliteTable('gateways', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  type: text('type').notNull().default('telegram'),
  // BotFather token. Plaintext for v0 (TODO: encrypt at rest).
  token: text('token').notNull(),
  // getUpdates cursor (last update_id + 1). Per-bot — one long-poll per token.
  pollOffset: integer('poll_offset').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// One conversation under a gateway, keyed by Telegram chat.id — the
// principal. Holds the per-chat Claude session (when the agent's sessionScope
// is 'chat'), a status gate, and a human-readable title for the UI.
export const gatewaysChat = sqliteTable(
  'gateways_chat',
  {
    id: text('id').primaryKey(),
    gatewayId: text('gateway_id')
      .notNull()
      .references(() => gateways.id, { onDelete: 'cascade' }),
    // Telegram chat.id. For DMs this equals the user's id; for groups it's the
    // room. The unit of session isolation and the outbound reply target.
    chatId: text('chat_id').notNull(),
    // Per-chat session, resumed when sessionScope='chat'. Null until first turn.
    claudeSessionId: text('claude_session_id'),
    // Display only: chat.title for groups, first_name/@username for DMs.
    title: text('title'),
    // 'active' | 'blocked' — blocked chats don't spawn turns.
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    lastMessageAt: integer('last_message_at', { mode: 'timestamp' }),
  },
  (t) => [uniqueIndex('gateway_chat_uq').on(t.gatewayId, t.chatId)],
);

// A registered remote deployment environment: a VPS running this same helm
// daemon headlessly (docs/helmship-plan.md). Reached over an SSH tunnel; the
// pairing token authenticates every request to its /api surface.
export const remotes = sqliteTable('remotes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // 'user@host[:port]' — handed to the system ssh, so ~/.ssh/config, keys and
  // the agent all apply.
  sshTarget: text('ssh_target').notNull(),
  // Optional `-i` identity file (an absolute path on THIS machine, never key
  // material). Null means "let ssh pick" — ~/.ssh/config and the agent apply.
  // Machine parity P0: saved so a check/provision needs no ambient ssh setup
  // beyond the key itself.
  sshIdentityFile: text('ssh_identity_file'),
  // Port the remote daemon listens on (bound to 127.0.0.1 on the remote).
  helmPort: integer('helm_port').notNull().default(5555),
  // Pairing token. Plaintext for v1 (same posture as gateways.token —
  // encrypt-at-rest is a later milestone).
  token: text('token').notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  lastVersion: text('last_version'),
  // Harness capabilities advertised by the last successful handshake.
  capabilities: text('capabilities', { mode: 'json' }).$type<
    { type: string; version: string | null; authOk: boolean }[]
  >(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// What helm did to a machine (machine parity P0). One row per provision /
// upgrade / init run, or per operator `helm remote exec` (recorded after the
// fact by the CLI as an 'exec-note'). "What did an agent do to my VPS" must be
// answerable from the CLI, not only from a log file.
//
// `remoteId` is null for the local machine (`helm machine apply`) and is not a
// FK: unregistering a remote must not erase the record of what was run on it.
// `detail` never carries env values or tokens — argv and step names only.
export const remoteOps = sqliteTable('remote_ops', {
  id: text('id').primaryKey(),
  remoteId: text('remote_id'),
  // 'provision' | 'upgrade' | 'init' | 'exec-note'
  kind: text('kind').notNull(),
  detail: text('detail', { mode: 'json' }).notNull().$type<unknown>(),
  // 'operator' | 'agent' | 'system'
  requestedBy: text('requested_by').notNull(),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
  code: integer('code'),
  logPath: text('log_path'),
});
export type RemoteOp = typeof remoteOps.$inferSelect;

// Remote copies that a completed recall could not delete.
//
// The confirm-delete at the end of `recall` is the one step that may fail
// without making the recall itself wrong: the local side already holds the
// agent, and the remote copy is deactivated (its own deployState is still
// 'recalling'), so nothing is double-polling. But nothing is cleaning it up
// either — the recall has, by then, restored the local row with deployState and
// deployedTo both back to null, so the agent row itself has no memory of which
// remote is still holding a copy. That is what this table remembers.
//
// A table rather than a column on `agents`: an agent can strand a copy on
// remote A, later ship to B and strand one there too, and a single column would
// silently overwrite the first — the exact "nothing is lost quietly" property
// this exists to provide.
//
// Neither column is a FK. `remotes`: an unregistered remote is precisely when
// this row is the only remaining evidence that a copy is out there. `agents`:
// deleting the agent locally does not delete the copy on the remote, so the
// sweep must outlive it.
export const recallOrphans = sqliteTable(
  'recall_orphans',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    remoteId: text('remote_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    lastTriedAt: integer('last_tried_at', { mode: 'timestamp' }),
    // Why the last attempt did not clear it. Surfaced in the boot log.
    lastError: text('last_error'),
  },
  // One row per (agent, remote): re-recording an orphan updates the attempt
  // rather than piling up a row per retry.
  (t) => [uniqueIndex('recall_orphans_agent_remote_idx').on(t.agentId, t.remoteId)],
);

// Cron-scheduled prompts fired into the agent by the wrapper. The agent can
// self-manage these via the built-in `heartbeat` tool.
export const heartbeats = sqliteTable('heartbeats', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // Standard 5-field cron: `min hour dom month dow`.
  cron: text('cron').notNull(),
  prompt: text('prompt').notNull(),
  // Audience for the fired turn: 'main' = the agent/console session (today's
  // behavior — reaches Telegram only if the agent calls send-telegram --chat);
  // 'chat' = a specific Telegram chat (delivers there, runs in that chat's
  // session under sessionScope='chat'). 'all' (broadcast) is reserved.
  targetType: text('target_type').notNull().default('main'),
  // Telegram chat.id when targetType = 'chat'.
  targetChatId: text('target_chat_id'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// The run ledger. Backs three things at once: the rolling run budget's count,
// the *reservation* that makes that budget correct when several triggers fire
// at once, and the recent-runs view for local and deployed agents.
//
// The full transcript stays on disk at .helm/agents/<id>/logs/<runId>.ndjson;
// this is the index over it. A run id is a uuid and carries no timestamp, so
// without this table "runs in the last hour" would mean statting every log file.
export const runs = sqliteTable(
  'runs',
  {
    // Identical to the runId and therefore to the .ndjson filename.
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // 'chat' | 'heartbeat:<id>' | 'telegram:<chatId>' | 'manual' — matches the
    // `source` already written to the ndjson helm_meta line.
    source: text('source').notNull(),
    // Which conversation the turn ran in: SHARED_SESSION_KEY ('shared') for the
    // agent/console session, or a gateways_chat.id under sessionScope='chat'.
    // `source` alone cannot say — a telegram turn's scope depends on the agent
    // setting *at the time it ran*. Null = pre-migration row, treated as shared.
    // This is what lets the console replay exactly the turns Claude remembers.
    sessionKey: text('session_key'),
    // 'queued'   reserved by reserveRun, not yet started
    // 'running'  turn in flight
    // 'ok' | 'error'
    // 'refused'  never ran (budget / paused / deployed)
    // 'interrupted' the turn stopped before a result: the process died mid-run
    //               (boot sweep) or the caller aborted it (browser refresh/Stop)
    // NOTE: 'refused' and 'interrupted' rows are excluded from the budget count
    // — counting refusals would keep the window permanently full.
    status: text('status').notNull(),
    // 'budget' | 'paused' | 'deployed' | 'transferring' when status='refused'.
    refusedReason: text('refused_reason'),
    // Both truncated (see RUN_TEXT_LIMIT) — the ndjson holds the full text.
    prompt: text('prompt').notNull(),
    resultText: text('result_text'),
    exitCode: integer('exit_code'),
    isError: integer('is_error', { mode: 'boolean' }),
    // The harness fingerprint of this run's `system/init` event; null when the
    // CLI died before emitting one (a bad flag, a missing binary).
    harness: text('harness', { mode: 'json' }).$type<HarnessFingerprint>(),
    startedAt: integer('started_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    endedAt: integer('ended_at', { mode: 'timestamp' }),
  },
  // The budget query is `where agent_id = ? and started_at > ?` on every single
  // run admission, so it gets a covering index.
  (t) => [index('runs_agent_started_idx').on(t.agentId, t.startedAt)],
);

// Daemon-scoped key/value state that outlives the process but belongs to no
// row. Today one key: 'daemon.paused'. The kill switch must survive a systemd
// restart or it isn't a kill switch — an in-memory flag would silently lift
// itself on the crash-loop it was meant to stop.
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  // JSON-encoded.
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Tool = typeof tools.$inferSelect;
export type AgentTool = typeof agentTools.$inferSelect;
export type McpServer = typeof mcpServers.$inferSelect;
export type AgentMcpServer = typeof agentMcpServers.$inferSelect;
export type Gateway = typeof gateways.$inferSelect;
export type GatewayChat = typeof gatewaysChat.$inferSelect;
export type Heartbeat = typeof heartbeats.$inferSelect;
export type Remote = typeof remotes.$inferSelect;
export type RecallOrphan = typeof recallOrphans.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Setting = typeof settings.$inferSelect;
