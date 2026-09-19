/**
 * Set up this machine as a helm remote deployment environment (the VPS side
 * of helmship — docs/helmship-plan.md, M-remote-1).
 *
 *   pnpm remote:init [--port <n>] [--host <public-host>] [--ssh-port <n>]
 *                    [--no-service] [--claude-version <v>]
 *   pnpm remote:init --rotate
 *   pnpm remote:init --claude <v>
 *
 * Idempotent: re-running overwrites .helm/remote.env / remote.json and
 * reinstalls the systemd unit. `--rotate` only reissues the pairing token
 * (invalidating the old one) and restarts the service. `--no-service` skips
 * systemd (e.g. macOS testing) — start the daemon manually with
 * `HELM_HEADLESS=1 HELM_PORT=<port> pnpm serve`.
 *
 * Claude Code version: the daemon's harness is pinned. remote.env carries
 * DISABLE_AUTOUPDATER=1 so the CLI never moves underneath a running fleet, and
 * ship preflight refuses when local and remote differ in major.minor. To move
 * the pin, `--claude <v>` installs that exact version with the native
 * installer, records it, and restarts the unit; `--claude-version <v>` does the
 * same install during a fresh init.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { paths } from '../src/server/paths.ts';
import { generatePairingToken, hashToken } from '../src/server/remote-auth.ts';
import { encodeConnectCode } from '../src/server/remotes/connect-code.ts';
import { HELM_VERSION } from '../src/version.ts';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const UNIT_NAME = 'helm-remote.service';
const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;

// ── tiny arg parser ──────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// ── output helpers ───────────────────────────────────────────────────────────

const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const skip = (msg: string) => console.log(`  – ${msg}`);
function fail(msg: string): never {
  console.error(`  ✘ ${msg}`);
  process.exit(1);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
async function prompt(question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback || '';
}

// ── .helm/remote.env read/write ──────────────────────────────────────────────

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeRemoteEnv(port: number, oauthToken: string): void {
  const body = [
    '# helm headless daemon environment (systemd EnvironmentFile). chmod 600 —',
    '# it holds the Claude Code OAuth token. Written by `pnpm remote:init`.',
    'HELM_HEADLESS=1',
    `HELM_PORT=${port}`,
    `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`,
    // The CLI is the fleet's runtime and ship preflight compares its version
    // across the seam, so it must not update itself under a running daemon.
    'DISABLE_AUTOUPDATER=1',
    '',
  ].join('\n');
  writeFileSync(paths.remoteEnv, body);
  chmodSync(paths.remoteEnv, 0o600);
}

/** Add `KEY=value` to remote.env if absent, keeping every other line as is. */
function ensureRemoteEnvLine(key: string, value: string): void {
  const existing = existsSync(paths.remoteEnv) ? readFileSync(paths.remoteEnv, 'utf8') : '';
  if (new RegExp(`^${key}=`, 'm').test(existing)) return;
  writeFileSync(paths.remoteEnv, `${existing.replace(/\n*$/, '\n')}${key}=${value}\n`);
  chmodSync(paths.remoteEnv, 0o600);
}

// ── Claude Code version ──────────────────────────────────────────────────────

