#!/usr/bin/env node
// Built-in operator tool: the helm CLI to inspect and manage the fleet.
// Materialized into the operator agent's workspace/tools/helm. Talks to the
// daemon's REST endpoints; fleet ops need no agent id, only BASE (from env).
// Runs as an ES module (the repo's package.json has "type":"module"), so use
// a static import for fs rather than require().
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const BASE = process.env.HELM_BASE_URL || 'http://localhost:3000';
// Set by the daemon in headless mode; the /api surface requires auth there.
const TOKEN = process.env.HELM_INTERNAL_TOKEN || '';
const argv = process.argv.slice(2);
const cmd = argv[0];
const sub = argv[1];

// `multi` names flags that may repeat (`--arg a --arg b`); those come back as
// arrays, always, even when given once or not at all. Everything else is
// last-wins, as before.
function flags(args, multi) {
  const out = {};
  const pos = [];
  const many = new Set(multi || []);
  for (const k of many) out[k] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.indexOf('--') === 0) {
      const k = a.slice(2);
      const v = i + 1 < args.length && args[i + 1].indexOf('--') !== 0 ? args[++i] : 'true';
      if (many.has(k)) out[k].push(v);
      else out[k] = v;
    } else pos.push(a);
  }
  return { out: out, pos: pos };
}

