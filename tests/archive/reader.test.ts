import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { getClipPage } from '@/lib/archive/reader';

// Discord snowflakes are opaque strings to us; a random per-test id keeps
// concurrent/re-run test invocations from colliding on the same row.
function fakeSnowflake(): string {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

const T0 = Date.parse('2026-10-01T00:00:00.000Z');

describe('getClipPage', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    // lib/db.ts validates the full Env on first use of the client.
    // DATABASE_URL is deliberately left untouched: it must come from the real
    // Postgres the test runs against, supplied by the invoking command.
    vi.stubEnv('DISCORD_APPLICATION_ID', '1539212298600718416');
    vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
    vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-value');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');

    prisma = (await import('@/lib/db')).getPrismaClient();
  });

  const cleanupGuildIds: string[] = [];

  function trackedGuildId(): string {
    const guildId = fakeSnowflake();
    cleanupGuildIds.push(guildId);
    return guildId;
  }

  afterEach(async () => {
    await prisma.clip.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    cleanupGuildIds.length = 0;
  });

  async function seedActive(guildId: string, count: number, options: { channelId?: string; startMs?: number } = {}) {
    const channelId = options.channelId ?? fakeSnowflake();
    const start = options.startMs ?? T0;
    for (let i = 0; i < count; i++) {
      await prisma.clip.create({
        data: {
          guildId,
          sourceMessageId: `m${String(i).padStart(4, '0')}${fakeSnowflake().slice(0, 6)}`,
          sourceChannelId: channelId,
          authorUserId: fakeSnowflake(),
          status: 'ACTIVE',
          archiveProvenanceMessageId: fakeSnowflake(),
          archiveForwardMessageId: fakeSnowflake(),
          createdAt: new Date(start + i * 1000),
        },
      });
    }
    return channelId;
  }

  async function page(query: Parameters<typeof getClipPage>[0]) {
    const result = await getClipPage(query);
    if (result.kind !== 'OK') {
      throw new Error('expected OK');
    }
    return result.page;
  }

  test('newest first in pages of 20, with ranges and both directions', async () => {
    const guildId = trackedGuildId();
    await seedActive(guildId, 45);
    const p1 = await page({ guildId });
    expect(p1.total).toBe(45);
    expect(p1.range).toEqual({ start: 1, end: 20 });
    expect(p1.newerCursor).toBeNull();
    expect(p1.items[0].clippedAt > p1.items[1].clippedAt).toBe(true);
    expect(p1.items[0].clippedAt).toBe(new Date(T0 + 44_000).toISOString());

    const p2 = await page({ guildId, before: p1.olderCursor! });
    expect(p2.range).toEqual({ start: 21, end: 40 });
    const p3 = await page({ guildId, before: p2.olderCursor! });
    expect(p3.range).toEqual({ start: 41, end: 45 });
    expect(p3.olderCursor).toBeNull();

    const back = await page({ guildId, after: p3.newerCursor! });
    expect(back.items.map((i) => i.sourceMessageId)).toEqual(p2.items.map((i) => i.sourceMessageId));
    expect(back.range).toEqual({ start: 21, end: 40 });
  });

  test('a tie on clippedAt is broken by sourceMessageId, descending, with no row lost or repeated', async () => {
    const guildId = trackedGuildId();
    const ids = ['a1', 'a2', 'a3'].map((p) => p + fakeSnowflake().slice(0, 8));
    for (const sourceMessageId of ids) {
      await prisma.clip.create({
        data: {
          guildId,
          sourceMessageId,
          sourceChannelId: 'c1',
          authorUserId: 'u',
          status: 'ACTIVE',
          archiveProvenanceMessageId: 'p',
          archiveForwardMessageId: 'f',
          createdAt: new Date(T0),
        },
      });
    }
    await seedActive(guildId, 19, { startMs: T0 + 10_000 });
    const p1 = await page({ guildId });
    const p2 = await page({ guildId, before: p1.olderCursor! });
    const seen = [...p1.items, ...p2.items].map((i) => i.sourceMessageId);
    expect(new Set(seen).size).toBe(22);
    expect(p2.items.map((i) => i.sourceMessageId)).toEqual([...ids].sort().reverse().slice(1));
  });

  test('a clip inserted between page loads does not shift an older page', async () => {
    const guildId = trackedGuildId();
    await seedActive(guildId, 30);
    const p1 = await page({ guildId });
    await seedActive(guildId, 1, { startMs: T0 + 999_000 });
    const p2 = await page({ guildId, before: p1.olderCursor! });
    expect(p2.items).toHaveLength(10);
    expect(p2.range).toEqual({ start: 22, end: 31 });
  });

  test('the channel filter narrows items and total; channelIds lists every ACTIVE source channel', async () => {
    const guildId = trackedGuildId();
    const a = await seedActive(guildId, 3);
    const b = await seedActive(guildId, 2);
    const filtered = await page({ guildId, sourceChannelId: b });
    expect(filtered.total).toBe(2);
    expect(filtered.items.every((i) => i.sourceChannelId === b)).toBe(true);
    expect([...filtered.channelIds].sort()).toEqual([a, b].sort());
  });

  test('only ACTIVE clips of this guild are listed and counted', async () => {
    const guildId = trackedGuildId();
    await seedActive(guildId, 2);
    await seedActive(trackedGuildId(), 3);
    await prisma.clip.create({
      data: { guildId, sourceMessageId: fakeSnowflake(), sourceChannelId: 'c', authorUserId: 'u', status: 'PENDING' },
    });
    await prisma.clip.create({
      data: {
        guildId,
        sourceMessageId: fakeSnowflake(),
        sourceChannelId: 'c',
        authorUserId: 'u',
        status: 'REMOVED_BY_ADMIN',
        removedAt: new Date(),
      },
    });
    const p = await page({ guildId });
    expect(p.total).toBe(2);
    expect(p.items).toHaveLength(2);
  });

  test('an empty archive has no range and no cursors', async () => {
    expect(await page({ guildId: trackedGuildId() })).toEqual({
      items: [],
      total: 0,
      range: null,
      newerCursor: null,
      olderCursor: null,
      channelIds: [],
    });
  });

  test('a cursor whose row was removed still pages from its position', async () => {
    const guildId = trackedGuildId();
    await seedActive(guildId, 25);
    const p1 = await page({ guildId });
    const last = p1.items[19];
    await prisma.clip.delete({
      where: { guildId_sourceMessageId: { guildId, sourceMessageId: last.sourceMessageId } },
    });
    const p2 = await page({ guildId, before: p1.olderCursor! });
    expect(p2.items).toHaveLength(5);
  });

  test.each([
    [{ before: 'nonsense' }],
    [{ after: '123' }],
    [{ before: `${T0}.abc`, after: `${T0}.abc` }],
    [{ sourceChannelId: "1' OR 1=1" }],
    [{ before: `${T0}.${'x'.repeat(40)}` }],
    [{ before: '999999999999999.abc' }],
    [{ after: '253402300800000.abc' }],
  ])('rejects malformed query %o', async (query) => {
    expect(await getClipPage({ guildId: 'g', ...query })).toEqual({ kind: 'INVALID' });
  });
});
