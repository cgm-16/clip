import { defineConfig, devices } from '@playwright/test';

// The suite runs against a deployment (CLAUDE.md "Workflow"), never in the
// merge gate, so there is no webServer: E2E_BASE_URL names the target.
// Seed it first with `scripts/e2e-seed.ts`; that file documents the whole run.
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) {
  throw new Error('E2E_BASE_URL is required, e.g. E2E_BASE_URL=https://clipendpoint.cc pnpm e2e');
}

export default defineConfig({
  testDir: 'e2e',
  // One worker, no retries: each spec spends a one-time setup token, so a
  // retry would reuse a spent token (a false failure) or save setup twice.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  use: { baseURL },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
