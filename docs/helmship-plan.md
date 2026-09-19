# Helmship — remote deployment plan

_Drafted 2026-07-13. Status: **M-remote-2 implemented** (2026-08-24); M-remote-3 is the next
build target. Not yet exercised against a real VPS end to end._

Helmship lets you take an agent built locally in HelmConsole and deploy it to a
"remote deployment environment" — a VPS running the helm daemon headlessly —
so its heartbeats fire and its Telegram gateways poll 24/7, without your laptop.

## Decisions already made

| Decision            | Choice                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote architecture | The remote is a **full autonomous helm daemon** (own SQLite, cron scheduler, gateway pollers, `.helm/` tree), not a thin executor. Local helm is a client of it.                                                       |
| Transport (v1)      | Remote API is **token-authenticated HTTP bound to `127.0.0.1`**, reached over an **SSH tunnel** from local. No public ports, no TLS to manage. A future `--public` HTTPS mode changes only the transport, not the API. |
| Deploy semantics    | **Move / ownership transfer.** An agent lives in exactly one place. `ship` deactivates it locally; `recall` reverses. No copy/sync — avoids Telegram poller conflicts and self-mutation drift.                         |
| VPS install         | **Bare metal, agent-led.** Claude Code is installed first (it's the runtime anyway), then a provisioning skill drives deterministic, idempotent install scripts. No Docker requirement in v1.                          |
| Harness support     | Claude Code only for now, but the remote **advertises capabilities** (`harnesses: [...]`) in the handshake so other harnesses slot in later.                                                                           |

## Principles

- **One codebase, two modes.** The remote is this same TanStack Start server
  with a headless flag — not a separate program. Anything the remote can do,
  local can do.
- **The API key never touches the open internet.** Auth exists from day one
  (bearer token on every request in headless mode), but v1 exposure is only
  through the SSH tunnel.
- **Deterministic core, intelligent shell.** Provisioning and shipping are
  scripted, versioned, idempotent steps; Claude (the provisioning skill,
  helmCaptain) sequences and recovers, it does not improvise the steps.
- **Version everything at the seam.** The handshake and the bundle format both
  carry versions from the first release; skew fails loudly, not mysteriously.

---

## M-remote-1 (v1): headless daemon + pairing

Goal: a VPS runs the helm daemon headlessly; the local console can register it
as a remote, see its status, and talk to its API over an SSH tunnel. No agent
shipping yet.

### 1. Headless mode

- Activated by env: `HELM_HEADLESS=1` (read once at boot into a
  `src/server/config.ts` helper alongside `HELM_PORT`, default `5555`).
- **Eager runtime boot.** Today `ensureRuntimeStarted()`
  (`src/server/runtime/index.ts`) runs lazily on the first tRPC/REST request —
  a headless daemon that receives no traffic would never start its pollers or
  cron. In headless mode the server entry calls it at process start.
- Binds `127.0.0.1` only. The console SPA is still served (usable through the
  tunnel later), but every data endpoint is auth-gated (below).
- Runs the production build (`pnpm build` output) under a systemd unit;
  `helm-remote.service` template lives in the repo. Env (`HELM_HEADLESS`,
  `HELM_PORT`, `CLAUDE_CODE_OAUTH_TOKEN`) comes from `.helm/remote.env`
  (chmod 600), referenced by the unit via `EnvironmentFile=`.

### 2. Auth (headless mode only)

- Pairing token: `helm_rt_` + 32 random bytes (base58). Generated at init,
  **shown once**; only its SHA-256 hash is stored in `.helm/remote.json`
  (`{ tokenHash, createdAt, helmVersion }`).
- Every `/api/trpc/*` and `/api/*` request must carry
  `Authorization: Bearer <token>`. Enforcement point (decided during
  implementation, superseding per-handler checks): the **custom server entry**
  `src/server.ts` — every request in dev/preview/prod flows through its fetch
  handler, so one check covers tRPC + all REST routes + anything added later.
  SPA assets are served before the entry and stay reachable.
- A second token is accepted alongside the pairing token: a per-process
  **internal token** (`HELM_INTERNAL_TOKEN`, never persisted) injected into
  spawned agents so their materialized tool scripts (helm/heartbeat/
  send-telegram) can call back into the daemon.
- Local (non-headless) mode is unchanged — no token required.
- Rotation: re-running init with `--rotate` issues a new token and invalidates
  the old hash. No multi-token/scoping in v1.

### 3. `remote init` (on the VPS)

A script (exposed as `pnpm remote:init`; later folded into a real `helm` CLI):

1. Preflight: Node ≥ 20, `claude` on PATH, writable `.helm/`.
2. Prompt for `CLAUDE_CODE_OAUTH_TOKEN` (or accept via env), write
   `.helm/remote.env`.
3. Smoke test the harness: run `claude -p "ping"` with the token; fail init if
   it fails.
4. `pnpm db:migrate`.
5. Generate the pairing token, write `.helm/remote.json`.
6. Install + start the systemd unit (skippable with `--no-service`).
7. Print a one-line **connect code**:
   `helm-connect:` + base64url of
   `{ v: 1, sshUser, host, sshPort, helmPort, token }` — pasteable into the
   local console as a single field (the form also accepts the fields
   individually).

### 4. Local side: remotes registry + tunnel

- New table in the local DB (`src/db/schema.ts`):

  ```
  remotes: id, name, sshTarget ('user@host[:port]'), helmPort,
           token (plaintext v1 — same posture as gateways.token, encrypt-at-rest is a later milestone),
           lastSeenAt, lastVersion, capabilities (JSON), createdAt
  ```

- New tRPC router `remotes` (registered in `src/server/trpc/routers/_app.ts`):
  `add` (accepts connect code or fields, performs first handshake before
  saving), `list`, `remove`, `ping`.
- **Tunnel manager** (`src/server/remotes/tunnel.ts`): spawns the system
  `ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L <ephemeralLocalPort>:127.0.0.1:<helmPort> <sshTarget>`.
  Using system ssh (not a JS ssh lib) means the user's `~/.ssh/config`, keys,
  and agent all just work, and we ship no native deps. Tunnels are opened
  on demand per operation, kept alive ~60s idle, then torn down. Failures
  surface as remote status, with backoff on retry.
- **Handshake endpoint** on the daemon: `GET /api/remote/info` →

  ```json
  {
    "helmVersion": "0.x.y",
    "headless": true,
    "harnesses": [{ "type": "claude-code", "version": "2.x", "authOk": true }],
    "agentCount": 3,
    "uptimeSec": 12345
  }
  ```

  `ping` refreshes `lastSeenAt` / `lastVersion` / `capabilities` from it.
  Local warns on major/minor version mismatch with itself.

### 5. Console UI

- A **Remotes** section (dashboard card or `/remotes` route): add-remote form
  (paste connect code), list with status dot (reachable / unreachable / auth
  failed), helm + harness versions, agent count, remove.
- helmCaptain: extend the built-in `helm` tool with `remote add|ls|rm|ping`
  so the captain can manage remotes conversationally (same dogfooding as the
  rest of the fleet).

### 6. Acceptance criteria

- Fresh Ubuntu VPS: `remote init` completes, systemd unit survives reboot,
  pollers/cron start with zero inbound requests.
- Requests without a bearer token get 401 in headless mode; local mode
  unaffected.
- Local console adds the remote via connect code over SSH, shows green status
  and capabilities; kill the daemon → status goes red with a useful error.
- Version + bundle-format constants exist and are asserted in the handshake.

---

## M-remote-2: ship & recall

Goal: `ship` transfers an agent to a remote and activates it there; `recall`
brings it home. Local console keeps visibility of deployed agents.

### Bundle format (v1)

A tarball, `manifest.json` + payload dirs:

- `manifest.json`: `bundleVersion: 1`, source `helmVersion`, exported-at,
  agent id/name, content list, `requires: { harness: 'claude-code' }`.
- **Agent row** — minus `claudeSessionId`, which is **nulled on export**:
  Claude Code sessions live under `~/.claude` on the source machine and cannot
  resume elsewhere. Shipped agents start fresh sessions; continuity comes from
  the data plane (which travels). Same nulling applies to
  `gateways_chat.claude_session_id`.
- **Tools**: full definitions (name, description, interpreter, source) of the
  agent's assigned library tools. Import is **insert-or-reuse-or-fail** by
  name + content hash — _not_ an upsert (corrected during implementation:
  updating a shared library tool re-materializes every other agent using it, so
  an upsert would let a bundle silently rewrite unrelated agents). A name
  collision with different source fails; so does an ambiguous name, since
  `tools.name` has no unique index. The content hash is recomputed on import,
  never trusted from the bundle.
- **Gateways** rows incl. bot token and `pollOffset` (so the remote poller
  continues the getUpdates cursor), plus `gateways_chat` rows (chat routing,
  titles, status).
- **Heartbeats** rows.
- **Data plane**: `data/` tree (agent store + session stores) included by
  default, `--without-data` to skip.
- **Workspace**: loose files the agent created are tarred along; `CLAUDE.md`
  and `workspace/tools/` are **re-materialized on import** by the remote
  (`src/server/tools.ts` rendering), not trusted from the bundle.

### Ship flow (ownership transfer, ordered)

1. Local: preflight — remote reachable, version + capability check, agent not
   mid-run.
2. Local: **deactivate** — stop the agent's gateway poller, unschedule its
   heartbeats (poller conflict window must close before remote activation).
3. Local: export bundle → `POST /api/remote/import` (raw `application/octet-stream`
   through the tunnel, with `content-length` and `x-helm-bundle-sha256` headers).
   **Corrected during implementation:** multipart needs a parser we don't ship,
   and `Request.formData()` buffers the whole bundle in memory, defeating every
   size cap on a small VPS.
4. Remote: validate manifest, import inside one transaction, materialize
   workspace, start poller + schedule heartbeats, run a smoke turn
   (`claude -p ping` in the agent workspace), respond OK.
5. Local: mark the agent deployed.
6. Any failure in 3–4 → local reactivates (rollback), surfaces the error.

**Corrected during implementation — steps 0 and 7 below replace 5 and 6:**

0. The durable claim happens **first**, before deactivation: one conditional
   `UPDATE agents SET deployState='shipping' WHERE deployState IS NULL`, which is
   simultaneously the mutex, the run-gate close, and the crash marker. With the
   flag written at step 5 instead, a crash anywhere in 2–4 restarts with the
   agent fully live locally while the remote may also be live — two pollers on
   one bot token, duplicate replies to everything.
1. Rollback is only safe in two of three cases. Failure before the remote
   committed, or an explicit `{ok:false}` (the remote self-rolls-back before
   answering, so it is provably clean) → reactivate. But if the connection died
   **after** the remote committed and before its response arrived, the outcome is
   unknown, and reactivating is precisely the move that creates the
   double-poller. That case probes the remote with backoff and, failing that,
   marks the agent `'stranded'` for an operator decision.

State lives in `agents.deployState` (`'shipping' | 'deployed' | 'recalling' |
'stranded'`, null = locally live) plus `deployedTo` / `deployedAt` /
`deployError`. The heartbeat tick, `reconcileGateways()` and the run gate all
filter on it.

`recall` is the same flow in reverse (remote exports + deactivates, local
imports + reactivates, remote deletes on confirmation).

### Deployed-agent visibility

v1 of proxying is deliberately thin: the agent detail page for a deployed
agent shows remote status, heartbeat list, and recent runs fetched through the
tunnel (`GET /api/remote/agents/:id/status` on the daemon). Recall needs a
matching `POST /api/remote/agents/:id/export` — missing from the original
endpoint list, and without it `recall` has no wire. Note a freshly shipped
agent's run list is empty until its first remote run, since logs don't travel.
Full management of a deployed agent = recall it, edit, re-ship. Deep
proxy-editing is a later milestone if it earns its keep.

### Run budget / kill switch (pulled forward — ships with M2)

An unattended heartbeat agent on a VPS can burn the whole Claude subscription
overnight; this failure mode arrives with remote deploy, so the guard does too:

- `agents.runBudgetPerHour` (nullable int) — enforced centrally in
  `src/server/runs.ts` for all run sources (heartbeat, gateway, console);
  exceeded → run refused + logged, heartbeat stays scheduled. The window is
  **rolling**, not a clock-hour reset: a reset satisfies "2 runs/hour" while
  permitting 2 at :59 and 2 at :00, which is the burst being guarded against.
  Admission _reserves_ a slot rather than merely checking, or a batch of
  simultaneous triggers would all pass one check. Refused and interrupted rows
  are excluded from the count, or the window would stay permanently full.
- Daemon-wide pause: `POST /api/remote/pause` / `resume` (and a console
  button) — stops accepting new runs without killing the process. **Persisted**,
  not in-memory: systemd restarts the unit on failure, so an in-process flag
  would lift itself during the crash-loop it was meant to stop.
- Pause is unprivileged, resume is not. Every spawned agent holds
  `HELM_INTERNAL_TOKEN`, so without splitting the principals an agent paused for
  burning budget could simply un-pause itself.

### Acceptance criteria

- Ship a Telegram + heartbeat agent to a VPS: messages flow within one poll
  interval, no duplicate replies during the handoff, heartbeats fire on
  schedule, agent store contents readable by the remote agent.
- Local console shows it as deployed; local pollers/cron provably skip it.
- Recall restores full local operation; Telegram continues from the cursor.
- Failed import (kill the remote mid-ship) leaves the agent running locally.
- Budget: an agent with `runBudgetPerHour=2` and a `* * * * *` heartbeat gets
  exactly 2 runs/hour.

---

## M-remote-3: agent-led provisioning skill

Goal: the VPS setup story is "install Claude Code, run the skill." Claude
absorbs OS variance; the steps stay deterministic.

- Repo dir `provision/` containing:
  - The skill definition (`SKILL.md`): role, step sequence, recovery guidance,
    hard rule — _run the provided scripts; do not invent install commands_.
  - Idempotent scripts, each with machine-readable pass/fail output:
    `check-os.sh`, `install-node.sh`, `install-pnpm.sh`, `fetch-helm.sh`
    (git clone/pull + `pnpm install` + build), `remote-init.sh` (wraps
    M1's `pnpm remote:init`), `verify.sh`.
- `verify.sh` is the contract: daemon up on localhost, authed
  `/api/remote/info` returns `authOk: true` for claude-code, DB migrated,
  systemd unit enabled. The skill reports the checklist; **only a passing
  verify prints the connect code.**
- The agent's value-add: distro detection, choosing the right script path,
  diagnosing failures (missing build tools, node version conflicts, systemd
  absent → print manual fallback), re-running idempotently.
- Distribution (open): start with `git clone` + invoking the skill; graduate
  to a `curl`-able bundle / `npx helm-provision` once stable.
- Acceptance: fresh Ubuntu 24.04 and Debian 12 VPSes provision to a green
  verify with no manual intervention beyond pasting the OAuth token.

---

## M-remote-4+: later / hardening

Explicitly out of v1, in rough priority order:

1. **Secrets at rest** — encrypt `gateways.token`, `remotes.token`, and the
   remote's stored hash-adjacent material; OS keychain locally, key file on
   the VPS. (Bundle already avoids logging tokens; this closes storage.)
2. **Per-agent container runner** — the `AgentRunner` seam from
   `initial-plan.md`; blast-radius isolation between agents on a shared VPS.
3. **`--public` HTTPS mode** — domain + auto-TLS (Caddy or built-in ACME) for
   inbound traffic; unlocks **Telegram webhooks** (better than long-poll once
   there's a public URL) and a path to hosted helmship.
4. **Deep proxy management** — edit prompt/tools/heartbeats of a deployed
   agent from the local console without recalling it.
5. **Multi-harness** — agents declare a required harness; ship validates
   against the remote's advertised capabilities; adapters beyond
   `adapter/claude.ts`.
6. **Multi-remote fleet view** — one dashboard aggregating agents across all
   remotes.

## Open questions

- Connect-code ergonomics: is pasting one opaque string better than three
  fields, or should the console offer both from day one? (Currently: both.)
- ~~Should `ship --without-data` be the default for agents with large stores?~~
  **Settled in M-remote-2: no.** Ship is a move, so excluding the data plane by
  default would make silent data loss the behaviour of the headline feature —
  and since sessions can't travel, the data plane is the only continuity a
  shipped agent has. `--without-data` stays an explicit opt-out.

## Known gaps after M-remote-2

- **Not yet exercised against a real VPS.** Export/import is covered by a
  round-trip test against a real SQLite database, and the endpoints' guards are
  verified live, but no bundle has crossed an actual SSH tunnel. The acceptance
  criteria above still need a run against real hardware.
- The tunneled console SPA still 401s: the browser tRPC client sends no
  `Authorization` header, so a remote daemon's own UI is unusable even though it
  is served. Administering a remote means the local console, the `helm` CLI, or
  curl.
- No `remote:init --reauth`: an expired `CLAUDE_CODE_OAUTH_TOKEN` on the VPS is
  _detected_ (`authOk: false`, and ship preflight refuses on it) but recovering
  still means editing `.helm/remote.env` and restarting the unit by hand.
  (Currently: data travels by default.)
- Provisioning skill distribution: repo-cloned vs curl-able bundle vs npm
  package. Decide when M3 starts.
- Does the remote keep serving the console SPA (handy through the tunnel) or
  ship a stripped headless build? (Currently: serve it, auth-gated.)

---

## Harness ownership (H0 → H2)

_Drafted 2026-09-19. Status: **H0 implemented**; H1 and H2 are the next build targets._

Helm never owned the Claude Code harness. The adapter spawned `claude -p` with
`--allowedTools` and `--model` and inherited everything else from the host's
`~/.claude` — user settings (effort), skills, plugins, `~/.claude.json` MCP
servers, even the auto-memory directory. Measured for the same agent on the
laptop and the Hetzner daemon: claude 2.1.277 vs 2.1.270, effort high vs unset,
26 vs 17 skills, 3 vs 0 plugins, and auto-memory landing in the developer's own
`~/.claude/projects/…/memory/`. Ship preflight never looked at any of it.

### Decisions

| Decision           | Choice                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership          | The harness is explicit per-agent data helm renders deterministically on whichever machine runs the agent, travels in the bundle like tools do, and is fingerprinted from `system.init` so skew is visible.            |
| Isolation (H1)     | No per-agent "inherit host" escape hatch; helmCaptain is isolated too. Spawn with `--setting-sources project`, `--settings`, `--strict-mcp-config --mcp-config`, `--plugin-dir`, and explicit `--effort` etc.          |
| CLI version policy | **major.minor equality** between local and remote at ship preflight; patch drift is a warning. `DISABLE_AUTOUPDATER=1` on the VPS; `pnpm remote:init --claude <v>` moves the pin.                                      |
| Library kinds (H2) | MCP servers, skills, plugins — the same insert-or-reuse-or-fail import rule as tools.                                                                                                                                  |
| Out of scope       | Per-agent `CLAUDE_CONFIG_DIR` (would move memory/sessions into helm-owned space, but a relocated config dir breaks macOS keychain auth; needs a helm-held `setup-token` credential on both sides — a later milestone). |

### H0 — observe (shipped)

- Every turn's `system/init` event becomes a **harness fingerprint**
  (`src/server/harness/fingerprint.ts`): CLI version, resolved model,
  permission mode, tools, skills, plugins, MCP servers with status. Names and
  statuses only, never config. Stored on `runs.harness` and
  `agents.last_harness`; returned by the remote's import smoke turn as
  `harnessFingerprint`.
- A CLI that dies parsing its argv emits no `result` event; the run ledger used
  to record that as `ok`. Now a non-zero exit with no result is an error and
  carries the stderr tail, and the import smoke turn checks the exit code too.
- `/api/remote/info` gains optional `helmBuild` (git short sha — two `0.1.0`
  daemons were three commits apart while ping stayed green), `schemaVersion`,
  and `harnesses[].runtimes` (node/python3/npx/uvx) for H2's preflight.
- Ship preflight refuses when local and remote `claude` differ in major.minor
  (or a side has no version); ping's warning names both helm and claude skew;
  the Remotes card shows badges.
- The import route marks the agent **in flight** until the smoke turn settles
  and its status route answers 202 meanwhile; the shipper's ambiguous-outcome
  probe waits on 202 instead of committing `deployed` against an agent the
  remote is about to roll back.
- Headless boot runs drizzle's migrator, so `git pull && pnpm build && systemctl
restart` cannot leave the daemon 500-ing its own handshake on a missing column.
- `remote:init` writes `DISABLE_AUTOUPDATER=1`, records the CLI version, and
  gains `--claude-version <v>` (fresh init) and `--claude <v>` (move the pin).

### H1 — own and isolate (next)

Per-agent `agents.harness` profile (effort, permission mode, max turns,
fallback model) plus fleet defaults in `settings`; rendered to
`.helm/agents/<id>/harness/{settings.json,mcp.json}` and `workspace/.claude/`
right before each spawn, inside the per-agent run chain; adapter argv gains the
isolation flags. The exporter excludes `workspace/.claude/**`, `.mcp.json` and
`CLAUDE.local.md`, and the importer strips them — an agent-authored
`.claude/settings.json` must never travel or load. Bundle format bumps to 2 with
a strict agent schema and the _effective_ profile snapshotted at export.

### H2 — library and travel (after H1)

Library tables `skills`, `plugins`, `mcp_servers` with join tables mirroring
`agent_tools`; trees on disk under `.helm/library/<kind>/<uuid>/` with a tree
hash verified before every render and export; bundle format 3 carries
`library/**`; import generalizes `resolveToolImports`; preflight checks
runtimes; the post-import fingerprint must show every declared MCP server
`connected` and every declared skill/plugin present, or the remote self-rolls-back.
