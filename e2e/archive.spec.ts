import { expect, test, type Page } from '@playwright/test';
import { WEB_COPY, WEB_COPY_AUTHORED, WEB_COPY_TEMPLATES } from '../lib/ui/copy';
import { seeded, signIn } from './seeded';

// One seeded token signs in one context, shared by these tests in order.
test.describe.configure({ mode: 'serial' });

let page: Page;
let archiveUrl: string;

const RANGE = new RegExp(
  `^${WEB_COPY_TEMPLATES.pageRange.replace('{start}', '(\\d+)').replace('{end}', '(\\d+)').replace('{total}', '(\\d+)')}$`,
);

/** Screen D's pager range, e.g. `1–20 / 23`, as numbers. */
async function readRange(): Promise<{ start: number; end: number; total: number }> {
  const text = (await page.getByText(RANGE).textContent()) ?? '';
  const [, start, end, total] = RANGE.exec(text) ?? [];
  return { start: Number(start), end: Number(end), total: Number(total) };
}

test.beforeAll(async ({ browser }, testInfo) => {
  page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await signIn(page, 'E2E_ARCHIVE_TOKEN');
  archiveUrl = `/admin/${seeded('E2E_GUILD_ID')}/archive`;
});

test.afterAll(async () => {
  await page.close();
});

test('the archive list renders', async () => {
  await page.goto(archiveUrl);
  const count = new RegExp(`^${WEB_COPY_TEMPLATES.clipCount.replace('{count}', '(\\d+)')}$`);
  const total = Number(count.exec((await page.getByText(count).textContent()) ?? '')?.[1]);
  if (total === 0) {
    await expect(page.getByText(WEB_COPY_AUTHORED.archiveEmpty)).toBeVisible();
    return;
  }
  const { start, end } = await readRange();
  expect(start).toBe(1);
  // One card per clip in the range. Cards are counted, not original-message
  // links: a card whose original is unavailable shows a label instead.
  await expect(page.getByRole('article')).toHaveCount(end - start + 1);
});

test('pagination moves by page and keeps the page in the URL', async () => {
  await page.goto(archiveUrl);
  const first = await page.getByText(RANGE).count() === 0 ? null : await readRange();
  test.skip(first === null || first.end >= first.total, 'The guild has one page of clips or fewer; pagination needs more.');

  await page.getByRole('link', { name: WEB_COPY.archive.nextPage }).click();
  await expect(page).toHaveURL(/[?&]before=/);
  await expect.poll(readRange).toMatchObject({ start: first!.end + 1, total: first!.total });

  await page.getByRole('link', { name: WEB_COPY.archive.previousPage }).click();
  await expect(page).toHaveURL(/[?&]after=/);
  await expect.poll(readRange).toEqual(first);
});

test('the channel filter narrows the list and lives in the URL', async () => {
  await page.goto(archiveUrl);
  const filter = page.getByLabel(WEB_COPY.archive.channelFilterLabel, { exact: true });
  const channels = (await filter.locator('option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  )).filter((value) => value !== '');
  test.skip(channels.length === 0, 'The guild has no clips, so there is no channel to filter by.');
  const unfiltered = await readRange();

  await filter.selectOption(channels[0]);
  await expect(page).toHaveURL(new RegExp(`[?&]channel=${channels[0]}(&|$)`));
  await expect(filter).toHaveValue(channels[0]);
  // With clips in more than one channel, one channel's share is strictly fewer.
  const filteredTotal = expect.poll(async () => (await readRange()).total);
  if (channels.length > 1) {
    await filteredTotal.toBeLessThan(unfiltered.total);
  } else {
    await filteredTotal.toBe(unfiltered.total);
  }

  await filter.selectOption('');
  await expect(page).toHaveURL(new RegExp(`${archiveUrl}$`));
  await expect.poll(async () => (await readRange()).total).toBe(unfiltered.total);
});
