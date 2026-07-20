#!/usr/bin/env node
'use strict';
// Built-in tool: schedule recurring prompts to the agent itself.
// Materialized verbatim into each agent's workspace/tools/heartbeat.
// AGENT_ID and BASE come from the environment the daemon spawns the agent with.
const AGENT_ID = process.env.HELM_AGENT_ID;
const BASE = process.env.HELM_BASE_URL || 'http://localhost:3000';
// Set by the daemon in headless mode; the /api surface requires auth there.
const TOKEN = process.env.HELM_INTERNAL_TOKEN || '';
const argv = process.argv.slice(2);
const cmd = argv[0];

function flags(args) {
  const out = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.indexOf('--') === 0) {
      const k = a.slice(2);
      const v = i + 1 < args.length && args[i + 1].indexOf('--') !== 0 ? args[++i] : 'true';
      out[k] = v;
    } else pos.push(a);
  }
  return { out, pos };
}

async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
  const res = await fetch(BASE + '/api/agents/' + AGENT_ID + path, {
    method: method,
    headers: headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('error ' + res.status + ': ' + text);
    process.exit(1);
  }
  return text ? JSON.parse(text) : null;
}

(async function () {
  if (cmd === 'list' || !cmd) {
    const hb = await api('GET', '/heartbeats');
    console.log(JSON.stringify(hb, null, 2));
  } else if (cmd === 'add') {
    const f = flags(argv.slice(1)).out;
    if (!f.cron || !f.prompt) {
      console.error(
        'usage: heartbeat add --cron "<expr>" --prompt "<text>" [--name "<name>"] [--target main|chat] [--chat <id>]',
      );
      process.exit(1);
    }
    if (f.target === 'chat' && !f.chat) {
      console.error('--target chat requires --chat <id>');
      process.exit(1);
    }
    const body = { cron: f.cron, prompt: f.prompt, name: f.name };
    if (f.target) body.targetType = f.target;
    if (f.chat) body.targetChatId = f.chat;
    const r = await api('POST', '/heartbeats', body);
    console.log('created heartbeat ' + r.id);
  } else if (cmd === 'update') {
    const id = argv[1];
    const f = flags(argv.slice(2)).out;
    const patch = {};
    if (f.cron) patch.cron = f.cron;
    if (f.prompt) patch.prompt = f.prompt;
    if (f.name) patch.name = f.name;
    if (f.enabled !== undefined) patch.enabled = f.enabled === 'true';
    if (f.target) patch.targetType = f.target;
    if (f.chat) patch.targetChatId = f.chat;
    await api('PATCH', '/heartbeats/' + id, patch);
    console.log('updated ' + id);
  } else if (cmd === 'rm') {
    await api('DELETE', '/heartbeats/' + argv[1]);
    console.log('removed ' + argv[1]);
  } else if (cmd === 'enable' || cmd === 'disable') {
    await api('PATCH', '/heartbeats/' + argv[1], { enabled: cmd === 'enable' });
    console.log(cmd + 'd ' + argv[1]);
  } else {
    console.error('unknown command: ' + cmd);
    process.exit(1);
  }
})().catch(function (e) {
  console.error(String(e));
  process.exit(1);
});
