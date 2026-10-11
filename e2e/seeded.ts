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
 */
export async function signIn(page: Page, tokenName: string): Promise<void> {
  const response = await page.request.post('/api/setup/exchange', { data: { token: seeded(tokenName) } });
  expect(response.status(), `exchanging ${tokenName}`).toBe(200);
}
