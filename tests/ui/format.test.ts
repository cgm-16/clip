import { expect, test } from 'vitest';
import { formatDate, formatTimestamp } from '@/lib/ui/format';

test('formats in Asia/Seoul', () => {
  expect(formatTimestamp('2026-10-09T12:04:00.000Z')).toBe('2026-10-09 21:04');
  expect(formatDate('2026-10-09T16:30:00.000Z')).toBe('2026-10-10');
});
