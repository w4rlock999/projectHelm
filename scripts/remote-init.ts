/**
 * Set up this machine as a helm remote deployment environment (the VPS side
 * of helmship — docs/helmship-plan.md, M-remote-1).
 *
 *   pnpm remote:init [--port <n>] [--host <public-host>] [--ssh-port <n>]
 *                    [--no-service] [--rotate]
 *
 * Idempotent: re-running overwrites .helm/remote.env / remote.json and
 * reinstalls the systemd unit. `--rotate` only reissues the pairing token
 * (invalidating the old one) and restarts the service. `--no-service` skips
 * systemd (e.g. macOS testing) — start the daemon manually with
 * `HELM_HEADLESS=1 HELM_PORT=<port> pnpm serve`.
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
    '',
  ].join('\n');
  writeFileSync(paths.remoteEnv, body);
  chmodSync(paths.remoteEnv, 0o600);
}

// ── systemd ──────────────────────────────────────────────────────────────────

function systemdAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  return spawnSync('systemctl', ['--version'], { stdio: 'ignore' }).status === 0;
}

function installService(): void {
  const template = readFileSync(
    path.join(repoRoot, 'deploy', 'helm-remote.service.template'),
    'utf8',
  );
  const unit = template
    .replaceAll('{{USER}}', os.userInfo().username)
    .replaceAll('{{APP_DIR}}', repoRoot)
    .replaceAll('{{NODE_BIN}}', process.execPath);
  const tee = spawnSync('sudo', ['tee', UNIT_PATH], {
    input: unit,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  if (tee.status !== 0) fail(`could not write ${UNIT_PATH} (sudo tee failed)`);
  for (const args of [['daemon-reload'], ['enable', '--now', UNIT_NAME]]) {
    const r = spawnSync('sudo', ['systemctl', ...args], { stdio: 'inherit' });
    if (r.status !== 0) fail(`systemctl ${args.join(' ')} failed`);
  }
  ok(`systemd unit installed and started (${UNIT_NAME})`);
}

function restartServiceIfInstalled(): void {
  if (!systemdAvailable() || !existsSync(UNIT_PATH)) {
    skip('no systemd unit found — restart the daemon manually to load the new token');
    return;
  }
  const r = spawnSync('sudo', ['systemctl', 'restart', UNIT_NAME], { stdio: 'inherit' });
  if (r.status !== 0) fail(`systemctl restart ${UNIT_NAME} failed`);
  ok('daemon restarted with the new token');
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
    restartServiceIfInstalled();
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
  try {
    const v = execFileSync('claude', ['--version'], { timeout: 15_000 }).toString().trim();
    ok(`Claude Code CLI on PATH (${v})`);
  } catch {
    fail('`claude` not found on PATH — install Claude Code first');
  }
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
  }

  // 7. Connect code.
  await printConnectCode(helmPort, token);
  rl.close();
})().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