// `K=V` pairs (from repeated --env / --header) into an object. A bare `K=<set>`
// keeps the value already stored for that key on `helm mcp set`.
function kvPairs(list, what) {
  const out = {};
  for (const item of list) {
    const eq = item.indexOf('=');
    if (eq <= 0) {
      console.error('--' + what + ' expects KEY=VALUE, got: ' + item);
      process.exit(1);
    }
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

// Build an MCP server config from `--stdio <runtime> [--arg …] [--env K=V]` or
// `--http <url> [--header K=V]`. Returns undefined when neither was given.
function mcpConfig(f) {
  if (f.stdio && f.http) {
    console.error('give either --stdio <runtime> or --http <url>, not both');
    process.exit(1);
  }
  if (f.stdio) {
    return { transport: 'stdio', command: f.stdio, args: f.arg, env: kvPairs(f.env, 'env') };
  }
  if (f.http) {
    return { transport: 'http', url: f.http, headers: kvPairs(f.header, 'header') };
  }
  return undefined;
}
const MCP_MULTI = ['arg', 'env', 'header'];

// Resolve --<key> inline, or --<key>-file <path> (preferred for multi-line text).
function readArg(f, key) {
  if (f[key] !== undefined) return f[key];
  if (f[key + '-file'] !== undefined) return readFileSync(f[key + '-file'], 'utf8');
  return undefined;
}

async function call(method, path, body) {
  const headers = {};
  // `null` is a real body here (clearing a harness profile), so test for
  // undefined rather than truthiness.
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
  const res = await fetch(BASE + path, {
    method: method,
    headers: headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

// Poll a transfer to completion. A ship takes minutes, so this is opt-in
// (--wait); the default is fire-and-report-once so the captain isn't blocked
// inside a single Bash call.
async function watchTransfer(agentId) {
  let lastPhase = '';
  for (let i = 0; i < 600; i++) {
    const s = await get('/api/agents/' + agentId + '/ship');
    const t = s.transfer;
    if (t && t.phase !== lastPhase) {
      lastPhase = t.phase;
      const last = t.log[t.log.length - 1];
      console.log('  ' + t.phase + (last ? ' — ' + last.message : ''));
    }
    if (t && t.outcome) {
      out(t.outcome);
      if (!t.outcome.ok) process.exit(1);
      return;
    }
    await new Promise(function (r) {
      setTimeout(r, 2000);
    });
  }
  console.error('gave up waiting after 20 minutes; poll with: helm agent status ' + agentId);
  process.exit(1);
}

function usage() {
  console.log(
    'helm — manage helmConsole\n' +
      'read:\n' +
      '  helm context\n' +
      '  helm agent ls\n' +
      '  helm agent get <id>\n' +
      '  helm tool ls\n' +
      '  helm mcp ls | helm mcp get <id>\n' +
      '  helm remote ls | helm remote get <id>\n' +
      '  helm remote ping <id>\n' +
      '  helm remote check <id> [--agent <agentId>] [--json]   # is the remote configured like this machine?\n' +
      '  helm remote ops <id> [--limit <n>]                    # what helm ran there\n' +
      '  helm agent runs <id> [--limit <n>]\n' +
      '  helm system status\n' +
      '  helm agent status <id>            # deploy state + transfer progress\n' +
      'write:\n' +
      '  helm agent new --name <n> --prompt|--prompt-file <p> [--model <m>]\n' +
      '  helm agent set-prompt <id> --prompt|--prompt-file <p>\n' +
      '  helm agent rm <id>\n' +
      '  helm tool author --name <n> --desc <d> --interp <bash|node|python3> --source|--source-file <s> [--assign <agentId>]\n' +
      '  helm tool set <id> [--desc <d>] [--source|--source-file <s>] [--interp <i>]\n' +
      '  helm tool rm <id>\n' +
      '  helm tool assign <toolId> --agent <agentId>\n' +
      '  helm tool unassign <toolId> --agent <agentId>\n' +
      '  helm mcp add --name <n> --desc <d> --stdio <node|npx|python3|uvx> [--arg <a>]... [--env K=V]... [--requires <r,...>] [--assign <agentId>]\n' +
      '  helm mcp add --name <n> --desc <d> --http <url> [--header K=V]... [--assign <agentId>]\n' +
      '  helm mcp set <id> [--name <n>] [--desc <d>] [--stdio … | --http …] [--requires <r,...>]   # K=<set> keeps a stored secret\n' +
      '  helm mcp rm <id>\n' +
      '  helm mcp assign <serverId> --agent <agentId>\n' +
      '  helm mcp unassign <serverId> --agent <agentId>\n' +
      '  helm remote add --code <helm-connect:...> [--name <n>] [--identity <keyfile>]\n' +
      '  helm remote add --ssh <user@host[:port]> --token <t> [--port <helmPort>] [--name <n>] [--identity <keyfile>]\n' +
      '  helm remote set <id> [--name <n>] [--identity <keyfile> | --no-identity]\n' +
      '  helm remote rm <id>\n' +
      '  helm remote pause <id> [--reason <r>] | helm remote resume <id>\n' +
      '  helm agent budget <id> --per-hour <n|off>\n' +
      '  helm agent ship <id> --remote <remoteId> [--without-data] [--wait]\n' +
      '  helm agent recall <id> [--wait]\n' +
      '  helm system pause [--reason <r>]   # resume needs the operator, not an agent\n' +
      'harness (how Claude Code is spawned for an agent):\n' +
      '  helm agent harness <id>            # own profile, effective profile, last observed harness\n' +
      '  helm agent harness <id> [--effort <low|medium|high|xhigh|max|off>] [--max-turns <n|off>]\n' +
      '                          [--permission-mode <default|acceptEdits|dontAsk|off>] [--fallback-model <m|off>]\n' +
      '  helm agent harness <id> --clear    # back to the fleet defaults\n' +
      '  helm harness defaults              # the fleet defaults every agent inherits\n' +
      '  helm harness defaults [--effort …] [--max-turns …] [--permission-mode …] [--fallback-model …]\n' +
      'operator terminal only (runs ssh from this process with your keys; not for fleet agents):\n' +
      '  helm remote exec <id> -- <command…>   # run a command on the remote over its saved login',
  );
}

// `helm remote check` prints the report as a table unless --json. Exit 1 when
// any row failed, so a script (or an agent) can gate a ship on it.
function printReport(report) {
  console.log(
    (report.ok ? 'OK   ' : 'FAIL ') +
      (report.remoteName || report.remoteId) +
      ' — checked ' +
      new Date(report.checkedAt).toISOString(),
  );
  const width = (k) => Math.max(...report.rows.map((r) => String(r[k] ?? '').length), 1);
  const w = { area: width('area'), name: width('name'), expected: width('expected') };
  const pad = (v, n) => String(v ?? '').padEnd(n);
  for (const r of report.rows) {
    console.log(
      '  ' +
        pad(r.status.toUpperCase(), 4) +
        ' ' +
        pad(r.area, w.area) +
        ' ' +
        pad(r.name, w.name) +
        ' ' +
        pad(r.expected ?? '-', w.expected) +
        ' → ' +
        (r.actual ?? '-') +
        (r.fix ? '\n       fix: ' + r.fix : ''),
    );
  }
}

// ssh argv for `helm remote exec`, built here (this file has no repo imports)
// and kept in step with sshBaseArgs in src/server/machine/transport.ts.
function sshArgsFor(remote) {
  const m = /^(.+):(\d+)$/.exec(remote.sshTarget);
  const destination = m ? m[1] : remote.sshTarget;
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (remote.sshIdentityFile) args.push('-i', remote.sshIdentityFile, '-o', 'IdentitiesOnly=yes');
  if (m) args.push('-p', m[2]);
  args.push('--', destination);
  return args;
}

// Translate `--effort high --max-turns off` into a profile patch: a value sets
// the field, `off` clears it (null), an absent flag leaves it alone. Shared by
// the per-agent and fleet-default commands.
function profilePatch(f) {
  const patch = {};
  const fields = {
    effort: 'effort',
    'max-turns': 'maxTurns',
    'permission-mode': 'permissionMode',
    'fallback-model': 'fallbackModel',
  };
  for (const flag in fields) {
    if (f[flag] === undefined) continue;
    const key = fields[flag];
    if (f[flag] === 'off') {
      patch[key] = null;
    } else if (key === 'maxTurns') {
      const n = Number(f[flag]);
      if (!Number.isInteger(n) || n < 1) {
        console.error('--max-turns must be a positive integer, or "off"');
        process.exit(1);
      }
      patch[key] = n;
    } else {
      patch[key] = f[flag];
    }
  }
  return patch;
}

(async function () {
  if (!cmd || cmd === 'help' || cmd === '--help') {
    usage();
    return;
  }

  if (cmd === 'context') {
    out({
      agents: await get('/api/agents/list'),
      library: await get('/api/tools'),
      mcp: await get('/api/mcp'),
    });
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
    } else if (sub === 'runs') {
      if (!argv[2]) {
        console.error('usage: helm agent runs <id> [--limit <n>]');
        process.exit(1);
      }
      const f = flags(argv.slice(3)).out;
      const q = f.limit ? '?limit=' + encodeURIComponent(f.limit) : '';
      out(await get('/api/agents/' + argv[2] + '/runs' + q));
    } else if (sub === 'ship') {
      const f = flags(argv.slice(3)).out;
      if (!argv[2] || !f.remote) {
        console.error('usage: helm agent ship <id> --remote <remoteId> [--without-data] [--wait]');
        process.exit(1);
      }
      const started = await call('POST', '/api/agents/' + argv[2] + '/ship', {
        remoteId: f.remote,
        withoutData: f['without-data'] === 'true',
      });
      console.log('ship started (' + started.transferId + ')');
      if (f.wait) await watchTransfer(argv[2]);
      else out(await get('/api/agents/' + argv[2] + '/ship'));
    } else if (sub === 'recall') {
      if (!argv[2]) {
        console.error('usage: helm agent recall <id> [--wait]');
        process.exit(1);
      }
      const f = flags(argv.slice(3)).out;
      const started = await call('POST', '/api/agents/' + argv[2] + '/ship', { recall: true });
      console.log('recall started (' + started.transferId + ')');
      if (f.wait) await watchTransfer(argv[2]);
      else out(await get('/api/agents/' + argv[2] + '/ship'));
    } else if (sub === 'status') {
      if (!argv[2]) {
        console.error('usage: helm agent status <id>');
        process.exit(1);
      }
      out(await get('/api/agents/' + argv[2] + '/ship'));
    } else if (sub === 'budget') {
      const f = flags(argv.slice(3)).out;
      if (!argv[2] || !f['per-hour']) {
        console.error('usage: helm agent budget <id> --per-hour <n|off>');
        process.exit(1);
      }
      const value = f['per-hour'] === 'off' ? null : Number(f['per-hour']);
      if (value !== null && (!Number.isInteger(value) || value < 1)) {
        console.error('--per-hour must be a positive integer, or "off"');
        process.exit(1);
      }
      out(await call('PATCH', '/api/agents/' + argv[2] + '/info', { runBudgetPerHour: value }));
    } else if (sub === 'harness') {
      if (!argv[2]) {
        console.error('usage: helm agent harness <id> [--effort …] [--max-turns …] [--clear]');
        process.exit(1);
      }
      const f = flags(argv.slice(3)).out;
      if (f.clear === 'true') {
        out(await call('PATCH', '/api/agents/' + argv[2] + '/harness', null));
      } else {
        const patch = profilePatch(f);
        if (Object.keys(patch).length === 0) {
          out(await get('/api/agents/' + argv[2] + '/harness'));
        } else {
          out(await call('PATCH', '/api/agents/' + argv[2] + '/harness', patch));
        }
      }
    } else {
      console.error('unknown: helm agent ' + (sub || ''));
      process.exit(1);
    }
  } else if (cmd === 'harness') {
    if (sub === 'defaults') {
      const patch = profilePatch(flags(argv.slice(2)).out);
      if (Object.keys(patch).length === 0) out(await get('/api/system/harness'));
      else out(await call('PUT', '/api/system/harness', patch));
    } else {
      console.error('unknown: helm harness ' + (sub || ''));
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
  } else if (cmd === 'mcp') {
    if (sub === 'ls') {
      out(await get('/api/mcp'));
    } else if (sub === 'get') {
      if (!argv[2]) {
        console.error('usage: helm mcp get <id>');
        process.exit(1);
      }
      out(await get('/api/mcp/' + argv[2]));
    } else if (sub === 'add') {
      const f = flags(argv.slice(2), MCP_MULTI).out;
      const config = mcpConfig(f);
      if (!f.name || !f.desc || !config) {
        console.error(
          'usage: helm mcp add --name <n> --desc <d> --stdio <runtime> [--arg <a>]... [--env K=V]... [--requires <r,...>] [--assign <agentId>]\n' +
            '       helm mcp add --name <n> --desc <d> --http <url> [--header K=V]... [--assign <agentId>]',
        );
        process.exit(1);
      }
      const body = { name: f.name, description: f.desc, config: config };
      if (f.requires) body.requires = f.requires.split(',').filter(Boolean);
      if (f.assign) body.assignTo = [f.assign];
      const r = await call('POST', '/api/mcp', body);
      console.log('added mcp server ' + r.id + (f.assign ? ' (assigned to ' + f.assign + ')' : ''));
      if (r.runtimesMissing && r.runtimesMissing.length) {
        console.log(
          'warning: this machine lacks ' +
            r.runtimesMissing.join(', ') +
            ' — the server will show as failed until it is installed',
        );
      }
      out(r);
    } else if (sub === 'set') {
      const id = argv[2];
      const f = flags(argv.slice(3), MCP_MULTI).out;
      if (!id) {
        console.error(
          'usage: helm mcp set <id> [--name <n>] [--desc <d>] [--stdio … | --http …] [--requires <r,...>]',
        );
        process.exit(1);
      }
      const patch = {};
      if (f.name) patch.name = f.name;
      if (f.desc) patch.description = f.desc;
      const config = mcpConfig(f);
      if (config) patch.config = config;
      if (f.requires) patch.requires = f.requires.split(',').filter(Boolean);
      out(await call('PATCH', '/api/mcp/' + id, patch));
    } else if (sub === 'rm') {
      if (!argv[2]) {
        console.error('usage: helm mcp rm <id>');
        process.exit(1);
      }
      await call('DELETE', '/api/mcp/' + argv[2]);
      console.log('removed mcp server ' + argv[2]);
    } else if (sub === 'assign' || sub === 'unassign') {
      const serverId = argv[2];
      const f = flags(argv.slice(3)).out;
      if (!serverId || !f.agent) {
        console.error('usage: helm mcp ' + sub + ' <serverId> --agent <agentId>');
        process.exit(1);
      }
      if (sub === 'assign') {
        await call('POST', '/api/agents/' + f.agent + '/mcp', { serverId: serverId });
        console.log('assigned ' + serverId + ' to ' + f.agent);
      } else {
        await call('DELETE', '/api/agents/' + f.agent + '/mcp/' + serverId);
        console.log('unassigned ' + serverId + ' from ' + f.agent);
      }
    } else {
      console.error('unknown: helm mcp ' + (sub || ''));
      process.exit(1);
    }
  } else if (cmd === 'remote') {
    if (sub === 'ls') {
      out(await get('/api/remotes'));
    } else if (sub === 'get') {
      if (!argv[2]) {
        console.error('usage: helm remote get <id>');
        process.exit(1);
      }
      out(await get('/api/remotes/' + argv[2]));
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
          'usage: helm remote add --code <helm-connect:...> [--name <n>] [--identity <keyfile>]\n' +
            '       helm remote add --ssh <user@host[:port]> --token <t> [--port <helmPort>] [--name <n>] [--identity <keyfile>]',
        );
        process.exit(1);
      }
      if (f.name) body.name = f.name;
      if (f.identity) body.sshIdentityFile = f.identity;
      const r = await call('POST', '/api/remotes', body);
      console.log('added remote ' + r.remote.id + ' (' + r.remote.name + ')');
      out(r.info);
    } else if (sub === 'set') {
      const id = argv[2];
      const f = flags(argv.slice(3)).out;
      const patch = {};
      if (f.name) patch.name = f.name;
      if (f.identity) patch.sshIdentityFile = f.identity;
      if (f['no-identity'] === 'true') patch.sshIdentityFile = null;
      if (!id || Object.keys(patch).length === 0) {
        console.error(
          'usage: helm remote set <id> [--name <n>] [--identity <keyfile> | --no-identity]',
        );
        process.exit(1);
      }
      const r = await call('PATCH', '/api/remotes/' + id, patch);
      console.log('updated remote ' + id + (r.info ? ' (handshake ok)' : ''));
      out(r.remote);
    } else if (sub === 'check') {
      if (!argv[2]) {
        console.error('usage: helm remote check <id> [--agent <agentId>] [--json]');
        process.exit(1);
      }
      const f = flags(argv.slice(3)).out;
      const report = await call(
        'POST',
        '/api/remotes/' + argv[2] + '/check',
        f.agent ? { agentId: f.agent } : {},
      );
      if (f.json === 'true') out(report);
      else printReport(report);
      if (!report.ok) process.exit(1);
    } else if (sub === 'ops') {
      if (!argv[2]) {
        console.error('usage: helm remote ops <id> [--limit <n>]');
        process.exit(1);
      }
      const f = flags(argv.slice(3)).out;
      const q = f.limit ? '?limit=' + encodeURIComponent(f.limit) : '';
      out(await get('/api/remotes/' + argv[2] + '/ops' + q));
    } else if (sub === 'exec') {
      // Operator's terminal only. The server never runs a caller's command: the
      // CLI reads the saved login and spawns ssh itself, with this process's
      // keys and terminal, then records what ran in the ledger.
      const id = argv[2];
      const dash = argv.indexOf('--');
      const command = dash >= 0 ? argv.slice(dash + 1) : argv.slice(3);
      if (!id || command.length === 0) {
        console.error('usage: helm remote exec <id> -- <command…>');
        process.exit(1);
      }
      const remote = await get('/api/remotes/' + id);
      const result = spawnSync('ssh', sshArgsFor(remote).concat(command), { stdio: 'inherit' });
      const code = result.status === null ? null : result.status;
      try {
        await call('POST', '/api/remotes/' + id + '/ops', {
          kind: 'exec-note',
          argv: command,
          code: code,
        });
      } catch {
        /* best-effort: the command already ran */
      }
      process.exit(code === null ? 1 : code);
    } else if (sub === 'pause' || sub === 'resume') {
      if (!argv[2]) {
        console.error('usage: helm remote ' + sub + ' <id>');
        process.exit(1);
      }
      const f = flags(argv.slice(3)).out;
      out(
        await call('POST', '/api/remotes/' + argv[2] + '/pause', {
          paused: sub === 'pause',
          reason: f.reason,
        }),
      );
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
  } else if (cmd === 'system') {
    if (sub === 'status') {
      out(await get('/api/system/status'));
    } else if (sub === 'pause') {
      const f = flags(argv.slice(2)).out;
      out(await call('POST', '/api/system/pause', f.reason ? { reason: f.reason } : {}));
    } else if (sub === 'resume') {
      // Only the operator can resume; an agent's token gets a 403 here by
      // design, so it cannot lift a limit it was paused for.
      out(await call('POST', '/api/system/resume', {}));
    } else {
      console.error('unknown: helm system ' + (sub || ''));
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
