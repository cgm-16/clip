import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createDiscordGuildLookup,
  GuildLookupFailedError,
  GuildUnavailableError,
} from '@/lib/discord/guild-lookup';
import { DISCORD_ERROR } from '@/lib/discord/rest-client';

const BOT_TOKEN = 'bot-token-value';
const GUILD_ID = '1539212298600718416';

const TEXT_CHANNEL_ID = '2000000000000000001';
const ANNOUNCEMENT_CHANNEL_ID = '2000000000000000002';
const VOICE_CHANNEL_ID = '2000000000000000003';
const CATEGORY_CHANNEL_ID = '2000000000000000004';

// Discord channel types (developers.discord.com/docs/resources/channel#channel-object-channel-types).
const GUILD_TEXT = 0;
const GUILD_VOICE = 2;
const GUILD_CATEGORY = 4;
const GUILD_ANNOUNCEMENT = 5;

/**
 * A full channel payload, the way Discord actually sends it. `topic`,
 * `position` and `permission_overwrites` are fields this module must not
 * pass through -- narrowing at the parse boundary is what stops them.
 */
function rawChannel(id: string, name: string, type: number) {
  return {
    id,
    name,
    type,
    guild_id: GUILD_ID,
    position: 3,
    topic: 'incidental channel description',
    nsfw: false,
    permission_overwrites: [{ id: GUILD_ID, type: 0, allow: '0', deny: '2048' }],
    parent_id: null,
    rate_limit_per_user: 0,
  };
}

type StubResponse = { status: number; body: unknown };

function json(body: unknown, status = 200): StubResponse {
  return { status, body };
}

type Call = { url: string; method: string; headers: Headers };

/**
 * A fetch double that records the requested resource and fails on unexpected
 * URLs, so the tests assert the lookup's HTTP boundary instead of returning a
 * canned response regardless of what the implementation requested.
 */
function stubFetch(routes: { channels?: StubResponse }) {
  const calls: Call[] = [];

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });

    const route = href.includes('/channels') ? routes.channels : undefined;
    if (route === undefined) {
      throw new Error(`unexpected fetch call: ${href}`);
    }
    return new Response(route.body === null ? null : JSON.stringify(route.body), {
      status: route.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getGuildSetupChannels', () => {
  test('requests only the guild channel list and returns narrowed channels', async () => {
    const { fetchImpl, calls } = stubFetch({
      channels: json([rawChannel(TEXT_CHANNEL_ID, 'general', GUILD_TEXT)]),
    });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    const result = await lookup.getGuildSetupChannels(GUILD_ID);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `https://discord.com/api/v10/guilds/${GUILD_ID}/channels`,
    });
    expect(calls[0].headers.get('Authorization')).toBe(`Bot ${BOT_TOKEN}`);
    expect(calls.some((call) => call.url.endsWith('/roles'))).toBe(false);
    expect(result).toEqual([{ id: TEXT_CHANNEL_ID, name: 'general', type: GUILD_TEXT }]);
  });

  test('keeps text and announcement-adjacent filtering: GUILD_TEXT is included', async () => {
    const { fetchImpl } = stubFetch({
      channels: json([rawChannel(TEXT_CHANNEL_ID, 'general', GUILD_TEXT)]),
    });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    const result = await lookup.getGuildSetupChannels(GUILD_ID);

    expect(result.map((c) => c.id)).toEqual([TEXT_CHANNEL_ID]);
  });

  test('excludes channel types the bot cannot post plain messages in', async () => {
    const { fetchImpl } = stubFetch({
      channels: json([
        rawChannel(TEXT_CHANNEL_ID, 'general', GUILD_TEXT),
        rawChannel(ANNOUNCEMENT_CHANNEL_ID, 'announcements', GUILD_ANNOUNCEMENT),
        rawChannel(VOICE_CHANNEL_ID, 'voice', GUILD_VOICE),
        rawChannel(CATEGORY_CHANNEL_ID, 'category', GUILD_CATEGORY),
      ]),
    });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    const result = await lookup.getGuildSetupChannels(GUILD_ID);

    expect(result.map((c) => c.id)).toEqual([TEXT_CHANNEL_ID]);
  });

  test('maps an unknown guild (10004) to GuildUnavailableError', async () => {
    const { fetchImpl } = stubFetch({
      channels: json({ code: 10004, message: 'Unknown Guild' }, 404),
    });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    await expect(lookup.getGuildSetupChannels(GUILD_ID)).rejects.toBeInstanceOf(
      GuildUnavailableError
    );
  });

  test('maps a guild the bot cannot access (50001) to GuildUnavailableError', async () => {
    const { fetchImpl } = stubFetch({
      channels: json({ code: DISCORD_ERROR.MISSING_ACCESS, message: 'Missing Access' }, 403),
    });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    await expect(lookup.getGuildSetupChannels(GUILD_ID)).rejects.toBeInstanceOf(
      GuildUnavailableError
    );
  });

  test('a generic failure maps to a retryable GuildLookupFailedError', async () => {
    const { fetchImpl } = stubFetch({
      channels: json({ code: 0, message: 'Internal Server Error' }, 500),
    });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    const error = await lookup.getGuildSetupChannels(GUILD_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GuildLookupFailedError);
    expect((error as GuildLookupFailedError).retryable).toBe(true);
  });

  test('no log line carries a channel topic', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetchImpl } = stubFetch({
      channels: json([rawChannel(TEXT_CHANNEL_ID, 'general', GUILD_TEXT)]),
    });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    await lookup.getGuildSetupChannels(GUILD_ID);

    const written = [...log.mock.calls, ...error.mock.calls].flat().map(String).join('\n');
    expect(written).not.toContain('incidental channel description');
  });
});