function claudeVersion(): string | null {
  try {
    const out = execFileSync('claude', ['--version'], { timeout: 15_000 }).toString().trim();
    return /\d+[^\s]*/.exec(out)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Install one exact Claude Code version with the native installer, which puts
 * the binary in ~/.local/bin (already on the unit's PATH via {{PATH}}).
 * No-op when that version is already what `claude --version` reports.
 */
function installClaude(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`not a Claude Code version: ${version}`);
  const current = claudeVersion();
  if (current === version) {
    skip(`Claude Code ${version} already installed`);
    return;
  }
  console.log(`  … installing Claude Code ${version} (currently ${current ?? 'not found'})`);
  const r = spawnSync(
    'bash',
    ['-c', `curl -fsSL https://claude.ai/install.sh | bash -s ${version}`],
    { stdio: 'inherit', timeout: 600_000 },
  );
  if (r.status !== 0) fail(`Claude Code install failed (exit ${r.status})`);
  const now = claudeVersion();
  if (now !== version) fail(`installed, but \`claude --version\` reports ${now ?? 'nothing'}`);
  ok(`Claude Code ${version} installed`);
}

function recordClaudeVersion(version: string | null): void {
  if (!version || !existsSync(paths.remoteJson)) return;
  const previous = JSON.parse(readFileSync(paths.remoteJson, 'utf8'));
  writeFileSync(
    paths.remoteJson,
    JSON.stringify({ ...previous, claudeVersion: version }, null, 2) + '\n',
  );
}

// ── systemd ──────────────────────────────────────────────────────────────────

function systemdAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  return spawnSync('systemctl', ['--version'], { stdio: 'ignore' }).status === 0;
}

/**
 * The PATH the daemon runs with. systemd's default omits ~/.local/bin, where
 * Claude Code's native installer lives, so the directory of the `claude` that
 * passed preflight is prepended explicitly — resolving it here, while a login
 * shell's PATH is still in effect, is the only place that knows it.
 */
function servicePath(): string {
  const dirs = [`${os.homedir()}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin'];
  try {
    const resolved = execFileSync('which', ['claude'], { timeout: 10_000 }).toString().trim();
    if (resolved) dirs.unshift(path.dirname(resolved));
  } catch {
    // Preflight already proved `claude` runs; if `which` is missing we still
    // have the two conventional locations below.
  }
  return [...new Set(dirs)].join(':');
}

function installService(): void {
  const template = readFileSync(
    path.join(repoRoot, 'deploy', 'helm-remote.service.template'),
    'utf8',
  );
  const unit = template
    .replaceAll('{{USER}}', os.userInfo().username)
    .replaceAll('{{APP_DIR}}', repoRoot)
    .replaceAll('{{PATH}}', servicePath())
    .replaceAll('{{NODE_BIN}}', process.execPath);
  const tee = spawnSync('sudo', ['tee', UNIT_PATH], {
    input: unit,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  if (tee.status !== 0) fail(`could not write ${UNIT_PATH} (sudo tee failed)`);
  // `enable --now` starts a stopped unit but does NOT restart a running one, so
  // on a re-run — the way you'd apply a fixed unit file, or pick up a new
  // build — the daemon would keep running the old one. Restart explicitly.
  for (const args of [['daemon-reload'], ['enable', UNIT_NAME], ['restart', UNIT_NAME]]) {
    const r = spawnSync('sudo', ['systemctl', ...args], { stdio: 'inherit' });
    if (r.status !== 0) fail(`systemctl ${args.join(' ')} failed`);
  }
  ok(`systemd unit installed and started (${UNIT_NAME})`);
}

/** @param what — what the restart picks up, for the messages ("the new token", "Claude Code 2.1.277"). */
function restartServiceIfInstalled(what: string): void {
  if (!systemdAvailable() || !existsSync(UNIT_PATH)) {
    skip(`no systemd unit found — restart the daemon manually to pick up ${what}`);
    return;
  }
  const r = spawnSync('sudo', ['systemctl', 'restart', UNIT_NAME], { stdio: 'inherit' });
  if (r.status !== 0) fail(`systemctl restart ${UNIT_NAME} failed`);
  ok(`daemon restarted with ${what}`);
}

/**
 * Ask the daemon we just started what it thinks of itself.
 *
 * Init's own smoke test runs in a login shell, so it proves the OAuth token and
 * nothing about the environment systemd hands the service. The two disagreed
 * once already (PATH, and therefore `claude`), and the failure mode is silent:
 * a green init, a running daemon, `authOk: false`, and ship refusing at
 * preflight with a message pointing at the token instead of the unit. Warn
 * rather than fail — the daemon may simply still be starting.
 */
async function verifyDaemon(helmPort: number, token: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${helmPort}/api/remote/info`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const info = (await res.json()) as {
          harnesses?: { type: string; version: string | null; authOk: boolean }[];
        };
        const claude = info.harnesses?.find((h) => h.type === 'claude-code');
        if (claude?.authOk) {
          ok(`daemon answering on 127.0.0.1:${helmPort} (claude-code ${claude.version})`);
        } else {
          console.error(
            `  ✘ the daemon is up but reports claude-code authOk=false — it cannot see a\n` +
              `    working \`claude\` in the environment systemd gave it. Ship will refuse at\n` +
              `    preflight until this is fixed. Check: systemctl show ${UNIT_NAME} -p Environment`,
          );
        }
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`  ✘ the daemon did not answer on 127.0.0.1:${helmPort} within 20s`);
}

// ── connect code ─────────────────────────────────────────────────────────────

async function detectPublicHost(): Promise<string | undefined> {
  try {
    const res = await fetch('https://ifconfig.me', {
      headers: { accept: 'text/plain' },
      signal: AbortSignal.timeout(3000),
    });
    const text = (await res.text()).trim();
    return /^[0-9a-fA-F.:]+$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

async function printConnectCode(helmPort: number, token: string): Promise<void> {
  const host =
    opt('host') ||
    (await prompt('Public hostname or IP of this machine', await detectPublicHost()));
  if (!host) fail('a public host is required for the connect code (pass --host)');
  const sshPort = Number(opt('ssh-port') ?? 22);
  const code = encodeConnectCode({
    v: 1,
    sshUser: os.userInfo().username,
    host,
    sshPort,
    helmPort,
    token,
  });
  console.log('\nPairing token (shown once — only its hash is stored on this machine):');
  console.log(`\n  ${token}\n`);
  console.log('Connect code — paste into your local HelmConsole (Remotes → Add remote):');
  console.log(`\n  ${code}\n`);
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
  mkdirSync(paths.helmRoot, { recursive: true });

  if (opt('claude')) {
    // Move the pinned harness version. Deliberately separate from --rotate: it
    // touches the binary and the unit, never the pairing token.
    const version = opt('claude')!;
    console.log(`Pinning Claude Code to ${version}\n`);
    if (!existsSync(paths.remoteJson)) fail('no .helm/remote.json — run `pnpm remote:init` first');
    installClaude(version);
    ensureRemoteEnvLine('DISABLE_AUTOUPDATER', '1');
    recordClaudeVersion(version);
    ok('.helm/remote.json records the pinned version; DISABLE_AUTOUPDATER=1 in remote.env');
    restartServiceIfInstalled(`Claude Code ${version}`);
    if (systemdAvailable() && existsSync(UNIT_PATH)) {
      // The handshake shows the version the *daemon* sees, which is the point:
      // a login shell and the unit's PATH have disagreed before.
      const env = existsSync(paths.remoteEnv) ? parseEnvFile(paths.remoteEnv) : {};
      console.log(
        `  – verify from the console (Remotes → Ping); the daemon on port ${env.HELM_PORT ?? 5555} ` +
          `re-probes \`claude --version\` within a minute`,
      );
    }
    rl.close();
    return;
  }

  if (flag('rotate')) {
    console.log('Rotating the pairing token\n');
    if (!existsSync(paths.remoteJson)) fail('no .helm/remote.json — run `pnpm remote:init` first');
    const env = existsSync(paths.remoteEnv) ? parseEnvFile(paths.remoteEnv) : {};
    const helmPort = Number(opt('port') ?? env.HELM_PORT ?? 5555);
    const token = generatePairingToken();
    const previous = JSON.parse(readFileSync(paths.remoteJson, 'utf8'));
    writeFileSync(
      paths.remoteJson,
      JSON.stringify(
        {
          ...previous,
          tokenHash: hashToken(token),
          createdAt: new Date().toISOString(),
          helmVersion: HELM_VERSION,
        },
        null,
        2,
      ) + '\n',
    );
    ok('new pairing token issued — the old token no longer works');
    restartServiceIfInstalled('the new token');
    await printConnectCode(helmPort, token);
    rl.close();
    return;
  }

  console.log('Setting up this machine as a helm remote\n');
  const helmPort = Number(opt('port') ?? 5555);

  // 1. Preflight.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) fail(`Node >= 20 required (running ${process.versions.node})`);
  ok(`Node ${process.versions.node}`);
  const pin = opt('claude-version');
  if (pin) installClaude(pin);
  const claudeV = claudeVersion();
  if (!claudeV) fail('`claude` not found on PATH — install Claude Code first');
  ok(`Claude Code CLI on PATH (${claudeV})`);
  if (!existsSync(path.join(repoRoot, 'dist', 'server', 'server.js'))) {
    const build = await prompt(
      'No production build found (dist/). Run `pnpm build` now? (y/n)',
      'y',
    );
    if (build.toLowerCase().startsWith('y')) {
      const r = spawnSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit' });
      if (r.status !== 0) fail('pnpm build failed');
      ok('production build complete');
    } else {
      skip('skipping build — the daemon will not start until you run `pnpm build`');
    }
  } else {
    ok('production build present (dist/)');
  }

  // 2. Harness credential → .helm/remote.env (chmod 600).
  const oauthToken =
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    (await prompt('CLAUDE_CODE_OAUTH_TOKEN (input is not hidden — paste in a private terminal)'));
  if (!oauthToken) fail('CLAUDE_CODE_OAUTH_TOKEN is required');
  writeRemoteEnv(helmPort, oauthToken);
  ok('.helm/remote.env written (chmod 600)');

  // 3. Smoke-test the harness with that token before anything else depends on it.
  try {
    execFileSync('claude', ['-p', 'ping'], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
      timeout: 180_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ok('harness smoke test passed (`claude -p ping`)');
  } catch (err) {
    fail(`harness smoke test failed — check the OAuth token (${String(err)})`);
  }

  // 4. Database.
  {
    const r = spawnSync('pnpm', ['db:migrate'], { cwd: repoRoot, stdio: 'inherit' });
    if (r.status !== 0) fail('pnpm db:migrate failed');
    ok('database migrated');
  }

  // 5. Pairing token — plaintext printed once at the end, only the hash stored.
  const token = generatePairingToken();
  writeFileSync(
    paths.remoteJson,
    JSON.stringify(
      {
        tokenHash: hashToken(token),
        createdAt: new Date().toISOString(),
        helmVersion: HELM_VERSION,
        smokeOk: true,
        claudeVersion: claudeV,
      },
      null,
      2,
    ) + '\n',
  );
  ok('.helm/remote.json written (token hash only)');

  // 6. systemd unit.
  if (flag('no-service')) {
    skip(
      '--no-service: start manually with `HELM_HEADLESS=1 HELM_PORT=' + helmPort + ' pnpm serve`',
    );
  } else if (!systemdAvailable()) {
    skip(
      'systemd not available — start manually with `HELM_HEADLESS=1 HELM_PORT=' +
        helmPort +
        ' pnpm serve`',
    );
  } else {
    installService();
    await verifyDaemon(helmPort, token);
  }

  // 7. Connect code.
  await printConnectCode(helmPort, token);
  rl.close();
})().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
