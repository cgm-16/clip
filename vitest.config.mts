import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    // Pinned: with no `reporters`, Vitest picks a minimal reporter in an agent
    // shell that hides the console output of passing tests. `default` shows it
    // in every shell; CI keeps the `github-actions` reporter it gets by default.
    reporters: process.env.GITHUB_ACTIONS === 'true' ? ['default', 'github-actions'] : ['default'],
    // `.tsx` so component tests are collected. The default environment stays
    // `node`: the Postgres-backed suites need real sockets, and jsdom would
    // break them. A component test opts into a DOM with a per-file
    // `// @vitest-environment jsdom` docblock.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup/database-url.ts'],
  },
  // Mirrors the tsconfig `@/*` -> `./*` mapping.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
});
