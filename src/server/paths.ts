import path from 'node:path'

const helmRoot = path.resolve(process.cwd(), '.helm')

export const paths = {
  helmRoot,
  dbFile: path.join(helmRoot, 'db.sqlite'),
  agentsDir: path.join(helmRoot, 'agents'),
  agentDir: (id: string) => path.join(helmRoot, 'agents', id),
  agentWorkspaceDir: (id: string) => path.join(helmRoot, 'agents', id, 'workspace'),
  agentClaudeMd: (id: string) => path.join(helmRoot, 'agents', id, 'workspace', 'CLAUDE.md'),
  agentLogsDir: (id: string) => path.join(helmRoot, 'agents', id, 'logs'),
  agentLogFile: (id: string, runId: string) =>
    path.join(helmRoot, 'agents', id, 'logs', `${runId}.ndjson`),
}
