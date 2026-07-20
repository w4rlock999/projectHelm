// Version constants asserted at every seam between a local helm and a remote
// daemon (handshake, and — from M-remote-2 — the agent bundle format). Bump
// HELM_VERSION on releases; bump BUNDLE_FORMAT_VERSION only when the ship/
// recall bundle layout changes incompatibly.
export const HELM_VERSION = '0.1.0';
export const BUNDLE_FORMAT_VERSION = 1;
