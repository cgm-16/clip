import { expect, test } from '@playwright/test';
import { WEB_COPY, WEB_COPY_AUTHORED } from '../lib/ui/copy';
import { seeded, signIn } from './seeded';

/*
 * The two-step deletion, stopped at its last step. `삭제 실행` is never
 * clicked: the spec only proves it stays disabled until the acknowledgement
 * is ticked, then cancels. A browser request to the delete endpoint fails the
 * test.
 *
 * The suite runs against production, so the delete endpoint is also blocked
 * in the browser (Ori, 2026-10-12): a future edit that clicks `삭제 실행` by
 * mistake aborts in the browser instead of deleting the test guild's data.
 * This is a safety interlock, not a stand-in for the endpoint, which this spec
 * never exercises. The block and the request check see only what this page's
 * browser sends: `page.request` and `context.request` bypass both and the
 * endpoint accepts them, so no spec may call delete-data through them.
 */
test('deletion needs the acknowledgement, and cancelling deletes nothing', async ({ page }) => {
  // The seed prints an empty archive channel for an unconfigured guild.
  test.skip(
    seeded('E2E_ARCHIVE_CHANNEL_ID') === '',
    'The seeded guild has no configuration, so its settings page redirects to setup and there is nothing to delete.',
  );
  const copy = WEB_COPY.deleteData;
  await page.route('**/delete-data', (route) => route.abort());
  const deleteRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/delete-data')) {
      deleteRequests.push(request.url());
    }
  });

  await signIn(page, 'E2E_DELETION_TOKEN');
  await page.goto(`/admin/${seeded('E2E_GUILD_ID')}/settings`);
  const clipCountRow = page.getByText(WEB_COPY.setupComplete.clipCountKey).locator('..');
  const clipCountBefore = await clipCountRow.textContent();

  await page.getByRole('button', { name: copy.startDeletion }).click();
  const panel = page.getByRole('region', { name: copy.confirmTitle });
  const confirm = panel.getByRole('button', { name: copy.confirmDeletion });
  await expect(confirm).toBeDisabled();

  await panel.getByRole('checkbox', { name: copy.acknowledgement }).check();
  await expect(confirm).toBeEnabled();
  await panel.getByRole('button', { name: copy.cancel }).click();
  await expect(panel).toBeHidden();

  await page.reload();
  await expect(page.getByRole('button', { name: copy.startDeletion })).toBeEnabled();
  await expect(clipCountRow).toHaveText(clipCountBefore ?? '');
  await expect(page.getByText(WEB_COPY_AUTHORED.deletionCompleted)).toHaveCount(0);
  expect(deleteRequests).toEqual([]);
});