const BOT_USER_ID = '3000000000000000001';
const ROLE_ID = '4000000000000000001';

/**
 * Like `stubFetch`, but routes by exact API path so each method's single
 * request is asserted, and anything else fails loudly.
 */
function stubPaths(routes: Record<string, StubResponse>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    const path = href.replace('https://discord.com/api/v10', '');
    const route = routes[path];
    if (route === undefined) {
      throw new Error(`unexpected fetch call: ${href}`);
    }
    return new Response(route.body === null ? null : JSON.stringify(route.body), {
      status: route.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('getGuildRoles', () => {
  test('returns id, name and BigInt permissions only, skipping malformed roles', async () => {
    const { fetchImpl, calls } = stubPaths({
      [`/guilds/${GUILD_ID}/roles`]: json([
        { id: GUILD_ID, name: '@everyone', permissions: '1024', color: 0, icon: null, tags: {} },
        { id: ROLE_ID, name: 'moderator', permissions: '9007199254740993', managed: false },
        { id: '4000000000000000002', name: 'broken', permissions: 1024 },
      ]),
    });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    const roles = await lookup.getGuildRoles(GUILD_ID);

    expect(calls).toHaveLength(1);
    expect(roles).toEqual([
      { id: GUILD_ID, name: '@everyone', permissions: 1024n },
      { id: ROLE_ID, name: 'moderator', permissions: 9007199254740993n },
    ]);
  });

  test('maps an unknown guild (10004) to GuildUnavailableError', async () => {
    const { fetchImpl } = stubPaths({
      [`/guilds/${GUILD_ID}/roles`]: json({ code: 10004, message: 'Unknown Guild' }, 404),
    });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    await expect(lookup.getGuildRoles(GUILD_ID)).rejects.toBeInstanceOf(GuildUnavailableError);
  });
});

describe('getChannelOverwrites', () => {
  test('returns only role/member overwrites with BigInt allow and deny', async () => {
    const { fetchImpl } = stubPaths({
      [`/channels/${TEXT_CHANNEL_ID}`]: json({
        ...rawChannel(TEXT_CHANNEL_ID, 'general', GUILD_TEXT),
        permission_overwrites: [
          { id: GUILD_ID, type: 0, allow: '0', deny: '1024' },
          { id: BOT_USER_ID, type: 1, allow: '3072', deny: '0' },
        ],
      }),
    });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    expect(await lookup.getChannelOverwrites(TEXT_CHANNEL_ID)).toEqual([
      { id: GUILD_ID, type: 0, allow: 0n, deny: 1024n },
      { id: BOT_USER_ID, type: 1, allow: 3072n, deny: 0n },
    ]);
  });

  // Reading unreadable overwrites as "none" would let a deny the bot is
  // subject to go unseen, so the permission check must fail closed.
  test('throws GuildLookupFailedError when the channel carries no permission_overwrites', async () => {
    const { permission_overwrites: _omitted, ...channel } = rawChannel(TEXT_CHANNEL_ID, 'general', GUILD_TEXT);
    const { fetchImpl } = stubPaths({ [`/channels/${TEXT_CHANNEL_ID}`]: json(channel) });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    await expect(lookup.getChannelOverwrites(TEXT_CHANNEL_ID)).rejects.toBeInstanceOf(
      GuildLookupFailedError,
    );
  });

  test.each([
    ['an unknown type', { id: BOT_USER_ID, type: 7, allow: '0', deny: '1024' }],
    ['a non-string allow', { id: BOT_USER_ID, type: 1, allow: 0, deny: '1024' }],
  ])('throws GuildLookupFailedError when one overwrite has %s', async (_name, malformed) => {
    const { fetchImpl } = stubPaths({
      [`/channels/${TEXT_CHANNEL_ID}`]: json({
        ...rawChannel(TEXT_CHANNEL_ID, 'general', GUILD_TEXT),
        permission_overwrites: [{ id: GUILD_ID, type: 0, allow: '0', deny: '0' }, malformed],
      }),
    });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    await expect(lookup.getChannelOverwrites(TEXT_CHANNEL_ID)).rejects.toBeInstanceOf(
      GuildLookupFailedError,
    );
  });
});

describe('getMemberRoleIds', () => {
  test("returns the member's role ids", async () => {
    const { fetchImpl } = stubPaths({
      [`/guilds/${GUILD_ID}/members/${BOT_USER_ID}`]: json({
        user: { id: BOT_USER_ID, username: 'Clip' },
        roles: [ROLE_ID],
        nick: null,
      }),
    });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    expect(await lookup.getMemberRoleIds(GUILD_ID, BOT_USER_ID)).toEqual([ROLE_ID]);
  });
});

describe('display lookups', () => {
  test('getGuildName returns the guild name', async () => {
    const { fetchImpl } = stubPaths({ [`/guilds/${GUILD_ID}`]: json({ id: GUILD_ID, name: 'Test guild' }) });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    expect(await lookup.getGuildName(GUILD_ID)).toBe('Test guild');
  });

  test('getGuildName falls back to null when the lookup fails', async () => {
    const { fetchImpl } = stubPaths({ [`/guilds/${GUILD_ID}`]: json({ code: 50001 }, 403) });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    expect(await lookup.getGuildName(GUILD_ID)).toBeNull();
  });

  test('getUserHandle returns the username', async () => {
    const { fetchImpl } = stubPaths({ [`/users/${BOT_USER_ID}`]: json({ id: BOT_USER_ID, username: 'admin' }) });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    expect(await lookup.getUserHandle(BOT_USER_ID)).toBe('admin');
  });

  test('getUserHandle falls back to null when the user is unknown', async () => {
    const { fetchImpl } = stubPaths({ [`/users/${BOT_USER_ID}`]: json({ code: 10013 }, 404) });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });

    expect(await lookup.getUserHandle(BOT_USER_ID)).toBeNull();
  });
});

describe('getGuildChannelNames', () => {
  test('names every channel type, for display', async () => {
    const { fetchImpl } = stubFetch({
      channels: json([
        rawChannel('100', 'general', 0),
        rawChannel('200', 'voice', 2),
        rawChannel('300', 'news', 5),
      ]),
    });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl });
    expect(await lookup.getGuildChannelNames(GUILD_ID)).toEqual({ '100': 'general', '200': 'voice', '300': 'news' });
  });

  test('is empty when the lookup fails', async () => {
    const { fetchImpl } = stubFetch({ channels: json({ message: 'nope' }, 500) });
    const lookup = createDiscordGuildLookup({ botToken: BOT_TOKEN, fetchImpl, sleep: async () => {} });
    expect(await lookup.getGuildChannelNames(GUILD_ID)).toEqual({});
  });
});
