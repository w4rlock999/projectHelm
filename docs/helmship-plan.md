# Helmship — remote deployment plan

_Drafted 2026-07-13. Status: agreed direction; M-remote-1 is the next build target._

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
  `Authorization: Bearer <token>`. Enforcement points:
  - tRPC: check in `src/server/trpc/context.ts` (throw `UNAUTHORIZED`).
  - REST file routes: a `requireRemoteAuth(request)` helper in
    `src/server/api-route.ts`, called at the top of each handler.
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
  agent's assigned library tools. Import upserts into the remote library by
  name + content hash; a name collision with different source fails the import
  (explicit, no silent overwrite).
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
3. Local: export bundle → `POST /api/remote/import` (multipart, through the
   tunnel).
4. Remote: validate manifest, import inside one transaction, materialize
   workspace, start poller + schedule heartbeats, run a smoke turn
   (`claude -p ping` in the agent workspace), respond OK.
5. Local: mark the agent deployed — new column `agents.deployedTo`
   (nullable text, remote id). The heartbeat scheduler and
   `reconcileGateways()` skip agents with `deployedTo` set; runs against them
   are rejected.
6. Any failure in 3–4 → local reactivates (rollback), surfaces the error.

`recall` is the same flow in reverse (remote exports + deactivates, local
imports + reactivates, remote deletes on confirmation).

### Deployed-agent visibility

v1 of proxying is deliberately thin: the agent detail page for a deployed
agent shows remote status, heartbeat list, and a recent-runs/log tail fetched
through the tunnel (`GET /api/remote/agents/:id/status` on the daemon).
Full management of a deployed agent = recall it, edit, re-ship. Deep
proxy-editing is a later milestone if it earns its keep.

### Run budget / kill switch (pulled forward — ships with M2)

An unattended heartbeat agent on a VPS can burn the whole Claude subscription
overnight; this failure mode arrives with remote deploy, so the guard does too:

- `agents.runBudgetPerHour` (nullable int) — enforced centrally in
  `src/server/run.ts` for all run sources (heartbeat, gateway, console);
  exceeded → run refused + logged, heartbeat stays scheduled.
- Daemon-wide pause: `POST /api/remote/pause` / `resume` (and a console
  button) — stops accepting new runs without killing the process.

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
- Should `ship --without-data` be the default for agents with large stores?
  (Currently: data travels by default.)
- Provisioning skill distribution: repo-cloned vs curl-able bundle vs npm
  package. Decide when M3 starts.
- Does the remote keep serving the console SPA (handy through the tunnel) or
  ship a stripped headless build? (Currently: serve it, auth-gated.)
