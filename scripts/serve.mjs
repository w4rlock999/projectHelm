#!/usr/bin/env node
// Production launcher for the helm daemon: `pnpm build` first, then
// `pnpm serve` (the systemd unit runs exactly this). The built server bundle
// only exports a fetch handler — this script binds it to a real socket.
//
// Importing the bundle at module top level runs the server entry's eager
// runtime boot (src/server.ts), so heartbeats + gateway pollers start even if
// no request ever arrives. Binds 127.0.0.1 only: the daemon is reached over
// an SSH tunnel, never the open internet (docs/helmship-plan.md).
import { fileURLToPath } from 'node:url';
import { serve } from 'srvx';
import { serveStatic } from 'srvx/static';
import entry from '../dist/server/server.js';

const port = Number(process.env.HELM_PORT ?? 5555);
const clientDir = fileURLToPath(new URL('../dist/client', import.meta.url));

serve({
  port,
  hostname: '127.0.0.1',
  // Static assets first (serveStatic only handles files that exist, so /api/*
  // falls through to the entry); everything else hits the Start fetch handler.
  middleware: [serveStatic({ dir: clientDir })],
  fetch: entry.fetch,
});

console.log(`[helm] daemon listening on http://127.0.0.1:${port}`);
