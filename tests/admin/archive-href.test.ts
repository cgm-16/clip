import { expect, test } from 'vitest';
import { archiveHref } from '@/lib/admin/archive-href';

test('builds linkable archive URLs; the filter alone resets paging', () => {
  expect(archiveHref('g1', {})).toBe('/admin/g1/archive');
  expect(archiveHref('g1', { channel: 'c1' })).toBe('/admin/g1/archive?channel=c1');
  expect(archiveHref('g1', { channel: 'c1', before: '1.a' })).toBe('/admin/g1/archive?channel=c1&before=1.a');
  expect(archiveHref('g1', { after: '2.b' })).toBe('/admin/g1/archive?after=2.b');
});
