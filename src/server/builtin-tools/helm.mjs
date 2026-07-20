#!/usr/bin/env node
// Built-in operator tool: the helm CLI to inspect and manage the fleet.
// Materialized into the operator agent's workspace/tools/helm. Talks to the
// daemon's REST endpoints; fleet ops need no agent id, only BASE (from env).
// Runs as an ES module (the repo's package.json has "type":"module"), so use
// a static import for fs rather than require().
import { readFileSync } from 'node:fs';
const BASE = process.env.HELM_BASE_URL || 'http://localhost:3000';
// Set by the daemon in headless mode; the /api surface requires auth there.
const TOKEN = process.env.HELM_INTERNAL_TOKEN || '';
const argv = process.argv.slice(2);
const cmd = argv[0];
const sub = argv[1];

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
  return { out: out, pos: pos };
}

// Resolve --<key> inline, or --<key>-file <path> (preferred for multi-line text).
function readArg(f, key) {
  if (f[key] !== undefined) return f[key];
  if (f[key + '-file'] !== undefined) return readFileSync(f[key + '-file'], 'utf8');
  return undefined;
}

async function call(method, path, body) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
  const res = await fetch(BASE + path, {
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
function get(path) {
  return call('GET', path);
}

function out(v) {
  console.log(JSON.stringify(v, null, 2));
}

function usage() {
  console.log(
    'helm — manage helmConsole\n' +
      'read:\n' +
      '  helm context\n' +
      '  helm agent ls\n' +
      '  helm agent get <id>\n' +
      '  helm tool ls\n' +
      '  helm remote ls\n' +
      '  helm remote ping <id>\n' +
      'write:\n' +
      '  helm agent new --name <n> --prompt|--prompt-file <p> [--model <m>]\n' +
      '  helm agent set-prompt <id> --prompt|--prompt-file <p>\n' +
      '  helm agent rm <id>\n' +
      '  helm tool author --name <n> --desc <d> --interp <bash|node|python3> --source|--source-file <s> [--assign <agentId>]\n' +
      '  helm tool set <id> [--desc <d>] [--source|--source-file <s>] [--interp <i>]\n' +
      '  helm tool rm <id>\n' +
      '  helm tool assign <toolId> --agent <agentId>\n' +
      '  helm tool unassign <toolId> --agent <agentId>\n' +
      '  helm remote add --code <helm-connect:...> [--name <n>]\n' +
      '  helm remote add --ssh <user@host[:port]> --token <t> [--port <helmPort>] [--name <n>]\n' +
      '  helm remote rm <id>',
  );
}

(async function () {
  if (!cmd || cmd === 'help' || cmd === '--help') {
    usage();
    return;
  }

  if (cmd === 'context') {
    out({ agents: await get('/api/agents/list'), library: await get('/api/tools') });
  } else if (cmd === 'agent') {
    if (sub === 'ls') {
      out(await get('/api/agents/list'));
    } else if (sub === 'get') {
      if (!argv[2]) {
        console.error('usage: helm agent get <id>');
        process.exit(1);
      }
      out(await get('/api/agents/' + argv[2] + '/info'));
    } else if (sub === 'new') {
      const f = flags(argv.slice(2)).out;
      const prompt = readArg(f, 'prompt');
      if (!f.name || !prompt) {
        console.error('usage: helm agent new --name <n> --prompt|--prompt-file <p> [--model <m>]');
        process.exit(1);
      }
      const r = await call('POST', '/api/agents/create', {
        name: f.name,
        systemPrompt: prompt,
        model: f.model,
      });
      console.log('created agent ' + r.id);
    } else if (sub === 'set-prompt') {
      const id = argv[2];
      const f = flags(argv.slice(3)).out;
      const prompt = readArg(f, 'prompt');
      if (!id || !prompt) {
        console.error('usage: helm agent set-prompt <id> --prompt|--prompt-file <p>');
        process.exit(1);
      }
      await call('PATCH', '/api/agents/' + id + '/info', { systemPrompt: prompt });
      console.log('updated prompt for ' + id);
    } else if (sub === 'rm') {
      if (!argv[2]) {
        console.error('usage: helm agent rm <id>');
        process.exit(1);
      }
      await call('DELETE', '/api/agents/' + argv[2] + '/info');
      console.log('removed agent ' + argv[2]);
    } else {
      console.error('unknown: helm agent ' + (sub || ''));
      process.exit(1);
    }
  } else if (cmd === 'tool') {
    if (sub === 'ls') {
      out(await get('/api/tools'));
    } else if (sub === 'author') {
      const f = flags(argv.slice(2)).out;
      const source = readArg(f, 'source');
      if (!f.name || !f.desc || !source) {
        console.error(
          'usage: helm tool author --name <n> --desc <d> --interp <i> --source|--source-file <s> [--assign <agentId>]',
        );
        process.exit(1);
      }
      const body = {
        name: f.name,
        description: f.desc,
        interpreter: f.interp || 'bash',
        source: source,
      };
      if (f.assign) body.assignTo = [f.assign];
      const r = await call('POST', '/api/tools', body);
      console.log('authored tool ' + r.id + (f.assign ? ' (assigned to ' + f.assign + ')' : ''));
    } else if (sub === 'set') {
      const id = argv[2];
      const f = flags(argv.slice(3)).out;
      if (!id) {
        console.error(
          'usage: helm tool set <id> [--desc <d>] [--source|--source-file <s>] [--interp <i>]',
        );
        process.exit(1);
      }
      const patch = {};
      if (f.name) patch.name = f.name;
      if (f.desc) patch.description = f.desc;
      if (f.interp) patch.interpreter = f.interp;
      const source = readArg(f, 'source');
      if (source !== undefined) patch.source = source;
      await call('PATCH', '/api/tools/' + id, patch);
      console.log('updated tool ' + id);
    } else if (sub === 'rm') {
      if (!argv[2]) {
        console.error('usage: helm tool rm <id>');
        process.exit(1);
      }
      await call('DELETE', '/api/tools/' + argv[2]);
      console.log('removed tool ' + argv[2]);
    } else if (sub === 'assign' || sub === 'unassign') {
      const toolId = argv[2];
      const f = flags(argv.slice(3)).out;
      if (!toolId || !f.agent) {
        console.error('usage: helm tool ' + sub + ' <toolId> --agent <agentId>');
        process.exit(1);
      }
      if (sub === 'assign') {
        await call('POST', '/api/agents/' + f.agent + '/tools', { toolId: toolId });
        console.log('assigned ' + toolId + ' to ' + f.agent);
      } else {
        await call('DELETE', '/api/agents/' + f.agent + '/tools/' + toolId);
        console.log('unassigned ' + toolId + ' from ' + f.agent);
      }
    } else {
      console.error('unknown: helm tool ' + (sub || ''));
      process.exit(1);
    }
  } else if (cmd === 'remote') {
    if (sub === 'ls') {
      out(await get('/api/remotes'));
    } else if (sub === 'add') {
      const f = flags(argv.slice(2)).out;
      const body = {};
      if (f.code) {
        body.connectCode = f.code;
      } else if (f.ssh && f.token) {
        body.sshTarget = f.ssh;
        body.token = f.token;
        if (f.port) body.helmPort = Number(f.port);
      } else {
        console.error(
          'usage: helm remote add --code <helm-connect:...> [--name <n>]\n' +
            '       helm remote add --ssh <user@host[:port]> --token <t> [--port <helmPort>] [--name <n>]',
        );
        process.exit(1);
      }
      if (f.name) body.name = f.name;
      const r = await call('POST', '/api/remotes', body);
      console.log('added remote ' + r.remote.id + ' (' + r.remote.name + ')');
      out(r.info);
    } else if (sub === 'ping') {
      if (!argv[2]) {
        console.error('usage: helm remote ping <id>');
        process.exit(1);
      }
      out(await call('POST', '/api/remotes/' + argv[2] + '/ping'));
    } else if (sub === 'rm') {
      if (!argv[2]) {
        console.error('usage: helm remote rm <id>');
        process.exit(1);
      }
      await call('DELETE', '/api/remotes/' + argv[2]);
      console.log('removed remote ' + argv[2]);
    } else {
      console.error('unknown: helm remote ' + (sub || ''));
      process.exit(1);
    }
  } else {
    console.error('unknown command: ' + cmd);
    usage();
    process.exit(1);
  }
})().catch(function (e) {
  console.error(String(e));
  process.exit(1);
});
