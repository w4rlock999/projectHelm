import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { devtools } from '@tanstack/devtools-vite';

import { tanstackStart } from '@tanstack/react-start/plugin/vite';

import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Short git sha of the checkout being built, or 'dev' outside a git checkout. */
function gitBuildId(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // Stamped into src/version.ts (HELM_BUILD) so the pairing handshake can show
  // commit skew that an unchanged HELM_VERSION hides.
  define: { __HELM_BUILD__: JSON.stringify(gitBuildId()) },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
});

export default config;
