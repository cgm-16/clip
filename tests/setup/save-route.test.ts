import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/admin-session/tokens';
import { GuildLookupFailedError, GuildUnavailableError } from '@/lib/discord/guild-lookup';
import { PERMISSION } from '@/lib/discord/permissions';
import { DiscordApiError } from '@/lib/discord/rest-client';

const authenticateAdminSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/admin-session/service', () => ({
  authenticateAdminSession,
  sessionTokenHash: (token: string) => `session-hash:${token}`,
}));

const getGuildSetupChannels = vi.hoisted(() => vi.fn());
const getGuildRoles = vi.hoisted(() => vi.fn());
const getChannelOverwrites = vi.hoisted(() => vi.fn());
const getMemberRoleIds = vi.hoisted(() => vi.fn());
const isChannelGone = vi.hoisted(() => vi.fn());
const createDiscordGuildLookup = vi.hoisted(() =>
  vi.fn(() => ({ getGuildSetupChannels, getGuildRoles, getChannelOverwrites, getMemberRoleIds, isChannelGone })),
);
vi.mock('@/lib/discord/guild-lookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/discord/guild-lookup')>();
  return { ...actual, createDiscordGuildLookup };
});

const discordRequest = vi.hoisted(() => vi.fn());
const createDiscordRestClient = vi.hoisted(() => vi.fn(() => ({ request: discordRequest })));
vi.mock('@/lib/discord/rest-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/discord/rest-client')>();
  return { ...actual, createDiscordRestClient };
});

const upsertGuildArchiveConfig = vi.hoisted(() => vi.fn());
const finalizeGuildArchiveConfig = vi.hoisted(() => vi.fn());
const countArchivedClips = vi.hoisted(() => vi.fn());
const findGuildArchiveConfig = vi.hoisted(() => vi.fn());
const findArchiveChangeBlocker = vi.hoisted(() => vi.fn());
vi.mock('@/lib/clip/repository', () => ({
  upsertGuildArchiveConfig,
  finalizeGuildArchiveConfig,
  countArchivedClips,
  findGuildArchiveConfig,
  findArchiveChangeBlocker,
}));

const { POST } = await import('@/app/setup/save/route');

const BASE_URL = 'https://clipendpoint.cc';
const GUILD_ID = '1539212298600718416';
const OTHER_GUILD_ID = '1539212298600718499';
const USER_ID = '1539212298600718417';
// Deliberately distinct: the application id belongs to application endpoints,
// the bot user id belongs to the member overwrite, and the guild id identifies
// the @everyone role. Shared literals could let the wrong target pass.
const APPLICATION_ID = '1539212298600718888';
const BOT_USER_ID = '1539212298600718999';
const SESSION_COOKIE = `${ADMIN_SESSION_COOKIE_NAME}=session-bearer`;
const BOT_ROLE_ID = '1539212298600718777';
const MOD_ROLE_ID = '1539212298600718666';
const ARCHIVE_PERMISSIONS =
  PERMISSION.VIEW_CHANNEL | PERMISSION.SEND_MESSAGES | PERMISSION.READ_MESSAGE_HISTORY;

// Only the paths that reach parseEnv (an Origin header present, or code past
// the session/body checks) need a full env -- same reasoning as
// tests/admin-session/exchange-route.test.ts's stubEnv.
function stubEnv(): void {
  vi.stubEnv('DATABASE_URL', 'postgresql://clip:pw@localhost:5433/clip_dev');
  vi.stubEnv('DISCORD_APPLICATION_ID', APPLICATION_ID);
  vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
  vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-value');
  vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
  vi.stubEnv('PUBLIC_BASE_URL', BASE_URL);
}

