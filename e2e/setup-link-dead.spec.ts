import { expect, test } from '@playwright/test';
import { WEB_COPY } from '../lib/ui/copy';
import { seeded } from './seeded';

// Each test runs in a fresh browser context, so no session cookie can make
// the exchange re-open a used token (#72): every one must land on Screen A.
const DEAD_LINKS = [
  { name: 'an expired token', token: () => seeded('E2E_EXPIRED_TOKEN') },
  { name: 'a used token', token: () => seeded('E2E_USED_TOKEN') },
  { name: 'an unknown token', token: () => 'e2e-unknown-setup-token' },
];

for (const link of DEAD_LINKS) {
  test(`${link.name} opens Screen A`, async ({ page }) => {
    // Screen A follows any refused exchange, so the refusal itself is checked:
    // a 401 for the token, not a 403 from an Origin the deployment rejects.
    const exchange = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/setup/exchange');
    await page.goto(`/setup/${link.token()}`);
    expect((await exchange).status()).toBe(401);
    await expect(page.getByRole('heading', { name: WEB_COPY.expiredSetupLink.title })).toBeVisible();
  });
}
