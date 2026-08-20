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
 * A fetch double keyed by which resource the URL addresses, rather than by
 * call order. The two GETs this module issues have no ordering relationship
 * to each other, so routing by call order would make the tests brittle to a
 * harmless reordering of the implementation.
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
