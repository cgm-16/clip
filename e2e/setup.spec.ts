import { expect, test } from '@playwright/test';
import { WEB_COPY } from '../lib/ui/copy';
import { seeded } from './seeded';

/*
 * A valid setup link. This WRITES the guild's configuration on the target.
 *
 * A configured guild's link opens Screen E (decision D1), and its edit is the
 * prefilled Screen B, saved back to Screen E. The spec refuses to save unless
 * the form is prefilled with the guild's current archive channel, and changes
 * nothing on it, so the save writes back the configuration already there.
 *
 * Only an unconfigured guild reaches Screen B straight from the link and then
 * Screen C. Its default destination creates a real Discord channel, so that
 * branch runs only with E2E_ALLOW_SETUP_WRITE=1.
 */
test('a valid setup link opens setup, and a save completes', async ({ page }) => {
  const guildId = seeded('E2E_GUILD_ID');
  const archiveChannelId = seeded('E2E_ARCHIVE_CHANNEL_ID');
  const firstSetup = archiveChannelId === '';
  test.skip(
    firstSetup && process.env.E2E_ALLOW_SETUP_WRITE !== '1',
    'The guild has no configuration: a first setup creates a Discord channel. Set E2E_ALLOW_SETUP_WRITE=1 to allow it.',
  );

  await page.goto(`/setup/${seeded('E2E_SETUP_TOKEN')}`);
  const save = page.getByRole('button', { name: WEB_COPY.setup.save });

  if (firstSetup) {
    await expect(page.getByRole('radio', { name: WEB_COPY.setup.destinationCreateLabel })).toBeChecked();
    await save.click();
    await expect(page.getByRole('heading', { name: WEB_COPY.setupComplete.title })).toBeVisible();
    return;
  }

  await expect(page).toHaveURL(new RegExp(`/admin/${guildId}/settings$`));
  await page.getByRole('link', { name: WEB_COPY.deleteData.editSettings }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/${guildId}/setup$`));

  // The guard that keeps the save non-destructive: the current channel, as is.
  await expect(page.getByRole('radio', { name: WEB_COPY.setup.destinationExistingLabel })).toBeChecked();
  await expect(page.getByLabel(WEB_COPY.archive.channelFilterLabel, { exact: true })).toHaveValue(archiveChannelId);

  await save.click();
  await expect(page).toHaveURL(new RegExp(`/admin/${guildId}/settings\\?saved=1$`));
  await expect(page.getByText(WEB_COPY.setup.saved)).toBeVisible();
});
