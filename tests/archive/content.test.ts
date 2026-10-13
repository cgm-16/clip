import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
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

// The archive channel's one history read (its path carries a query string)
// goes to `history`; every per-row read goes to `handler`. An empty history
// is what Discord answers without Read Message History, so every row falls
// back to its own reads.
function stubClient(handler: Handler, history: Handler = () => []) {
  let inFlight = 0;
  let maxInFlight = 0;
  const request = vi.fn(async (_method: string, path: string) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    const result = path.includes('?') ? history(path) : handler(path);
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

  // A failed Discord read logs one line. Stubbing keeps test output pristine;
  // the logging tests below assert on the captured lines.
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
    options: { authorUserId?: string; status?: 'ACTIVE' | 'PENDING' | 'REMOVED_BY_AUTHOR'; forwardId?: string } = {},
  ): Promise<Seeded> {
    const status = options.status ?? 'ACTIVE';
    const row = {
      sourceMessageId: numericSnowflake(),
      sourceChannelId: fakeSnowflake(),
      forwardId: options.forwardId ?? numericSnowflake(),
    };
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
    };
  }

  async function loadOne(row: Seeded, guildId: string, handler: Handler, history?: Handler) {
    const stub = stubClient(handler, history);
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

  test('a ready row splits code, keeps safe attachments and embeds', async () => {
    const guildId = await configuredGuild();
    const row = await seedRow(guildId);
    const { forward } = paths(row);
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
      throw new Error(`unexpected ${path}`);
    });

    expect(item).toEqual({
      sourceMessageId: row.sourceMessageId,
      state: 'ready',
      authorName: 'ori',
      originalAt: '2026-10-01T09:00:00.000Z',
      original: 'unknown',
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
      replyToAuthorName: null,
    });
  });

  test('makes no read of the source message; original and reply author stay unknown', async () => {
    const guildId = await configuredGuild();
    const row = await seedRow(guildId);
    const { forward } = paths(row);
    const stub = stubClient((path) => (path === forward ? snapshot({ content: 'hi' }) : {}));
    const result = await loadArchiveContent({
      guildId,
      sourceMessageIds: [row.sourceMessageId],
      client: stub.client,
      lookupUserName: async () => 'ori',
    });

    expect(stub.request.mock.calls.filter(([, path]) => path.startsWith(`/channels/${row.sourceChannelId}/messages/`))).toEqual([]);
    expect(result).toMatchObject({ kind: 'OK', items: [{ state: 'ready', original: 'unknown', replyToAuthorName: null }] });
  });

  test('a confirmed unknown forward is missing, dated from the snowflake', async () => {
    const guildId = await configuredGuild();
    const row = await seedRow(guildId);
    const item = await loadOne(row, guildId, () => unknownMessage());
    expect(item).toMatchObject({ state: 'missing', original: 'unknown', originalAt: snowflakeTime(row.sourceMessageId) });
  });

  test('missing access is an access error, never missing', async () => {
    const guildId = await configuredGuild();
    const row = await seedRow(guildId);
    const { forward } = paths(row);
    const item = await loadOne(row, guildId, (path) => (path === forward ? missingAccess() : {}));
    expect(item).toMatchObject({ state: 'error', reason: 'access', original: 'unknown' });
  });

  test('a timeout is transient', async () => {
    const guildId = await configuredGuild();
    const row = await seedRow(guildId);
    const item = await loadOne(row, guildId, () => new DOMException('timed out', 'TimeoutError'));
    expect(item).toMatchObject({ state: 'error', reason: 'transient', original: 'unknown' });
  });

  const SENTINEL_MESSAGE = 'SENTINEL-MSG body: SENTINEL-BODY';

  function rawLogLines(): string[] {
    return vi.mocked(console.log).mock.calls.map(([line]) => String(line));
  }

  test('a failed forward read logs its step and HTTP status, never the message', async () => {
    const guildId = await configuredGuild();
    const row = await seedRow(guildId);
    const { forward } = paths(row);
    await loadOne(row, guildId, (path) =>
      path === forward ? new DiscordApiError(SENTINEL_MESSAGE, { status: 503, code: null }) : {},
    );

    const lines = rawLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('SENTINEL');
    expect(JSON.parse(lines[0])).toEqual({
      event: 'archive.content_read_failed',
      guildId,
      sourceMessageId: row.sourceMessageId,
      step: 'forward_read',
      failure: 'http',
      httpStatus: '503',
    });
  });

  test('a timed-out forward read logs one line, never the message', async () => {
    const guildId = await configuredGuild();
    const row = await seedRow(guildId);
    await loadOne(row, guildId, () => new DOMException(SENTINEL_MESSAGE, 'TimeoutError'));

    const lines = rawLogLines();
    expect(lines.join('\n')).not.toContain('SENTINEL');
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        event: 'archive.content_read_failed',
        guildId,
        sourceMessageId: row.sourceMessageId,
        step: 'forward_read',
        failure: 'timeout',
      },
    ]);
  });

  test('successful reads log nothing', async () => {
    const guildId = await configuredGuild();
    const row = await seedRow(guildId);
    const { forward } = paths(row);
    await loadOne(row, guildId, (path) => (path === forward ? snapshot({ content: 'hi' }) : {}));

    expect(rawLogLines()).toEqual([]);
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

  test('twenty rows absent from the history make one history read and twenty row reads, never more than four at once', async () => {
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
    expect(stub.request).toHaveBeenCalledTimes(21);
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
    // The history read plus one forward read for the one ACTIVE row of this
    // guild, none for the others.
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
  describe('one history read of the archive channel', () => {
    // A forward as Get Channel Messages lists it: the full message, carrying its snapshot.
    function listed(row: Seeded, content: string) {
      return { ...snapshot({ content }), id: row.forwardId };
    }

    function historyPath(after: string) {
      return `/channels/${ARCHIVE_CHANNEL}/messages?after=${after}&limit=100`;
    }

    function lowestForwardId(rows: Seeded[]): bigint {
      return rows.map((row) => BigInt(row.forwardId)).reduce((a, b) => (a < b ? a : b));
    }

    function calledPaths(stub: ReturnType<typeof stubClient>): string[] {
      return stub.request.mock.calls.map(([, path]) => path);
    }

    async function load(guildId: string, rows: Seeded[], stub: ReturnType<typeof stubClient>) {
      const result = await loadArchiveContent({
        guildId,
        sourceMessageIds: rows.map((row) => row.sourceMessageId),
        client: stub.client,
        lookupUserName: async () => null,
      });
      if (result.kind !== 'OK') throw new Error('expected OK');
      return result.items;
    }

    test('forwards found in the history make no per-row forward read', async () => {
      const guildId = await configuredGuild();
      const rows = [await seedRow(guildId), await seedRow(guildId), await seedRow(guildId)];
      const stub = stubClient(
        (path) => (rows.some((row) => path === paths(row).forward) ? new Error(`unexpected ${path}`) : {}),
        () => rows.map((row, i) => listed(row, `body ${i}`)),
      );

      const items = await load(guildId, rows, stub);

      const after = String(lowestForwardId(rows) - 1n);
      expect(calledPaths(stub).filter((path) => path.includes('?'))).toEqual([historyPath(after)]);
      expect(calledPaths(stub).filter((path) => path.startsWith(`/channels/${ARCHIVE_CHANNEL}/`))).toEqual([
        historyPath(after),
      ]);
      expect(items.map((item) => (item.state === 'ready' ? item.body : item.state))).toEqual([
        [{ kind: 'text', text: 'body 0' }],
        [{ kind: 'text', text: 'body 1' }],
        [{ kind: 'text', text: 'body 2' }],
      ]);
      expect(rawLogLines()).toEqual([]);
    });

    test('only forwards absent from the history get a per-row read', async () => {
      const guildId = await configuredGuild();
      const found = await seedRow(guildId);
      const absent = await seedRow(guildId);
      const stub = stubClient(
        (path) => (path === paths(absent).forward ? snapshot({ content: 'read alone' }) : {}),
        () => [listed(found, 'from history')],
      );

      const items = await load(guildId, [found, absent], stub);

      const forwardReads = calledPaths(stub).filter((path) => path.startsWith(`/channels/${ARCHIVE_CHANNEL}/messages/`));
      expect(forwardReads).toEqual([paths(absent).forward]);
      expect(items).toMatchObject([
        { sourceMessageId: found.sourceMessageId, state: 'ready', body: [{ kind: 'text', text: 'from history' }] },
        { sourceMessageId: absent.sourceMessageId, state: 'ready', body: [{ kind: 'text', text: 'read alone' }] },
      ]);
    });

    test('an empty history (no Read Message History) never makes a row missing', async () => {
      const guildId = await configuredGuild();
      const row = await seedRow(guildId);
      const stub = stubClient((path) => (path === paths(row).forward ? snapshot({ content: 'still here' }) : {}), () => []);

      const items = await load(guildId, [row], stub);

      expect(calledPaths(stub)).toContain(paths(row).forward);
      expect(items).toMatchObject([{ state: 'ready', body: [{ kind: 'text', text: 'still here' }] }]);
    });

    test('a failed history read (missing access) logs one line and every row falls back', async () => {
      const guildId = await configuredGuild();
      const rows = [await seedRow(guildId), await seedRow(guildId)];
      const stub = stubClient(
        (path) => (rows.some((row) => path === paths(row).forward) ? snapshot({ content: 'fallback' }) : {}),
        () => new DiscordApiError(SENTINEL_MESSAGE, { status: 403, code: 50001 }),
      );

      const items = await load(guildId, rows, stub);

      expect(calledPaths(stub)).toEqual(expect.arrayContaining(rows.map((row) => paths(row).forward)));
      expect(items.map((item) => item.state)).toEqual(['ready', 'ready']);
      const lines = rawLogLines();
      expect(lines.join('\n')).not.toContain('SENTINEL');
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        {
          event: 'archive.content_read_failed',
          guildId,
          step: 'forward_history_read',
          failure: 'http',
          httpStatus: '403',
          discordCode: '50001',
        },
      ]);
    });

    test('a rate-limited history read makes no per-row forward read; every row is transient', async () => {
      const guildId = await configuredGuild();
      const rows = [await seedRow(guildId), await seedRow(guildId)];
      const stub = stubClient(
        (path) => (rows.some((row) => path === paths(row).forward) ? new Error(`unexpected ${path}`) : {}),
        () => new DiscordApiError(SENTINEL_MESSAGE, { status: 429, code: null }),
      );

      const items = await load(guildId, rows, stub);

      expect(calledPaths(stub).filter((path) => path.startsWith(`/channels/${ARCHIVE_CHANNEL}/messages/`))).toEqual([]);
      expect(items).toMatchObject([
        { state: 'error', reason: 'transient', original: 'unknown' },
        { state: 'error', reason: 'transient', original: 'unknown' },
      ]);
      const lines = rawLogLines();
      expect(lines.join('\n')).not.toContain('SENTINEL');
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        { event: 'archive.content_read_failed', guildId, step: 'forward_history_read', failure: 'http', httpStatus: '429' },
      ]);
    });

    test('unrelated channel messages in the history never reach an item', async () => {
      const guildId = await configuredGuild();
      const row = await seedRow(guildId);
      const stub = stubClient(
        () => ({}),
        () => [
          { id: numericSnowflake(), content: 'CHATTER-SECRET', author: { username: 'someone' } },
          { ...snapshot({ content: 'OTHER-FORWARD-SECRET' }), id: numericSnowflake() },
          listed(row, 'mine'),
          { id: numericSnowflake(), content: 'PROVENANCE-SECRET' },
        ],
      );

      const items = await load(guildId, [row], stub);

      expect(calledPaths(stub)).not.toContain(paths(row).forward);
      expect(items).toMatchObject([{ state: 'ready', body: [{ kind: 'text', text: 'mine' }] }]);
      expect(JSON.stringify(items)).not.toMatch(/SECRET/);
    });

    test('`after` is the lowest forward id minus one, exact for 19-digit snowflakes', async () => {
      const guildId = await configuredGuild();
      // Numerically lowest but lexically highest; neither id survives a Number round trip.
      const rows = [
        await seedRow(guildId, { forwardId: '1500000000000000123' }),
        await seedRow(guildId, { forwardId: '999999999999999999' }),
      ];
      const stub = stubClient(() => ({}), () => []);

      await load(guildId, rows, stub);

      expect(calledPaths(stub).filter((path) => path.includes('?'))).toEqual([historyPath('999999999999999998')]);
    });
  });
});
