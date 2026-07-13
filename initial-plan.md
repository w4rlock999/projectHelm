# projectHelm v0 — Local Agent Factory

## Context

projectHelm wraps off-the-shelf CLI coding agents (Claude Code only in v0) into self-deployable, steered "business agents" connected to real-world channels. v0 establishes the local foundation for two of the three pillars — **local install** and **agent factory + monitoring** — while making architectural choices that keep **helmship** (M4 cloud deploy) cheap to add later.

The defining design move: **projectHelm is itself operated by a wrapped agent.** Rather than the GUI calling backend APIs directly, GUI features submit intents to a steered Claude Code instance — the "operator agent" — which performs the work using slash commands that wrap the daemon's HTTP API. This dogfoods the wrapping model and dramatically lowers the barrier of entry: chat instead of click.

The repo is currently empty; this is a greenfield v0 build.

## Stack

- **TanStack Start** — full-stack React on Node; server functions (= daemon HTTP API) + GUI in one codebase
- **shadcn/ui (Base UI variant)** — UI primitives
- **Node.js ≥20** — runtime; required for spawning Claude Code child processes
- **better-sqlite3 + drizzle ORM** — embedded persistence (agents, connections, runs, encrypted secrets)
- **node-pty** — spawn Claude Code attached to a pseudo-terminal so the GUI can render its TUI
- **xterm.js** — embed the pty output in the browser
- **node-cron** — scheduled agent runs
- **commander** (or citty) — the `helm` CLI
- **dockerode** (or shell to `docker`/`podman`) — container-mode runner

