import { expect, type Page } from '@playwright/test';

/** A value printed by `scripts/e2e-seed.ts`; the suite cannot run without it. */
export function seeded(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is unset: eval the output of scripts/e2e-seed.ts first`);
  }
  return value;
}

/**
 * Spends a seeded setup token through the real `/api/setup/exchange`, so the
 * admin session cookie lands in this page's browser context exactly as the
 * setup link would leave it, without depending on Discord to render `/setup`.
 *
 * Playwright's request context sends no Origin, which the exchange's origin
 * check lets through. The browser's own exchange sends one, so this sends the
 * deployment's origin too: a PUBLIC_BASE_URL that does not match it fails
 * here with a 403 instead of passing unnoticed.
 */
export async function signIn(page: Page, tokenName: string): Promise<void> {
  const response = await page.request.post('/api/setup/exchange', {
    data: { token: seeded(tokenName) },
    headers: { Origin: deploymentOrigin() },
  });
  expect(response.status(), `exchanging ${tokenName}`).toBe(200);
}

/** The origin a browser on the deployment sends; playwright.config.ts requires E2E_BASE_URL. */
function deploymentOrigin(): string {
  return new URL(process.env.E2E_BASE_URL ?? '').origin;
}
