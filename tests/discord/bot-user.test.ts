import { describe, expect, test } from 'vitest';
import { getDiscordBotUserId } from '@/lib/discord/bot-user';

const BOT_TOKEN = 'bot-token-value';
const BOT_USER_ID = '1539212298600718999';

const CURRENT_USER = {
  id: BOT_USER_ID,
  username: 'clip',
  discriminator: '0',
  global_name: 'Clip',
  avatar: null,
  bot: true,
  flags: 0,
  public_flags: 0,
  avatar_decoration_data: null,
  collectibles: null,
  primary_guild: null,
  clan: null,
  mfa_enabled: false,
  banner: null,
  accent_color: null,
  locale: 'en-US',
  verified: true,
  email: null,
};

function fetchReturning(body: unknown) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

describe('getDiscordBotUserId', () => {
  test('gets the authenticated bot user id from /users/@me', async () => {
    const { fetchImpl, calls } = fetchReturning(CURRENT_USER);

    const result = await getDiscordBotUserId({ botToken: BOT_TOKEN, fetchImpl });

    expect(result).toBe(BOT_USER_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://discord.com/api/v10/users/@me',
    });
    expect(calls[0].headers.get('Authorization')).toBe(`Bot ${BOT_TOKEN}`);
  });

  test.each([{ ...CURRENT_USER, id: undefined }, { ...CURRENT_USER, id: '' }, { ...CURRENT_USER, id: 123 }])(
    'returns null when /users/@me has no non-empty string id',
    async (body) => {
      const { fetchImpl } = fetchReturning(body);

      await expect(getDiscordBotUserId({ botToken: BOT_TOKEN, fetchImpl })).resolves.toBeNull();
    },
  );
});
