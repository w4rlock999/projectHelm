import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { agentMcpServers, mcpServers, type McpServer } from '../../db/schema.ts';
import { syncAgentTools } from '../tools.ts';
import {
  effectiveRequires,
  McpServerError,
  redactMcpConfig,
  resolveRedacted,
  type McpServerConfig,
  type McpServerInput,
  type RedactedMcpServerConfig,
  type Runtime,
} from './mcp-schema.ts';

// The MCP server library: CRUD and per-agent assignment, mirroring the tool
// library in tools.ts. Every mutation re-renders the affected agents' harness
// (mcp.json + CLAUDE.md) through syncAgentTools, the single re-materialize
// hook. The import between this module and tools.ts is circular on purpose
// and only ever used inside functions, never at module load.

// ── CRUD ────────────────────────────────────────────────────────────────────

export function listMcpServers(): McpServer[] {
  return db.select().from(mcpServers).all();
}

export function getMcpServer(id: string): McpServer | null {
  return db.select().from(mcpServers).where(eq(mcpServers.id, id)).get() ?? null;
}

export function getMcpServerByName(name: string): McpServer | null {
  return db.select().from(mcpServers).where(eq(mcpServers.name, name)).get() ?? null;
}

export function createMcpServer(input: McpServerInput): McpServer {
  if (getMcpServerByName(input.name)) {
    throw new McpServerError(`an MCP server named "${input.name}" already exists`);
  }
  // A create carries no stored config to resolve a marker against.
  const config = resolveRedacted(input.config, null);
  const now = new Date();
  const row: McpServer = {
    id: randomUUID(),
    name: input.name,
    description: input.description,
    config,
    requires: effectiveRequires(config, input.requires),
    createdAt: now,
    updatedAt: now,
  };
  db.insert(mcpServers).values(row).run();
  return row;
}

export interface McpServerPatch {
  name?: string;
  description?: string;
  /** A full config; `REDACTED` values keep what is stored for that key. */
  config?: McpServerConfig;
  requires?: Runtime[];
}

export function updateMcpServer(id: string, patch: McpServerPatch): McpServer | null {
  const existing = getMcpServer(id);
  if (!existing) return null;
  if (patch.name !== undefined && patch.name !== existing.name && getMcpServerByName(patch.name)) {
    throw new McpServerError(`an MCP server named "${patch.name}" already exists`);
  }
  const config =
    patch.config === undefined ? existing.config : resolveRedacted(patch.config, existing.config);
  const requires = effectiveRequires(config, patch.requires ?? existing.requires);
  db.update(mcpServers)
    .set({
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      config,
      requires,
      updatedAt: new Date(),
    })
    .where(eq(mcpServers.id, id))
    .run();
  // Shared: every agent that has it renders a new mcp.json.
  for (const agentId of agentsUsingMcpServer(id)) syncAgentTools(agentId);
  return getMcpServer(id);
}

export function deleteMcpServer(id: string): boolean {
  if (!getMcpServer(id)) return false;
  // Capture assignees before the FK cascade clears the join.
  const affected = agentsUsingMcpServer(id);
  db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
  for (const agentId of affected) syncAgentTools(agentId);
  return true;
}

// ── Assignments ─────────────────────────────────────────────────────────────

export function listAgentMcpServerIds(agentId: string): string[] {
  return db
    .select({ id: agentMcpServers.mcpServerId })
    .from(agentMcpServers)
    .where(eq(agentMcpServers.agentId, agentId))
    .all()
    .map((r) => r.id);
}

/** Library servers assigned to an agent, sorted by name (mcp.json key order). */
export function listAgentMcpServers(agentId: string): McpServer[] {
  const ids = listAgentMcpServerIds(agentId);
  if (ids.length === 0) return [];
  return db
    .select()
    .from(mcpServers)
    .where(inArray(mcpServers.id, ids))
    .all()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function agentsUsingMcpServer(serverId: string): string[] {
  return db
    .select({ agentId: agentMcpServers.agentId })
    .from(agentMcpServers)
    .where(eq(agentMcpServers.mcpServerId, serverId))
    .all()
    .map((r) => r.agentId);
}

export function assignMcpServer(agentId: string, serverId: string): void {
  db.insert(agentMcpServers)
    .values({ agentId, mcpServerId: serverId, createdAt: new Date() })
    .onConflictDoNothing()
    .run();
  syncAgentTools(agentId);
}

export function unassignMcpServer(agentId: string, serverId: string): void {
  db.delete(agentMcpServers)
    .where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, serverId)))
    .run();
  syncAgentTools(agentId);
}

/** Union of the runtimes every server assigned to the agent needs. */
export function requiredRuntimesForAgent(agentId: string): Runtime[] {
  const set = new Set<Runtime>();
  for (const s of listAgentMcpServers(agentId)) for (const r of s.requires) set.add(r);
  return [...set].sort();
}

// ── Read shapes ─────────────────────────────────────────────────────────────

export interface McpServerView {
  id: string;
  name: string;
  description: string;
  transport: McpServerConfig['transport'];
  config: RedactedMcpServerConfig;
  requires: Runtime[];
  createdAt: Date;
  updatedAt: Date;
}

/** What every API, CLI and UI surface sees: never an env or header value. */
export function redactMcpServer(s: McpServer): McpServerView {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    transport: s.config.transport,
    config: redactMcpConfig(s.config),
    requires: s.requires,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}
