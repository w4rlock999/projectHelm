import path from 'node:path'

const helmRoot = path.resolve(process.cwd(), '.helm')

export const paths = {
  helmRoot,
  dbFile: path.join(helmRoot, 'db.sqlite'),
  agentsDir: path.join(helmRoot, 'agents'),
  agentDir: (id: string) => path.join(helmRoot, 'agents', id),
  agentWorkspaceDir: (id: string) => path.join(helmRoot, 'agents', id, 'workspace'),
  agentToolsDir: (id: string) => path.join(helmRoot, 'agents', id, 'workspace', 'tools'),
  agentClaudeMd: (id: string) => path.join(helmRoot, 'agents', id, 'workspace', 'CLAUDE.md'),
  agentLogsDir: (id: string) => path.join(helmRoot, 'agents', id, 'logs'),
  agentLogFile: (id: string, runId: string) =>
    path.join(helmRoot, 'agents', id, 'logs', `${runId}.ndjson`),

  // ── Durable data plane (never wiped, unlike workspace/) ──────────────────
  // `data/store` is the agent store (the agent's shared durable store, across all
  // its sessions); `data/sessions/<key>` is the per-conversation session store
  // (key = gateways_chat.id under sessionScope='chat', or the literal 'shared'
  // otherwise). The *.db paths are reserved for the daemon-mediated SQLite access
  // layer (a later increment); this pass only creates the directories.
  agentDataDir: (id: string) => path.join(helmRoot, 'agents', id, 'data'),
  agentStoreDir: (id: string) => path.join(helmRoot, 'agents', id, 'data', 'store'),
  agentStoreArtifactsDir: (id: string) =>
    path.join(helmRoot, 'agents', id, 'data', 'store', 'artifacts'),
  agentStoreDbFile: (id: string) => path.join(helmRoot, 'agents', id, 'data', 'store', 'store.db'),
  agentSessionsDir: (id: string) => path.join(helmRoot, 'agents', id, 'data', 'sessions'),
  agentSessionStoreDir: (id: string, key: string) =>
    path.join(helmRoot, 'agents', id, 'data', 'sessions', key),
  agentSessionStoreArtifactsDir: (id: string, key: string) =>
    path.join(helmRoot, 'agents', id, 'data', 'sessions', key, 'artifacts'),
  agentSessionStoreDbFile: (id: string, key: string) =>
    path.join(helmRoot, 'agents', id, 'data', 'sessions', key, 'store.db'),
}
