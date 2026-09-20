import path from 'node:path';

const helmRoot = path.resolve(process.cwd(), '.helm');

// The session-store key for the agent-scope / console / 'main'-heartbeat
// session (i.e. anything not isolated to a specific chat). Lives here — the
// leaf module both agents.ts and runtime/gateways.ts already import — so the
// two can't drift and neither needs a circular import to share it.
export const SHARED_SESSION_KEY = 'shared';

export const paths = {
  helmRoot,
  dbFile: path.join(helmRoot, 'db.sqlite'),
  // Headless-daemon pairing state (written by `pnpm remote:init`): the pairing
  // token's hash + metadata, and the systemd EnvironmentFile.
  remoteJson: path.join(helmRoot, 'remote.json'),
  remoteEnv: path.join(helmRoot, 'remote.env'),
  // ── Transfer scratch (helmship M-remote-2) ───────────────────────────────
  // Everything here lives under .helm/ deliberately: staging hardlinks into a
  // bundle and installing an import with a single renameSync both require the
  // same filesystem as .helm/agents. /tmp is a separate volume on macOS and
  // often a tmpfs on a systemd VPS, so it cannot be used.
  //
  // Created 0700 and files 0600: a bundle contains gateways.token in plaintext.
  tmpDir: path.join(helmRoot, 'tmp'),
  bundlesDir: path.join(helmRoot, 'tmp', 'bundles'),
  /** A bundle being written for upload. */
  bundleFile: (id: string) => path.join(helmRoot, 'tmp', 'bundles', `${id}.helm.tgz`),
  /** A bundle being spooled off the wire, before it is trusted. */
  incomingBundle: (id: string) => path.join(helmRoot, 'tmp', 'incoming', `${id}.tgz`),
  /** Mirror tree assembled by export, then handed to `tar`. */
  bundleStageDir: (id: string) => path.join(helmRoot, 'tmp', `stage-${id}`),
  /** Untrusted extraction target. Nothing here is trusted until it is walked. */
  bundleQuarantineDir: (id: string) => path.join(helmRoot, 'tmp', `import-${id}`),

  // ── Machine parity (P0) ──────────────────────────────────────────────────
  // Logs of what helm ran on a machine: provision steps, upgrades, operator
  // exec notes. `remoteId` is the remotes row id, or 'local' for this machine.
  remoteOpsDir: (remoteId: string) => path.join(helmRoot, 'remotes', remoteId, 'ops'),
  remoteOpLog: (remoteId: string, opId: string) =>
    path.join(helmRoot, 'remotes', remoteId, 'ops', `${opId}.log`),

  agentsDir: path.join(helmRoot, 'agents'),
  agentDir: (id: string) => path.join(helmRoot, 'agents', id),
  agentWorkspaceDir: (id: string) => path.join(helmRoot, 'agents', id, 'workspace'),
  agentToolsDir: (id: string) => path.join(helmRoot, 'agents', id, 'workspace', 'tools'),
  agentClaudeMd: (id: string) => path.join(helmRoot, 'agents', id, 'workspace', 'CLAUDE.md'),
  // ── Harness (harness ownership H1) ───────────────────────────────────────
  // Helm-owned, outside the agent's cwd: what `--settings`, `--mcp-config` and
  // `--plugin-dir` point at. Rendered by harness/render.ts before every spawn.
  agentHarnessDir: (id: string) => path.join(helmRoot, 'agents', id, 'harness'),
  agentHarnessSettings: (id: string) =>
    path.join(helmRoot, 'agents', id, 'harness', 'settings.json'),
  agentHarnessMcp: (id: string) => path.join(helmRoot, 'agents', id, 'harness', 'mcp.json'),
  agentHarnessPluginsDir: (id: string) => path.join(helmRoot, 'agents', id, 'harness', 'plugins'),
  // The *project* setting source inside the agent-writable workspace — wiped
  // and rebuilt on every render, never trusted from a bundle.
  agentDotClaudeDir: (id: string) => path.join(helmRoot, 'agents', id, 'workspace', '.claude'),
  agentSkillsDir: (id: string) =>
    path.join(helmRoot, 'agents', id, 'workspace', '.claude', 'skills'),
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
};
