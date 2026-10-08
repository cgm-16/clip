import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/admin-session/tokens';
import { GuildLookupFailedError, GuildUnavailableError } from '@/lib/discord/guild-lookup';

const authenticateAdminSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/admin-session/service', () => ({ authenticateAdminSession }));

const getGuildSetupChannels = vi.hoisted(() => vi.fn());
const getGuildRoles = vi.hoisted(() => vi.fn());
const getGuildName = vi.hoisted(() => vi.fn());
const getUserHandle = vi.hoisted(() => vi.fn());
const createDiscordGuildLookup = vi.hoisted(() =>
  vi.fn(() => ({ getGuildSetupChannels, getGuildRoles, getGuildName, getUserHandle })),
);
vi.mock('@/lib/discord/guild-lookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/discord/guild-lookup')>();
  return { ...actual, createDiscordGuildLookup };
});

const findGuildArchiveConfig = vi.hoisted(() => vi.fn());
vi.mock('@/lib/clip/repository', () => ({ findGuildArchiveConfig }));

const { GET } = await import('@/app/setup/data/route');

const BASE_URL = 'https://clipendpoint.cc';
const GUILD_ID = '1539212298600718416';
const USER_ID = '1539212298600718417';
const ROLE_ID = '1539212298600718666';

function stubEnv(): void {
  vi.stubEnv('DATABASE_URL', 'postgresql://clip:pw@localhost:5433/clip_dev');
  vi.stubEnv('DISCORD_APPLICATION_ID', '1539212298600718888');
  vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
  vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-value');
  vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
  vi.stubEnv('PUBLIC_BASE_URL', BASE_URL);
}

function get(withCookie = true): NextRequest {
  return new NextRequest(`${BASE_URL}/setup/data`, {
    headers: withCookie ? { Cookie: `${ADMIN_SESSION_COOKIE_NAME}=session-bearer` } : {},
  });
}

describe('GET /setup/data', () => {
  beforeEach(() => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    getGuildSetupChannels.mockResolvedValue([{ id: '111', name: 'general', type: 0 }]);
    getGuildRoles.mockResolvedValue([
      { id: GUILD_ID, name: '@everyone', permissions: 1024n },
      { id: ROLE_ID, name: 'moderator', permissions: 0n },
    ]);
    getGuildName.mockResolvedValue('Test guild');
    getUserHandle.mockResolvedValue('admin');
    findGuildArchiveConfig.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  test('an unconfigured guild gets its channels, roles, identity and no config', async () => {
    const response = await GET(get());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      guildId: GUILD_ID,
      guildName: 'Test guild',
      adminHandle: 'admin',
      channels: [{ id: '111', name: 'general', type: 0 }],
      roles: [
        { id: GUILD_ID, name: '@everyone', selectable: false },
        { id: ROLE_ID, name: 'moderator', selectable: true },
      ],
      config: null,
      archiveChannelMissing: false,
    });
    expect(getUserHandle).toHaveBeenCalledWith(USER_ID);
  });

  test('a configured guild gets its current channel and allowed roles', async () => {
    findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: '111', allowedRoleIds: [ROLE_ID] });

    const body = await (await GET(get())).json();

    expect(body.config).toEqual({ archiveChannelId: '111', allowedRoleIds: [ROLE_ID] });
    expect(findGuildArchiveConfig).toHaveBeenCalledWith(GUILD_ID);
  });

  test('flags a configured archive channel that Discord no longer lists (#58)', async () => {
    findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: 'gone', allowedRoleIds: [], configurationId: 'c' });
    expect((await (await GET(get())).json()).archiveChannelMissing).toBe(true);
  });

  test('a listed archive channel is not missing', async () => {
    findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: '111', allowedRoleIds: [], configurationId: 'c' });
    expect((await (await GET(get())).json()).archiveChannelMissing).toBe(false);
  });

  test('never sends the internal configurationId to the browser', async () => {
    findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: '111', allowedRoleIds: [ROLE_ID], configurationId: 'secret-id' });
    const body = await (await GET(get())).json();
    expect(body.config).toEqual({ archiveChannelId: '111', allowedRoleIds: [ROLE_ID] });
  });

  test('display names fall back to null without failing the request', async () => {
    getGuildName.mockResolvedValue(null);
    getUserHandle.mockResolvedValue(null);

    const response = await GET(get());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ guildName: null, adminHandle: null });
  });

  test('is private and never cached', async () => {
    const response = await GET(get());

    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  test('no session is 401', async () => {
    expect((await GET(get(false))).status).toBe(401);
    authenticateAdminSession.mockResolvedValue(null);
    expect((await GET(get())).status).toBe(401);
  });

  test('a guild the bot cannot see is 404 and other lookup failures are 502', async () => {
    getGuildRoles.mockRejectedValueOnce(new GuildUnavailableError('gone'));
    expect((await GET(get())).status).toBe(404);
    getGuildRoles.mockRejectedValueOnce(new GuildLookupFailedError('down', { retryable: true }));
    expect((await GET(get())).status).toBe(502);
  });
});
