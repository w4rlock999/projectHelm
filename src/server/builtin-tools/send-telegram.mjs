#!/usr/bin/env node
'use strict';
// Built-in tool: the agent's voice on Telegram. Materialized into
// workspace/tools/send-telegram only when the agent has a gateway.
// AGENT_ID and BASE come from the environment the daemon spawns the agent with;
// HELM_CHAT_ID (when present) is the chat the current turn belongs to.
const AGENT_ID = process.env.HELM_AGENT_ID;
const BASE = process.env.HELM_BASE_URL || 'http://localhost:3000';
// Set by the daemon in headless mode; the /api surface requires auth there.
const TOKEN = process.env.HELM_INTERNAL_TOKEN || '';

// Parse an optional --chat <id>; everything else joins into the message text.
const argv = process.argv.slice(2);
let chatId = process.env.HELM_CHAT_ID || undefined;
const parts = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--chat') {
    chatId = argv[++i];
    continue;
  }
  parts.push(argv[i]);
}
const text = parts.join(' ').trim();
if (!text) {
  console.error('usage: send-telegram [--chat <id>] "<message>"');
  process.exit(1);
}

(async function () {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
  const res = await fetch(BASE + '/api/agents/' + AGENT_ID + '/messages', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ text: text, chatId: chatId }),
  });
  const t = await res.text();
  if (!res.ok) {
    console.error('send failed ' + res.status + ': ' + t);
    process.exit(1);
  }
  console.log('sent');
})().catch(function (e) {
  console.error(String(e));
  process.exit(1);
});
