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

  // The wave's headline privacy invariant -- "never persist raw Discord message
  // bodies, attachments, or embed payloads in Postgres" -- was protected only by
  // the absence of columns, which no test asserted. Adding `content String?` to
  // Clip passed the entire green gate. This pins the column set instead: any new
  // column on a message-bearing table must be added here deliberately, which is
  // the point at which someone has to ask what it stores.
  test.each([
    [
      'clips',
      [
        'archive_forward_message_id',
        'archive_provenance_message_id',
        'author_notification_status',
        'author_user_id',
        'created_at',
        'guild_id',
        'removed_at',
        'source_channel_id',
        'source_message_id',
        'status',
        'updated_at',
      ],
    ],
    ['clippers', ['clipped_at', 'clipper_user_id', 'guild_id', 'source_message_id']],
  ])('%s stores only ids, state and timestamps -- never message content', async (table, allowed) => {
    const rows = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table}
    `;

    expect(rows.map((row) => row.column_name).sort()).toEqual(allowed);
  });
});
