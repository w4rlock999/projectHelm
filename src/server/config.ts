// Daemon-mode configuration, read once at module load. Two modes share this
// codebase: the local console (default) and the headless remote daemon
// (HELM_HEADLESS=1), which boots the runtime eagerly, binds 127.0.0.1, and
// requires a bearer token on every /api/* request (see src/server.ts).

export interface HelmConfig {
  /** True when running as a remote deployment daemon (HELM_HEADLESS=1). */
  headless: boolean;
  /** Port the daemon serves on. Local dev still uses vite's --port flag. */
  port: number;
  /**
   * URL agents' materialized tool scripts use to reach this daemon. Injected
   * into every spawned agent as HELM_BASE_URL. `localhost` (not 127.0.0.1) so
   * scripts reach the daemon whether it binds IPv4 or IPv6 — Node's fetch
   * tries both.
   */
  baseUrl: string;
}

// Treat empty-string env vars as unset (an `EnvironmentFile` with `KEY=` must
// not zero out the port).
function env(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

function load(): HelmConfig {
  const headless = process.env.HELM_HEADLESS === '1';
  const port = Number(env('HELM_PORT') ?? (headless ? 5555 : 3000));
  const baseUrl = env('HELM_BASE_URL') ?? `http://localhost:${port}`;
  return { headless, port, baseUrl };
}

export const config: HelmConfig = load();
