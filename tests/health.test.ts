import { expect, test } from 'vitest';
import { GET } from '@/app/api/health/route';

test('health endpoint reports ok with a 200', async () => {
  const response = await GET();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
});
