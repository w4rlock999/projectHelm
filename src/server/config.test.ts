import { afterEach, describe, expect, it, vi } from 'vitest';

// config reads env once at module load, so each case re-imports a fresh copy.
async function loadConfig() {
  vi.resetModules();
  const mod = await import('./config.ts');
  return mod.config;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('config', () => {
  it('local defaults: not headless, port 3000', async () => {
    vi.stubEnv('HELM_HEADLESS', '');
    vi.stubEnv('HELM_PORT', '');
    vi.stubEnv('HELM_BASE_URL', '');
    const config = await loadConfig();
    expect(config.headless).toBe(false);
    expect(config.port).toBe(3000);
    expect(config.baseUrl).toBe('http://localhost:3000');
  });

  it('headless defaults: port 5555', async () => {
    vi.stubEnv('HELM_HEADLESS', '1');
    vi.stubEnv('HELM_PORT', '');
    vi.stubEnv('HELM_BASE_URL', '');
    const config = await loadConfig();
    expect(config.headless).toBe(true);
    expect(config.port).toBe(5555);
    expect(config.baseUrl).toBe('http://localhost:5555');
  });

  it('HELM_PORT and HELM_BASE_URL override', async () => {
    vi.stubEnv('HELM_HEADLESS', '1');
    vi.stubEnv('HELM_PORT', '7777');
    vi.stubEnv('HELM_BASE_URL', 'http://example.local:9999');
    const config = await loadConfig();
    expect(config.port).toBe(7777);
    expect(config.baseUrl).toBe('http://example.local:9999');
  });
});
