// Version constants asserted at every seam between a local helm and a remote
// daemon (handshake, and — from M-remote-2 — the agent bundle format). Bump
// HELM_VERSION on releases; bump BUNDLE_FORMAT_VERSION only when the ship/
// recall bundle layout changes incompatibly.
export const HELM_VERSION = '0.1.0';
// v2 (harness H1): strict agent schema carrying the effective harness profile;
// the workspace's `.claude/**`, `.mcp.json` and `CLAUDE.local.md` never travel.
// v3 (harness H2): db.json carries the agent's MCP servers and their joins;
// the manifest's `requires.runtimes` names what the receiver must have on PATH.
export const BUNDLE_FORMAT_VERSION = 3;

// The git short sha the running build was made from, injected by Vite's
// `define` (see vite.config.ts). Two daemons at the same HELM_VERSION can still
// be different code — the laptop and the VPS were three commits apart while
// both reported 0.1.0 and ping stayed green — so the handshake carries this as
// a hint next to the version. The `typeof` guard is load-bearing: the define
// only exists under Vite, and scripts/remote-init.ts imports this file under tsx.
declare const __HELM_BUILD__: string | undefined;
export const HELM_BUILD: string =
  typeof __HELM_BUILD__ !== 'undefined' ? __HELM_BUILD__ : (process.env.HELM_BUILD ?? 'dev');