MCP is intentionally out of scope per user direction.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  helm-daemon (single Node process, TanStack Start server)   │
│  ├── HTTP API on 127.0.0.1:5555 (server functions)          │
│  ├── Web GUI (React SPA) served at same port                │
│  ├── SQLite at ~/.projecthelm/db.sqlite                     │
│  ├── Telegram polling loop (one per connection)            │
│  ├── Cron scheduler                                         │
│  └── Agent process manager                                  │
│      ├── operator-agent (always-on, wrapped Claude Code)    │
│      └── user-agents/*  (spawned on demand, local OR ctr)   │
└─────────────────────────────────────────────────────────────┘
       ▲                  ▲                       ▲
       │ HTTP             │ HTTP / pty stream     │ pty (local) or
       │                  │                       │ docker exec/logs (ctr)
       │                  │                       │
   helm CLI           Web GUI                Claude Code instances
```

Daemon is the single source of truth. CLI, GUI, webhook traffic all funnel through its HTTP API. Agent execution sits behind an `AgentRunner` interface with two implementations.

## Agent execution modes (both shipped in v0)

| Mode              | Mechanism                                                                                                                                         | Helmship-ready                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Local-machine** | Claude Code spawned as child via `node-pty`, bound to `~/.projecthelm/agents/<name>/workspace`, allowed-tools list from agent config              | No (host-bound)                       |
| **Containered**   | Per-agent OCI image built from a templated Dockerfile (base: Node + Claude Code + agent files); run via Docker/Podman with workspace volume mount | Yes (same image ships to cloud in M4) |

`AgentRunner` interface keeps the daemon agnostic. On agent creation the user picks a mode. Container mode requires a detected runtime; if absent, the GUI prompts the user to install Docker Desktop / Podman / Colima.

## Operator agent (the meta-feature)

A wrapped Claude Code instance scaffolded at `~/.projecthelm/operator/` on first daemon start. It is:

- Steered by a curated `CLAUDE.md` describing projectHelm and the operator's role
- Equipped with `.claude/commands/` slash commands like `/agent-new`, `/agent-list`, `/connection-add`, `/agent-logs`. Each shells out to the local `helm` CLI, which calls the daemon HTTP API.
- Always running as a managed child of the daemon, attached to a pty
- Exposed in the GUI as the primary surface — an embedded panel attached to the operator's pty

GUI features work by sending natural-language intents to the operator. Clicking "Create new agent" opens a form whose submit dispatches `operator.send("Create a new agent named '$name' that …")`. The operator's slash commands and steering ensure deterministic execution.

Implication: the operator agent IS the backend for the GUI. The daemon's HTTP API is effectively private — only `helm` CLI and the operator's slash commands hit it directly. Adding a new feature = adding a new operator skill/slash command + (optional) GUI affordance.

**Fallback for reliability:** the GUI can bypass the operator and hit the daemon directly for deterministic CRUD when the operator fails / times out, so basic platform actions never depend on an LLM round-trip.

## Agent factory features (per user list)

1. **CLI agent setup** — Claude Code only in v0. Daemon checks `claude` on PATH; missing → GUI walks the user through `npm install -g @anthropic-ai/claude-code` and login.
2. **Steering** — each agent has `agents/<name>/CLAUDE.md`, `.claude/commands/`, optional `skills/`. Editable in GUI or on disk.
3. **Claude Code plugin marketplace** — pass-through in v0: agents inherit Claude Code's native plugin mechanism (its own `~/.claude` config). GUI exposes a link to the marketplace; deeper "browse + install per-agent" integration is v1.
4. **Custom tooling** — user can drop scripts in `agents/<name>/tools/` and reference them from slash commands or CLAUDE.md.
5. **Messaging app interfacing** — Telegram (see below).

## Telegram connection integration (v0)

- User creates a bot via BotFather, pastes token into the GUI
- Daemon stores the token encrypted in SQLite
- Daemon spawns a long-poll loop (`getUpdates`) per connection — chosen over webhooks because local v0 has no public URL; webhooks land naturally in M4 with helmship
- Inbound message → daemon enqueues a run on the routed agent → agent processes → daemon posts reply via `sendMessage`
- Routing is 1:1 (one bot → one agent) in v0
- Background cron agents work via the same pipeline: cron triggers a run, agent can `sendMessage` as one of its tools

## Filesystem layout

```
~/.projecthelm/
  config.toml
  db.sqlite
  secrets.enc            encrypted tokens / API keys
  daemon.pid
  operator/
    CLAUDE.md
    .claude/commands/
    workspace/
  agents/<name>/
    meta.json            mode, connections, schedule, allowed-tools
    CLAUDE.md
    .claude/commands/
    tools/
    workspace/
    logs/
  images/                Dockerfiles + image refs for container mode
  logs/                  daemon logs
```

## CLI surface (v0)

- `helm start | stop | restart | status` — daemon lifecycle
- `helm ui` — open the GUI in browser
- `helm agent new <name> [--mode local|container]`
- `helm agent ls`
- `helm agent rm <name>`
- `helm agent run <name>` — one-shot run
- `helm agent logs <name> [-f]`
- `helm connection add telegram --agent <name>`
- `helm connection ls`
- `helm uninstall`

`helm ship` is reserved; not implemented in v0.

## Install paths (v0)

- Primary: `npm install -g @projecthelm/cli`
  - Installs the CLI; first `helm start` scaffolds `~/.projecthelm/` and opens the GUI's first-run wizard
  - Requires Node ≥20 already installed
- Secondary: `curl https://get.projecthelm.io | sh`
  - Wrapper that detects/installs Node if missing, then runs the npm install

Detected dependencies on first start:

- `claude` CLI — required; GUI walks user through install + login if missing
- `docker` or `podman` — optional; required only for container-mode agents; absence flagged in GUI

## Work breakdown (v0 milestones)

**v0.1 — Skeleton.** TanStack Start project + shadcn setup + basic layout. `helm` CLI with `start`/`stop`/`status` talking to the daemon HTTP. SQLite + drizzle, schema for `agents` / `connections` / `runs`. Daemon lifecycle (PID file + supervisor).

**v0.2 — Local-mode agents.** Spawn Claude Code via node-pty. `LocalProcessRunner` with workspace dir + env scoping. Agent CRUD via CLI and GUI. Embedded xterm.js terminal in GUI streaming pty output.

**v0.3 — Operator agent.** Scaffold `operator/` on first daemon start with the curated CLAUDE.md + slash commands. GUI "chat with projectHelm" panel wired to the operator pty. Route the "Create agent" form through the operator. Keep the direct-daemon fallback path for deterministic CRUD.

**v0.4 — Container-mode agents.** Dockerfile template generator. `ContainerRunner` (build image, run with workspace mount, stream logs). Runtime detection (Docker → Podman → Colima → unavailable). Mode selectable per-agent in GUI.

**v0.5 — Telegram connection.** Bot token entry + encrypted storage. Polling loop. Inbound message → agent run → reply pipeline. Connection↔agent routing in GUI.

**v0.6 — Polish + install path.** `npm install -g` end-to-end. `curl | sh` wrapper. Clean uninstall. First-run wizard. README + smoke-test script.

## Verification

End-to-end smoke test per milestone:

- **v0.1** — `helm start` boots daemon; GUI loads at localhost:5555; `helm status` returns running
- **v0.2** — Create agent via CLI, run it, see Claude Code TUI rendered in browser, edit CLAUDE.md, re-run, observe behavioral change
- **v0.3** — In the operator panel: "create me an agent that answers haikus." Operator scaffolds it; new agent runs and responds in-character
- **v0.4** — Same agent, switched to container mode → image builds, agent runs in container, workspace persists across runs
- **v0.5** — Hook a Telegram bot, send a message → routed agent replies on Telegram; cron-scheduled agent posts on schedule
- **v0.6** — `npm uninstall -g` then reinstall on a clean machine produces a working install with no manual cleanup

## Key open questions to revisit during build

1. **xterm.js vs structured chat UI for the operator panel.** xterm.js is fastest and shows the real TUI faithfully; a structured chat UI is more polished but needs ANSI stripping + intent parsing. Recommend xterm.js for v0, structured UI for v1.
2. **Secret encryption key derivation.** OS keychain (preferred) vs user-supplied passphrase. Defer to v0.5 when secrets actually start flowing.
3. **Operator agent reliability ceiling.** Every LLM-mediated action adds latency and non-determinism. The fallback path (GUI → daemon direct) hedges this for deterministic CRUD; revisit after v0.3 with real usage data.
4. **Container-mode "Claude login" propagation.** Claude Code's auth lives on the host; agents in containers need access to it (volume mount of `~/.claude/`?) or their own login. Decide during v0.4.
5. **Polling cadence + rate limits for Telegram.** Long-poll with 30s timeout is the standard pattern; verify it doesn't trip Telegram's rate limits with multiple agents.
