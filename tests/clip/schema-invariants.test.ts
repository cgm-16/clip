import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { Prisma } from '../../generated/prisma/client';
import type { prisma as PrismaSingleton } from '@/lib/db';

// Discord snowflakes are opaque strings to us; a random per-test id keeps
// concurrent/re-run test invocations from colliding on the same row.
function fakeSnowflake(): string {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

describe('control-plane schema invariants', () => {
  let prisma: typeof PrismaSingleton;

  beforeAll(async () => {
    // lib/db.ts validates the full Env, not just DATABASE_URL, on first use of
    // the client, so every other required var needs a value before the first
    // query -- these are otherwise irrelevant to a schema/constraint test.
    // DATABASE_URL is deliberately left untouched: it must come from the real
    // Postgres the test runs against, supplied by the invoking command.
    vi.stubEnv('DISCORD_APPLICATION_ID', '1539212298600718416');
    vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
    vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-value');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');

    ({ prisma } = await import('@/lib/db'));
  });

  const cleanupGuildIds: string[] = [];

  afterEach(async () => {
    // Clippers carry an FK to Clip, so they must go first.
    await prisma.clipper.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.clip.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    cleanupGuildIds.length = 0;
  });

  test('a duplicate Clip insert is rejected by the database', async () => {
    const guildId = fakeSnowflake();
    cleanupGuildIds.push(guildId);
    const sourceMessageId = fakeSnowflake();
    const clipInput = {
      guildId,
      sourceMessageId,
      sourceChannelId: fakeSnowflake(),
      authorUserId: fakeSnowflake(),
    };

    await prisma.clip.create({ data: clipInput });

    await expect(prisma.clip.create({ data: clipInput })).rejects.toMatchObject({
      code: 'P2002',
    } satisfies Partial<Prisma.PrismaClientKnownRequestError>);
  });

  test('a duplicate Clipper insert is rejected by the database', async () => {
    const guildId = fakeSnowflake();
    cleanupGuildIds.push(guildId);
    const sourceMessageId = fakeSnowflake();
    await prisma.clip.create({
      data: {
        guildId,
        sourceMessageId,
        sourceChannelId: fakeSnowflake(),
        authorUserId: fakeSnowflake(),
      },
    });

    const clipperInput = { guildId, sourceMessageId, clipperUserId: fakeSnowflake() };
    await prisma.clipper.create({ data: clipperInput });

    await expect(prisma.clipper.create({ data: clipperInput })).rejects.toMatchObject({
      code: 'P2002',
    } satisfies Partial<Prisma.PrismaClientKnownRequestError>);
  });
});