function postJson(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${BASE_URL}/setup/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: SESSION_COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /setup/save', () => {
  beforeEach(() => {
    // Default to "first setup for this guild, no live Clips yet" so every
    // test that does not care about the C3 reconfiguration guard does not
    // have to restate it -- `vi.resetAllMocks()` below wipes these between
    // tests, so they are reinstated on every run rather than set once.
    findGuildArchiveConfig.mockResolvedValue(null);
    findArchiveChangeBlocker.mockResolvedValue(null);
    finalizeGuildArchiveConfig.mockResolvedValue({ kind: 'SAVED' });
    // Default: a bot whose managed role can use any channel without overwrites.
    getGuildRoles.mockResolvedValue([
      { id: GUILD_ID, name: '@everyone', permissions: 0n, managed: false },
      { id: BOT_ROLE_ID, name: 'Clip', permissions: ARCHIVE_PERMISSIONS, managed: true },
      { id: MOD_ROLE_ID, name: 'moderator', permissions: 0n, managed: false },
    ]);
    getMemberRoleIds.mockResolvedValue([BOT_ROLE_ID]);
    getChannelOverwrites.mockResolvedValue([]);
    discordRequest.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/users/@me') {
        return { id: BOT_USER_ID };
      }
      if (method === 'POST' && path === `/guilds/${GUILD_ID}/channels`) {
        return { id: '222', name: 'clip-archive', type: 0 };
      }
      if (method === 'DELETE' && path === '/channels/222') {
        return undefined;
      }
      throw new Error(`unexpected Discord request: ${method} ${path}`);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  test('no session cookie is refused with 401 before touching auth', async () => {
    const response = await POST(
      new NextRequest(`${BASE_URL}/setup/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination: 'create', channelId: null }),
      }),
    );
    expect(response.status).toBe(401);
    expect(authenticateAdminSession).not.toHaveBeenCalled();
  });

  test('a session cookie that does not resolve is refused with 401', async () => {
    authenticateAdminSession.mockResolvedValue(null);

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(401);
  });

  test('a malformed body ("existing" with no channelId) is rejected before any Discord or DB call', async () => {
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });

    const response = await POST(postJson({ destination: 'existing', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(400);
    expect(createDiscordGuildLookup).not.toHaveBeenCalled();
    expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
  });

  test('an existing-channel save is refused when the channel is not in the session guild\'s eligible list', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    getGuildSetupChannels.mockResolvedValue([{ id: '111', name: 'general', type: 0 }]);

    // A channel id that is not among the *session* guild's channels.
    const response = await POST(
      postJson({ destination: 'existing', channelId: '999-not-eligible', allowedRoleIds: [], guildId: GUILD_ID }),
    );

    expect(response.status).toBe(422);
    expect(getGuildSetupChannels).toHaveBeenCalledWith(GUILD_ID);
    expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
  });

  test('a body naming another guild than the session\'s is refused with 401 before any Discord or DB call', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    countArchivedClips.mockResolvedValue(0);

    // Another tab's setup link replaced the session cookie after this tab's
    // form rendered for OTHER_GUILD_ID.
    const response = await POST(
      postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: OTHER_GUILD_ID }),
    );

    expect(response.status).toBe(401);
    expect(createDiscordGuildLookup).not.toHaveBeenCalled();
    expect(createDiscordRestClient).not.toHaveBeenCalled();
    expect(discordRequest).not.toHaveBeenCalled();
    expect(findGuildArchiveConfig).not.toHaveBeenCalled();
    expect(findArchiveChangeBlocker).not.toHaveBeenCalled();
    expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
  });

  test('a body without the guild it was rendered for is rejected before any Discord or DB call', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    countArchivedClips.mockResolvedValue(0);

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [] }));

    expect(response.status).toBe(400);
    expect(createDiscordGuildLookup).not.toHaveBeenCalled();
    expect(createDiscordRestClient).not.toHaveBeenCalled();
    expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
  });

  test('existing-channel save persists the eligible channel and reports it was not auto-created', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    getGuildSetupChannels.mockResolvedValue([{ id: '111', name: 'general', type: 0 }]);
    countArchivedClips.mockResolvedValue(3);

    const response = await POST(postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      archiveChannelId: '111',
      archiveChannelName: 'general',
      autoCreated: false,
      clipCount: 3,
      allowedRoles: [],
    });
    // Only reads: an existing channel is never created, changed or deleted.
    expect(discordRequest.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  test('create-destination save creates a private channel via the REST client and persists it', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    countArchivedClips.mockResolvedValue(0);

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      archiveChannelId: '222',
      archiveChannelName: 'clip-archive',
      autoCreated: true,
      clipCount: 0,
      allowedRoles: [],
    });
    expect(discordRequest).toHaveBeenCalledWith(
      'POST',
      `/guilds/${GUILD_ID}/channels`,
      expect.objectContaining({ name: 'clip-archive' }),
    );
    expect(finalizeGuildArchiveConfig).toHaveBeenCalledWith({
      sessionTokenHash: 'session-hash:session-bearer',
      guildId: GUILD_ID,
      archiveChannelId: '222',
      configuredByUserId: USER_ID,
      allowedRoleIds: [],
    });
  });

  test('returns 409 and deletes a newly created channel when final reconfiguration conflicts', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: '111', allowedRoleIds: [] });
    finalizeGuildArchiveConfig.mockResolvedValue({ kind: 'CONFLICT', blocker: 'ARCHIVED' });
    countArchivedClips.mockResolvedValue(0);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(409);
    expect(discordRequest).toHaveBeenCalledTimes(3);
    expect(discordRequest).toHaveBeenNthCalledWith(3, 'DELETE', '/channels/222');
    expect(upsertGuildArchiveConfig).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalledWith(expect.stringContaining('setup.archive-channel-cleanup-failed'));
  });

  test('a session revoked during an auto-create save deletes the new channel and returns 401', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    finalizeGuildArchiveConfig.mockResolvedValue({ kind: 'SESSION_REVOKED' });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(401);
    expect(discordRequest).toHaveBeenLastCalledWith('DELETE', '/channels/222');
    expect(logged).not.toHaveBeenCalledWith(expect.stringContaining('setup.archive-channel-cleanup-failed'));
  });

  test('a session revoked during an existing-channel save returns 401 and deletes nothing', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    getGuildSetupChannels.mockResolvedValue([{ id: '111', name: 'general', type: 0 }]);
    finalizeGuildArchiveConfig.mockResolvedValue({ kind: 'SESSION_REVOKED' });

    const response = await POST(postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(401);
    expect(discordRequest).not.toHaveBeenCalledWith('DELETE', expect.anything());
  });

  test('returns 409 without deleting an existing channel when final reconfiguration conflicts', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: '111', allowedRoleIds: [] });
    getGuildSetupChannels.mockResolvedValue([{ id: '222', name: 'selected-existing-channel', type: 0 }]);
    finalizeGuildArchiveConfig.mockResolvedValue({ kind: 'CONFLICT', blocker: 'ARCHIVED' });

    const response = await POST(postJson({ destination: 'existing', channelId: '222', allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(409);
    expect(getGuildSetupChannels).toHaveBeenCalledWith(GUILD_ID);
    expect(finalizeGuildArchiveConfig).toHaveBeenCalledWith({
      sessionTokenHash: 'session-hash:session-bearer',
      guildId: GUILD_ID,
      archiveChannelId: '222',
      configuredByUserId: USER_ID,
      allowedRoleIds: [],
    });
    expect(discordRequest.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  test('keeps the 409 result and safe-logs when created-channel cleanup fails', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: '111', allowedRoleIds: [] });
    const cleanupError = Object.assign(
      new DiscordApiError('Discord response body must stay private', {
        status: 500,
        code: 50013,
      }),
      { responseBody: 'private response body', arbitraryField: 'private arbitrary value' },
    );
    discordRequest.mockImplementation(async (method: string) => {
      if (method === 'DELETE') {
        throw cleanupError;
      }
      if (method === 'GET') {
        return { id: BOT_USER_ID };
      }
      return { id: '222', name: 'clip-archive', type: 0 };
    });
    finalizeGuildArchiveConfig.mockResolvedValue({ kind: 'CONFLICT', blocker: 'ARCHIVED' });
    countArchivedClips.mockResolvedValue(0);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(409);
    expect(discordRequest).toHaveBeenCalledTimes(3);
    expect(discordRequest).toHaveBeenNthCalledWith(3, 'DELETE', '/channels/222');
    const lines = logged.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(lines).toEqual([
      {
        event: 'setup.archive-channel-cleanup-failed',
        guildId: GUILD_ID,
        errorCode: '50013',
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(cleanupError.message);
    expect(JSON.stringify(lines)).not.toContain(cleanupError.responseBody);
    expect(JSON.stringify(lines)).not.toContain(cleanupError.arbitraryField);
  });

  // Finding C2: a private #clip-archive created with only the @everyone deny
  // leaves the bot itself unable to see the channel it just made -- it has
  // no ADMINISTRATOR (spec §15) and no overwrite of its own, so it inherits
  // @everyone's now-denied VIEW_CHANNEL. Every subsequent clip then fails the
  // provenance POST with Discord 50001. This asserts the create call also
  // grants the bot user's member overwrite the permissions
  // archive-message.ts actually needs in steady state: VIEW_CHANNEL (to
  // address the channel at all) and SEND_MESSAGES (to post the provenance
  // and forward messages). Nothing broader -- deleting the bot's own
  // messages needs no permission, and channel creation itself runs on the
  // guild-level MANAGE_CHANNELS the bot already holds, not a channel
  // overwrite.
  test('grants the authenticated bot user VIEW_CHANNEL, SEND_MESSAGES and READ_MESSAGE_HISTORY', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    countArchivedClips.mockResolvedValue(0);

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(discordRequest).toHaveBeenCalledWith(
      'POST',
      `/guilds/${GUILD_ID}/channels`,
      expect.objectContaining({
        permission_overwrites: expect.arrayContaining([
          expect.objectContaining({
            id: BOT_USER_ID,
            type: 1,
            allow: ARCHIVE_PERMISSIONS.toString(),
          }),
        ]),
      }),
    );
    expect(discordRequest).toHaveBeenCalledWith('GET', '/users/@me');
    const createCall = discordRequest.mock.calls.find(
      ([method, path]) => method === 'POST' && path === `/guilds/${GUILD_ID}/channels`,
    );
    const overwrites = (createCall?.[2] as { permission_overwrites: Array<{ id: string }> })
      .permission_overwrites;
    expect(overwrites.map((overwrite) => overwrite.id)).not.toContain(APPLICATION_ID);
    expect(finalizeGuildArchiveConfig).toHaveBeenCalledWith({
      sessionTokenHash: 'session-hash:session-bearer',
      guildId: GUILD_ID,
      archiveChannelId: '222',
      configuredByUserId: USER_ID,
      allowedRoleIds: [],
    });
    expect(response.status).toBe(200);
  });

  test('names MANAGE_CHANNELS when Discord refuses channel creation with Missing Permissions, and logs it', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    const createError = new DiscordApiError('Missing Permissions', { status: 403, code: 50013 });
    discordRequest.mockImplementation(async (method: string) => {
      if (method === 'GET') {
        return { id: BOT_USER_ID };
      }
      throw createError;
    });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      reason: 'CREATE_CHANNEL_MISSING_PERMISSIONS',
      missingPermissions: ['MANAGE_CHANNELS'],
    });
    // The default bot role holds the archive permissions but not MANAGE_CHANNELS.
    expect(getMemberRoleIds).toHaveBeenCalledWith(GUILD_ID, BOT_USER_ID);
    const lines = logged.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(lines).toEqual([
      {
        event: 'setup.archive_channel_create_failed',
        guildId: GUILD_ID,
        failure: 'http',
        httpStatus: '403',
        discordCode: '50013',
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(createError.message);
    expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
  });

  // A bare 403 can come from an edge proxy, and 50001 means the bot cannot
  // reach the guild at all; neither says which permission is missing.
  test.each([
    { status: 500, code: null },
    { status: 403, code: null },
    { status: 403, code: 50001 },
  ])('any other channel creation refusal ($status/$code) is a bare 502, still logged', async ({ status, code }) => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    discordRequest.mockImplementation(async (method: string) => {
      if (method === 'GET') {
        return { id: BOT_USER_ID };
      }
      throw new DiscordApiError('refused', { status, code });
    });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(502);
    expect(await response.text()).toBe('');
    expect(logged.mock.calls.map(([line]) => JSON.parse(line as string).event)).toEqual([
      'setup.archive_channel_create_failed',
    ]);
    expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
  });

  // Discord also answers 50013 when the create's overwrites allow a
  // permission the bot lacks guild-wide, so 50013 alone does not prove
  // MANAGE_CHANNELS is the missing one.
  test('a Missing Permissions create refusal is a bare 502 when the bot does hold MANAGE_CHANNELS', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    getGuildRoles.mockResolvedValue([
      { id: GUILD_ID, name: '@everyone', permissions: 0n, managed: false },
      {
        id: BOT_ROLE_ID,
        name: 'Clip',
        permissions: PERMISSION.MANAGE_CHANNELS | PERMISSION.VIEW_CHANNEL | PERMISSION.READ_MESSAGE_HISTORY,
        managed: true,
      },
    ]);
    discordRequest.mockImplementation(async (method: string) => {
      if (method === 'GET') {
        return { id: BOT_USER_ID };
      }
      throw new DiscordApiError('Missing Permissions', { status: 403, code: 50013 });
    });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(502);
    expect(await response.text()).toBe('');
    expect(logged.mock.calls.map(([line]) => JSON.parse(line as string).event)).toEqual([
      'setup.archive_channel_create_failed',
    ]);
  });

  test('a Missing Permissions create refusal is a bare 502 when the bot\'s roles cannot be read', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    getMemberRoleIds.mockRejectedValue(new GuildLookupFailedError('member read failed', { retryable: true }));
    discordRequest.mockImplementation(async (method: string) => {
      if (method === 'GET') {
        return { id: BOT_USER_ID };
      }
      throw new DiscordApiError('Missing Permissions', { status: 403, code: 50013 });
    });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(502);
    expect(await response.text()).toBe('');
    expect(logged.mock.calls.map(([line]) => JSON.parse(line as string).event)).toEqual([
      'setup.archive_channel_create_failed',
    ]);
  });

  test('a Missing Permissions refusal of the bot identity lookup is a bare 502, not the create refusal', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    discordRequest.mockRejectedValue(new DiscordApiError('Missing Permissions', { status: 403, code: 50013 }));

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(502);
    expect(await response.text()).toBe('');
  });

  test('a failed bot identity lookup is not logged as a channel creation failure', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    discordRequest.mockRejectedValue(new DiscordApiError('Missing Access', { status: 403, code: 50001 }));
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(502);
    expect(discordRequest).not.toHaveBeenCalledWith('POST', `/guilds/${GUILD_ID}/channels`, expect.anything());
    expect(logged).not.toHaveBeenCalled();
  });

  test('returns 502 before channel creation when bot identity is malformed', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    discordRequest.mockResolvedValue({ username: 'clip' });

    const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(502);
    expect(discordRequest).toHaveBeenCalledWith('GET', '/users/@me');
    expect(discordRequest).not.toHaveBeenCalledWith('POST', `/guilds/${GUILD_ID}/channels`, expect.anything());
    expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
  });

  // The privacy half of the same array. Spec 5.3 makes the auto-created
  // archive channel private, which is entirely the `@everyone` deny -- and
  // deleting that one entry left all 307 tests green, so nothing covered it.
  // `@everyone`'s role id is the guild id.
  test('create-destination save denies @everyone VIEW_CHANNEL on the new channel', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    countArchivedClips.mockResolvedValue(0);

    await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

    const VIEW_CHANNEL = 1n << 10n;

    expect(discordRequest).toHaveBeenCalledWith(
      'POST',
      `/guilds/${GUILD_ID}/channels`,
      expect.objectContaining({
        permission_overwrites: expect.arrayContaining([
          expect.objectContaining({
            id: GUILD_ID,
            type: 0,
            deny: VIEW_CHANNEL.toString(),
          }),
        ]),
      }),
    );
  });

  // Finding C3: `Clip` rows carry no archive channel id of their own, only
  // `GuildConfig.archiveChannelId` does. Repointing that field out from under
  // a live Clip strands its archive in the old channel with nothing able to
  // address it any more -- author removal then deletes against the wrong
  // channel, gets Discord's "unknown message", and silently tombstones the
  // row while both archive messages stay live. `/setup/save` must refuse the
  // repoint while any non-terminal Clip exists.
  describe('finding C3: reconfiguring the archive channel while Clips are live', () => {
    test('an existing-channel save to a *different* channel is refused (409) when the guild has a live Clip', async () => {
      stubEnv();
      authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
      findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: '111', allowedRoleIds: [] });
      findArchiveChangeBlocker.mockResolvedValue('ARCHIVED');
      getGuildSetupChannels.mockResolvedValue([
        { id: '111', name: 'general', type: 0 },
        { id: '222', name: 'new-channel', type: 0 },
      ]);

      const response = await POST(postJson({ destination: 'existing', channelId: '222', allowedRoleIds: [], guildId: GUILD_ID }));

      expect(response.status).toBe(409);
      expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
      // The guard fires before any Discord call: no eligibility lookup, no
      // channel-creation POST.
      expect(getGuildSetupChannels).not.toHaveBeenCalled();
      expect(discordRequest).not.toHaveBeenCalled();
    });

    test('the current channel still existing keeps the refusal, and the check asks Discord about that channel', async () => {
      stubEnv();
      authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
      findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: '111', allowedRoleIds: [] });
      findArchiveChangeBlocker.mockResolvedValue('ARCHIVED');
      isChannelGone.mockResolvedValue(false);

      const response = await POST(postJson({ destination: 'existing', channelId: '222', allowedRoleIds: [], guildId: GUILD_ID }));

      expect(response.status).toBe(409);
      expect(isChannelGone).toHaveBeenCalledWith('111');
    });

    test.each(['ARCHIVED', 'IN_PROGRESS'] as const)('moving off a current channel Discord confirms deleted is allowed despite a %s blocker (#58)', async (blocker) => {
      stubEnv();
      authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
      findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: 'gone', allowedRoleIds: [] });
      findArchiveChangeBlocker.mockResolvedValue(blocker);
      isChannelGone.mockResolvedValue(true);
      countArchivedClips.mockResolvedValue(4);

      const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

      expect(response.status).toBe(200);
      expect(isChannelGone).toHaveBeenCalledWith('gone');
      expect(finalizeGuildArchiveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ archiveChannelId: '222', goneArchiveChannelId: 'gone' }),
      );
    });

    test('a create-destination save is refused (409) when the guild already has a config and a live Clip', async () => {
      stubEnv();
      authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
      findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: '111', allowedRoleIds: [] });
      findArchiveChangeBlocker.mockResolvedValue('ARCHIVED');

      const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }));

      expect(response.status).toBe(409);
      expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
      expect(discordRequest).not.toHaveBeenCalled();
    });

    test('setting the archive channel for the first time is never refused, even though findArchiveChangeBlocker is never asked', async () => {
      stubEnv();
      authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
      findGuildArchiveConfig.mockResolvedValue(null); // no prior setup
      getGuildSetupChannels.mockResolvedValue([{ id: '111', name: 'general', type: 0 }]);
      countArchivedClips.mockResolvedValue(0);

      const response = await POST(postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [], guildId: GUILD_ID }));

      expect(response.status).toBe(200);
      expect(findArchiveChangeBlocker).not.toHaveBeenCalled();
    });

    test('re-saving the same existing channel is never refused, even with live Clips', async () => {
      stubEnv();
      authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
      findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: '111', allowedRoleIds: [] });
      findArchiveChangeBlocker.mockResolvedValue('ARCHIVED');
      getGuildSetupChannels.mockResolvedValue([{ id: '111', name: 'general', type: 0 }]);
      countArchivedClips.mockResolvedValue(5);

      const response = await POST(postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [], guildId: GUILD_ID }));

      expect(response.status).toBe(200);
      expect(finalizeGuildArchiveConfig).toHaveBeenCalled();
    });
  });

  test('a guild the bot can no longer see is reported as 404', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    getGuildSetupChannels.mockRejectedValue(new GuildUnavailableError('gone'));

    const response = await POST(postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [], guildId: GUILD_ID }));

    expect(response.status).toBe(404);
    expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
  });

  test('a cross-origin POST is refused and nothing is persisted', async () => {
    stubEnv();

    const response = await POST(
      postJson({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }, { Origin: 'https://evil.example' }),
    );

    expect(response.status).toBe(403);
    expect(authenticateAdminSession).not.toHaveBeenCalled();
  });

  test('a POST with no Origin and a non-JSON content type is refused with 415 and nothing is persisted', async () => {
    const response = await POST(
      new NextRequest(`${BASE_URL}/setup/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Cookie: SESSION_COOKIE },
        body: JSON.stringify({ destination: 'create', channelId: null, allowedRoleIds: [], guildId: GUILD_ID }),
      }),
    );

    expect(response.status).toBe(415);
    expect(authenticateAdminSession).not.toHaveBeenCalled();
  });

  test('a same-origin POST is still accepted', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    getGuildSetupChannels.mockResolvedValue([{ id: '111', name: 'general', type: 0 }]);
    countArchivedClips.mockResolvedValue(0);

    const response = await POST(
      postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [], guildId: GUILD_ID }, { Origin: BASE_URL }),
    );

    expect(response.status).toBe(200);
  });

  describe('allowed roles and destination permissions', () => {
    beforeEach(() => {
      stubEnv();
      authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
      getGuildSetupChannels.mockResolvedValue([{ id: '111', name: 'general', type: 0 }]);
      countArchivedClips.mockResolvedValue(0);
    });

    test('saves deduplicated allowed roles and returns their names', async () => {
      const response = await POST(
        postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [MOD_ROLE_ID, MOD_ROLE_ID], guildId: GUILD_ID }),
      );

      expect(response.status).toBe(200);
      expect(finalizeGuildArchiveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ allowedRoleIds: [MOD_ROLE_ID] }),
      );
      expect((await response.json()).allowedRoles).toEqual([{ id: MOD_ROLE_ID, name: 'moderator' }]);
    });

    test.each([
      ['@everyone', GUILD_ID],
      ['a role from no guild role list', '1539212298600718000'],
      ["the bot's managed role (#60)", BOT_ROLE_ID],
    ])('refuses %s as an allowed role without saving', async (_name, roleId) => {
      const response = await POST(
        postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [roleId], guildId: GUILD_ID }),
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ reason: 'INVALID_ROLE' });
      expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
    });

    test('role validation runs before the archive channel is created', async () => {
      const response = await POST(
        postJson({ destination: 'create', channelId: null, allowedRoleIds: [GUILD_ID], guildId: GUILD_ID }),
      );

      expect(response.status).toBe(422);
      expect(discordRequest).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything());
    });

    test('refuses an existing channel the bot cannot read history in, naming the permission', async () => {
      getChannelOverwrites.mockResolvedValue([
        { id: BOT_ROLE_ID, type: 0, allow: 0n, deny: PERMISSION.READ_MESSAGE_HISTORY },
      ]);

      const response = await POST(postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [], guildId: GUILD_ID }));

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        reason: 'MISSING_PERMISSIONS',
        missingPermissions: ['READ_MESSAGE_HISTORY'],
      });
      expect(getMemberRoleIds).toHaveBeenCalledWith(GUILD_ID, BOT_USER_ID);
      expect(getChannelOverwrites).toHaveBeenCalledWith('111');
      expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
      // Read-only check: nothing is written to the admin's channel.
      expect(discordRequest.mock.calls.every(([method]) => method === 'GET')).toBe(true);
    });

    test('returns 502 without saving when the channel overwrites cannot be read', async () => {
      // The real lookup, so the route sees what the parser makes of a
      // channel payload with no permission_overwrites field. Its REST client
      // is the mocked one above, so the channel read is routed through it.
      const actual = await vi.importActual<typeof import('@/lib/discord/guild-lookup')>(
        '@/lib/discord/guild-lookup',
      );
      const otherRequests = discordRequest.getMockImplementation()!;
      discordRequest.mockImplementation(async (method: string, path: string, ...rest: unknown[]) =>
        method === 'GET' && path === '/channels/111'
          ? { id: '111', name: 'general', type: 0 }
          : otherRequests(method, path, ...rest),
      );
      getChannelOverwrites.mockImplementation((channelId: string) =>
        actual.createDiscordGuildLookup({ botToken: 'bot-token-value', fetchImpl: fetch }).getChannelOverwrites(channelId),
      );

      const response = await POST(postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [], guildId: GUILD_ID }));

      expect(response.status).toBe(502);
      expect(getChannelOverwrites).toHaveBeenCalledWith('111');
      expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
    });

    test('an existing channel not in the eligible list explains itself', async () => {
      const response = await POST(postJson({ destination: 'existing', channelId: '999', allowedRoleIds: [], guildId: GUILD_ID }));

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ reason: 'INVALID_CHANNEL' });
    });

    test('a destination change blocked by live Clips explains itself', async () => {
      findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: 'old-channel', allowedRoleIds: [] });
      findArchiveChangeBlocker.mockResolvedValue('ARCHIVED');

      const response = await POST(postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [], guildId: GUILD_ID }));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ reason: 'LIVE_CLIPS' });
    });

    test('a final-recheck conflict explains itself the same way', async () => {
      finalizeGuildArchiveConfig.mockResolvedValue({ kind: 'CONFLICT', blocker: 'ARCHIVED' });

      const response = await POST(postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [], guildId: GUILD_ID }));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ reason: 'LIVE_CLIPS' });
    });

    test('a destination change blocked by a Clip still being archived answers CLIP_IN_PROGRESS', async () => {
      findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: 'old-channel', allowedRoleIds: [] });
      findArchiveChangeBlocker.mockResolvedValue('IN_PROGRESS');

      const response = await POST(postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [], guildId: GUILD_ID }));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ reason: 'CLIP_IN_PROGRESS' });
    });

    test('a final-recheck conflict from a Clip still being archived answers CLIP_IN_PROGRESS', async () => {
      finalizeGuildArchiveConfig.mockResolvedValue({ kind: 'CONFLICT', blocker: 'IN_PROGRESS' });

      const response = await POST(postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [], guildId: GUILD_ID }));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ reason: 'CLIP_IN_PROGRESS' });
    });

    test('a role-only edit with live Clips is saved', async () => {
      findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: '111', allowedRoleIds: [] });
      findArchiveChangeBlocker.mockResolvedValue('ARCHIVED');

      const response = await POST(
        postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [MOD_ROLE_ID], guildId: GUILD_ID }),
      );

      expect(response.status).toBe(200);
    });
  });
});
