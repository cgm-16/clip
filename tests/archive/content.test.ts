import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { loadArchiveContent, snowflakeTime, type ArchiveRowContent } from '@/lib/archive/content';
import { DiscordApiError } from '@/lib/discord/rest-client';

// Discord snowflakes are opaque strings to us; a random per-test id keeps
// concurrent/re-run test invocations from colliding on the same row.
function fakeSnowflake(): string {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

// A numeric id, for rows whose fallback timestamp is derived from the snowflake.
function numericSnowflake(): string {
  return String(1_500_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e12)));
}

describe('pure helpers', () => {
  test('snowflakeTime derives the creation instant', () => {
    // Discord's documented example.
    expect(snowflakeTime('175928847299117063')).toBe('2016-04-30T11:18:25.796Z');
    expect(snowflakeTime('not-a-snowflake')).toBeNull();
  });
});

type Handler = (path: string) => unknown;

function stubClient(handler: Handler) {
  let inFlight = 0;
  let maxInFlight = 0;
  const request = vi.fn(async (_method: string, path: string) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    const result = handler(path);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  return { client: { request }, request, maxInFlight: () => maxInFlight };
}

const unknownMessage = () => new DiscordApiError('x', { status: 404, code: 10008 });
const missingAccess = () => new DiscordApiError('x', { status: 403, code: 50001 });

function snapshot(message: Record<string, unknown>) {
  return {
    id: 'fwd',
    message_snapshots: [{ message: { timestamp: '2026-10-01T09:00:00.000Z', ...message } }],
  };
}

describe('loadArchiveContent', () => {
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

  afterEach(async () => {
    const where = { guildId: { in: cleanupGuildIds } };
    await prisma.clip.deleteMany({ where });
    await prisma.guildConfig.deleteMany({ where });
    cleanupGuildIds.length = 0;
  });

  const ARCHIVE_CHANNEL = 'archive1';

  async function configuredGuild(): Promise<string> {
    const guildId = fakeSnowflake();
    cleanupGuildIds.push(guildId);
    await prisma.guildConfig.create({
      data: { guildId, archiveChannelId: ARCHIVE_CHANNEL, configuredByUserId: 'u' },
    });
    return guildId;
  }

  type Seeded = { sourceMessageId: string; sourceChannelId: string; forwardId: string };

  async function seedRow(
    guildId: string,
    options: { authorUserId?: string; status?: 'ACTIVE' | 'PENDING' | 'REMOVED_BY_AUTHOR' } = {},
  ): Promise<Seeded> {
    const status = options.status ?? 'ACTIVE';
    const row = { sourceMessageId: numericSnowflake(), sourceChannelId: fakeSnowflake(), forwardId: fakeSnowflake() };
    await prisma.clip.create({
      data: {
        guildId,
        sourceMessageId: row.sourceMessageId,
        sourceChannelId: row.sourceChannelId,
        authorUserId: options.authorUserId ?? 'author1',
        status,
        archiveProvenanceMessageId: status === 'ACTIVE' ? fakeSnowflake() : null,
        archiveForwardMessageId: status === 'ACTIVE' ? row.forwardId : null,
        removedAt: status === 'REMOVED_BY_AUTHOR' ? new Date() : null,
      },
    });
    return row;
  }

  function paths(row: Seeded) {
    return {
      forward: `/channels/${ARCHIVE_CHANNEL}/messages/${row.forwardId}`,
      source: `/channels/${row.sourceChannelId}/messages/${row.sourceMessageId}`,
    };
  }

  async function loadOne(row: Seeded, guildId: string, handler: Handler) {
    const stub = stubClient(handler);
    const result = await loadArchiveContent({
      guildId,
      sourceMessageIds: [row.sourceMessageId],
      client: stub.client,
      lookupUserName: async () => 'ori',
    });
    if (result.kind !== 'OK') {
      throw new Error('expected OK');
    }
    return result.items[0];
  }

  test('a ready row splits code, keeps safe attachments and embeds, and reads only the reply author', async () => {
    const guildId = await configuredGuild();
    const row = await seedRow(guildId);
    const { forward, source } = paths(row);
    const item = await loadOne(row, guildId, (path) => {
      if (path === forward) {
        return snapshot({
          content: 'hello\n```ts\nconst a = 1;\n```\nbye',
          attachments: [
            { filename: 'a.png', url: 'https://cdn.discordapp.com/a.png', content_type: 'image/png' },
            { filename: 'b.txt', url: 'https://cdn.discordapp.com/b.txt', content_type: 'text/plain' },
          ],
          embeds: [{ title: 'T', description: 'D', url: 'https://example.com' }],
        });
      }
      if (path === source) {
        return {
          message_reference: { message_id: 'p1' },
          referenced_message: { author: { username: 'parent' }, content: 'PARENT-SECRET-BODY' },
        };
      }
      throw new Error(`unexpected ${path}`);
    });

    expect(item).toEqual({
      sourceMessageId: row.sourceMessageId,
      state: 'ready',
      authorName: 'ori',
      originalAt: '2026-10-01T09:00:00.000Z',
      original: 'available',
      body: [
        { kind: 'text', text: 'hello\n' },
        { kind: 'code', text: 'const a = 1;\n' },
        { kind: 'text', text: '\nbye' },
      ],
      attachments: [
        { filename: 'a.png', url: 'https://cdn.discordapp.com/a.png', isImage: true },
        { filename: 'b.txt', url: 'https://cdn.discordapp.com/b.txt', isImage: false },
      ],
      embeds: [{ title: 'T', description: 'D', url: 'https://example.com' }],
      replyToAuthorName: 'parent',
    });
    expect(JSON.stringify(item)).not.toContain('PARENT-SECRET-BODY');
  });

  test('a confirmed unknown forward is missing, dated from the snowflake; an unknown source is unavailable', async () => {
    const guildId = await configuredGuild();
    const row = await seedRow(guildId);
    const item = await loadOne(row, guildId, () => unknownMessage());
    expect(item).toMatchObject({ state: 'missing', original: 'unavailable', originalAt: snowflakeTime(row.sourceMessageId) });
  });

  test('missing access is an access error, never missing', async () => {
    const guildId = await configuredGuild();
    const row = await seedRow(guildId);
    const { forward } = paths(row);
    const item = await loadOne(row, guildId, (path) => (path === forward ? missingAccess() : {}));
    expect(item).toMatchObject({ state: 'error', reason: 'access', original: 'available' });
  });

  test('a timeout is transient', async () => {
    const guildId = await configuredGuild();
    const row = await seedRow(guildId);
    const item = await loadOne(row, guildId, () => new DOMException('timed out', 'TimeoutError'));
    expect(item).toMatchObject({ state: 'error', reason: 'transient', original: 'unknown' });
  });

  test.each([[{ id: 'fwd' }], [{ id: 'fwd', message_snapshots: [{}] }], [null]])(
    'a forward without a valid snapshot (%o) is transient, never missing',
    async (payload) => {
      const guildId = await configuredGuild();
      const row = await seedRow(guildId);
      const { forward } = paths(row);
      const item = await loadOne(row, guildId, (path) => (path === forward ? payload : {}));
      expect(item).toMatchObject({ state: 'error', reason: 'transient' });
    },
  );

  test('non-https URLs never survive; the row still renders', async () => {
    const guildId = await configuredGuild();
    const row = await seedRow(guildId);
    const { forward } = paths(row);
    const item = await loadOne(row, guildId, (path) =>
      path === forward
        ? snapshot({
            content: '<script>alert(1)</script>',
            attachments: [{ filename: 'x', url: 'javascript:alert(1)' }],
            embeds: [
              { title: 'T', url: 'http://insecure.example' },
              { title: 'U', url: 'data:text/html,hi' },
            ],
          })
        : {},
    );
    expect(item.state).toBe('ready');
    const ready = item as Extract<ArchiveRowContent, { state: 'ready' }>;
    expect(ready.attachments).toEqual([]);
    expect(ready.embeds.map((embed) => embed.url)).toEqual([null, null]);
    expect(ready.body).toEqual([{ kind: 'text', text: '<script>alert(1)</script>' }]);
  });

  test('author names are looked up once per author per request', async () => {
    const guildId = await configuredGuild();
    const rows = [
      await seedRow(guildId, { authorUserId: 'same' }),
      await seedRow(guildId, { authorUserId: 'same' }),
      await seedRow(guildId, { authorUserId: 'same' }),
      await seedRow(guildId, { authorUserId: 'other' }),
    ];
    const lookupUserName = vi.fn(async (id: string) => (id === 'same' ? 'samename' : null));
    const result = await loadArchiveContent({
      guildId,
      sourceMessageIds: rows.map((row) => row.sourceMessageId),
      client: stubClient(() => unknownMessage()).client,
      lookupUserName,
    });
    expect(lookupUserName).toHaveBeenCalledTimes(2);
    if (result.kind !== 'OK') throw new Error('expected OK');
    expect(result.items.map((item) => item.authorName)).toEqual(['samename', 'samename', 'samename', null]);
  });

  test('twenty rows make forty reads, never more than four at once', async () => {
    const guildId = await configuredGuild();
    const rows: Seeded[] = [];
    for (let i = 0; i < 20; i++) rows.push(await seedRow(guildId));
    const stub = stubClient(() => unknownMessage());
    const result = await loadArchiveContent({
      guildId,
      sourceMessageIds: rows.map((row) => row.sourceMessageId),
      client: stub.client,
      lookupUserName: async () => null,
    });
    expect(result.kind).toBe('OK');
    expect(stub.request).toHaveBeenCalledTimes(40);
    expect(stub.maxInFlight()).toBeLessThanOrEqual(4);
    expect(stub.maxInFlight()).toBeGreaterThan(1);
  });

  test('ids outside this guild\'s ACTIVE rows get no Discord call and no item; the rest still load', async () => {
    const guildId = await configuredGuild();
    const otherGuild = await configuredGuild();
    const mine = await seedRow(guildId);
    const foreign = await seedRow(otherGuild);
    const pending = await seedRow(guildId, { status: 'PENDING' });
    const removed = await seedRow(guildId, { status: 'REMOVED_BY_AUTHOR' });
    const stub = stubClient(() => unknownMessage());

    const result = await loadArchiveContent({
      guildId,
      sourceMessageIds: [mine.sourceMessageId, foreign.sourceMessageId, pending.sourceMessageId, removed.sourceMessageId],
      client: stub.client,
      lookupUserName: async () => null,
    });

    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') throw new Error('expected OK');
    expect(result.items.map((item) => item.sourceMessageId)).toEqual([mine.sourceMessageId]);
    // Two reads for the one ACTIVE row of this guild, none for the others.
    expect(stub.request).toHaveBeenCalledTimes(2);
    expect(stub.request.mock.calls.every(([, path]) => !path.includes(foreign.forwardId))).toBe(true);
  });

  test('a structurally bad batch is refused before any Discord call', async () => {
    const guildId = await configuredGuild();
    const mine = await seedRow(guildId);
    const stub = stubClient(() => ({}));
    const attempt = (ids: string[]) =>
      loadArchiveContent({ guildId, sourceMessageIds: ids, client: stub.client, lookupUserName: async () => null });

    expect(await attempt([])).toEqual({ kind: 'INVALID' });
    expect(await attempt([mine.sourceMessageId, mine.sourceMessageId])).toEqual({ kind: 'INVALID' });
    expect(await attempt(Array.from({ length: 21 }, (_, i) => `id${i}`))).toEqual({ kind: 'INVALID' });
    expect(stub.request).not.toHaveBeenCalled();
  });

  test('an unconfigured guild is refused', async () => {
    const guildId = fakeSnowflake();
    cleanupGuildIds.push(guildId);
    const row = await seedRow(guildId);
    const stub = stubClient(() => ({}));
    expect(
      await loadArchiveContent({
        guildId,
        sourceMessageIds: [row.sourceMessageId],
        client: stub.client,
        lookupUserName: async () => null,
      }),
    ).toEqual({ kind: 'INVALID' });
    expect(stub.request).not.toHaveBeenCalled();
  });
});
