import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/admin-session/tokens';
import { GuildUnavailableError } from '@/lib/discord/guild-lookup';

const authenticateAdminSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/admin-session/service', () => ({ authenticateAdminSession }));

const getGuildSetupTargets = vi.hoisted(() => vi.fn());
const createDiscordGuildLookup = vi.hoisted(() => vi.fn(() => ({ getGuildSetupTargets })));
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
const countArchivedClips = vi.hoisted(() => vi.fn());
const findGuildArchiveConfig = vi.hoisted(() => vi.fn());
const hasLiveClips = vi.hoisted(() => vi.fn());
vi.mock('@/lib/clip/repository', () => ({
  upsertGuildArchiveConfig,
  countArchivedClips,
  findGuildArchiveConfig,
  hasLiveClips,
}));

const { POST } = await import('@/app/setup/save/route');

const BASE_URL = 'https://clipendpoint.cc';
const GUILD_ID = '1539212298600718416';
const OTHER_GUILD_ID = '1539212298600718499';
const USER_ID = '1539212298600718417';
// Deliberately different from GUILD_ID: the bot's overwrite is keyed on the
// application id and `@everyone`'s on the guild id, so a shared literal would
// let an assertion on either one pass against the other.
const APPLICATION_ID = '1539212298600718888';
const SESSION_COOKIE = `${ADMIN_SESSION_COOKIE_NAME}=session-bearer`;

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

function postJson(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE_URL}/setup/save`, {
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
    hasLiveClips.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  test('no session cookie is refused with 401 before touching auth', async () => {
    const response = await POST(
      new Request(`${BASE_URL}/setup/save`, {
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

    const response = await POST(postJson({ destination: 'create', channelId: null }));

    expect(response.status).toBe(401);
  });

  test('a malformed body ("existing" with no channelId) is rejected before any Discord or DB call', async () => {
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });

    const response = await POST(postJson({ destination: 'existing', channelId: null }));

    expect(response.status).toBe(400);
    expect(createDiscordGuildLookup).not.toHaveBeenCalled();
    expect(upsertGuildArchiveConfig).not.toHaveBeenCalled();
  });

  test('an existing-channel save is refused when the channel is not in the session guild\'s eligible list', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    getGuildSetupTargets.mockResolvedValue({
      channels: [{ id: '111', name: 'general', type: 0 }],
      roles: [],
    });

    // Attempted cross-guild escalation: body names a foreign guild and a
    // channel id that is not among the *session* guild's channels.
    const response = await POST(
      postJson({ destination: 'existing', channelId: '999-not-eligible', guildId: OTHER_GUILD_ID }),
    );

    expect(response.status).toBe(422);
    expect(getGuildSetupTargets).toHaveBeenCalledWith(GUILD_ID);
    expect(upsertGuildArchiveConfig).not.toHaveBeenCalled();
  });

  test('the guild id always comes from the session, never the request body', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    getGuildSetupTargets.mockResolvedValue({
      channels: [{ id: '111', name: 'general', type: 0 }],
      roles: [],
    });
    upsertGuildArchiveConfig.mockResolvedValue(undefined);
    countArchivedClips.mockResolvedValue(0);

    const response = await POST(
      postJson({ destination: 'existing', channelId: '111', guildId: OTHER_GUILD_ID }),
    );

    expect(response.status).toBe(200);
    expect(getGuildSetupTargets).toHaveBeenCalledWith(GUILD_ID);
    expect(upsertGuildArchiveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: GUILD_ID, configuredByUserId: USER_ID }),
    );
  });

  test('existing-channel save persists the eligible channel and reports it was not auto-created', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    getGuildSetupTargets.mockResolvedValue({
      channels: [{ id: '111', name: 'general', type: 0 }],
      roles: [],
    });
    upsertGuildArchiveConfig.mockResolvedValue(undefined);
    countArchivedClips.mockResolvedValue(3);

    const response = await POST(postJson({ destination: 'existing', channelId: '111' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      archiveChannelId: '111',
      archiveChannelName: 'general',
      autoCreated: false,
      clipCount: 3,
    });
    expect(discordRequest).not.toHaveBeenCalled();
  });

  test('create-destination save creates a private channel via the REST client and persists it', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    discordRequest.mockResolvedValue({ id: '222', name: 'clip-archive', type: 0 });
    upsertGuildArchiveConfig.mockResolvedValue(undefined);
    countArchivedClips.mockResolvedValue(0);

    const response = await POST(postJson({ destination: 'create', channelId: null }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      archiveChannelId: '222',
      archiveChannelName: 'clip-archive',
      autoCreated: true,
      clipCount: 0,
    });
    expect(discordRequest).toHaveBeenCalledWith(
      'POST',
      `/guilds/${GUILD_ID}/channels`,
      expect.objectContaining({ name: 'clip-archive' }),
    );
    expect(upsertGuildArchiveConfig).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      archiveChannelId: '222',
      configuredByUserId: USER_ID,
    });
  });

  // Finding C2: a private #clip-archive created with only the @everyone deny
  // leaves the bot itself unable to see the channel it just made -- it has
  // no ADMINISTRATOR (spec §15) and no overwrite of its own, so it inherits
  // @everyone's now-denied VIEW_CHANNEL. Every subsequent clip then fails the
  // provenance POST with Discord 50001. This asserts the create call also
  // grants the application's own member overwrite the permissions
  // archive-message.ts actually needs in steady state: VIEW_CHANNEL (to
  // address the channel at all) and SEND_MESSAGES (to post the provenance
  // and forward messages). Nothing broader -- deleting the bot's own
  // messages needs no permission, and channel creation itself runs on the
  // guild-level MANAGE_CHANNELS the bot already holds, not a channel
  // overwrite.
  test('create-destination save grants the bot itself VIEW_CHANNEL and SEND_MESSAGES on the new channel', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    discordRequest.mockResolvedValue({ id: '222', name: 'clip-archive', type: 0 });
    upsertGuildArchiveConfig.mockResolvedValue(undefined);
    countArchivedClips.mockResolvedValue(0);

    await POST(postJson({ destination: 'create', channelId: null }));

    const VIEW_CHANNEL = 1n << 10n;
    const SEND_MESSAGES = 1n << 11n;
    expect(discordRequest).toHaveBeenCalledWith(
      'POST',
      `/guilds/${GUILD_ID}/channels`,
      expect.objectContaining({
        permission_overwrites: expect.arrayContaining([
          expect.objectContaining({
            id: APPLICATION_ID,
            type: 1,
            allow: (VIEW_CHANNEL | SEND_MESSAGES).toString(),
          }),
        ]),
      }),
    );
  });

  // The privacy half of the same array. Spec 5.3 makes the auto-created
  // archive channel private, which is entirely the `@everyone` deny -- and
  // deleting that one entry left all 307 tests green, so nothing covered it.
  // `@everyone`'s role id is the guild id.
  test('create-destination save denies @everyone VIEW_CHANNEL on the new channel', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    discordRequest.mockResolvedValue({ id: '222', name: 'clip-archive', type: 0 });
    upsertGuildArchiveConfig.mockResolvedValue(undefined);
    countArchivedClips.mockResolvedValue(0);

    await POST(postJson({ destination: 'create', channelId: null }));

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
      hasLiveClips.mockResolvedValue(true);
      getGuildSetupTargets.mockResolvedValue({
        channels: [{ id: '111', name: 'general', type: 0 }, { id: '222', name: 'new-channel', type: 0 }],
        roles: [],
      });

      const response = await POST(postJson({ destination: 'existing', channelId: '222' }));

      expect(response.status).toBe(409);
      expect(upsertGuildArchiveConfig).not.toHaveBeenCalled();
      // The guard fires before any Discord call: no eligibility lookup, no
      // channel-creation POST.
      expect(getGuildSetupTargets).not.toHaveBeenCalled();
      expect(discordRequest).not.toHaveBeenCalled();
    });

    test('a create-destination save is refused (409) when the guild already has a config and a live Clip', async () => {
      stubEnv();
      authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
      findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: '111', allowedRoleIds: [] });
      hasLiveClips.mockResolvedValue(true);

      const response = await POST(postJson({ destination: 'create', channelId: null }));

      expect(response.status).toBe(409);
      expect(upsertGuildArchiveConfig).not.toHaveBeenCalled();
      expect(discordRequest).not.toHaveBeenCalled();
    });

    test('setting the archive channel for the first time is never refused, even though hasLiveClips is never asked', async () => {
      stubEnv();
      authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
      findGuildArchiveConfig.mockResolvedValue(null); // no prior setup
      getGuildSetupTargets.mockResolvedValue({
        channels: [{ id: '111', name: 'general', type: 0 }],
        roles: [],
      });
      upsertGuildArchiveConfig.mockResolvedValue(undefined);
      countArchivedClips.mockResolvedValue(0);

      const response = await POST(postJson({ destination: 'existing', channelId: '111' }));

      expect(response.status).toBe(200);
      expect(hasLiveClips).not.toHaveBeenCalled();
    });

    test('re-saving the same existing channel is never refused, even with live Clips', async () => {
      stubEnv();
      authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
      findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: '111', allowedRoleIds: [] });
      hasLiveClips.mockResolvedValue(true);
      getGuildSetupTargets.mockResolvedValue({
        channels: [{ id: '111', name: 'general', type: 0 }],
        roles: [],
      });
      upsertGuildArchiveConfig.mockResolvedValue(undefined);
      countArchivedClips.mockResolvedValue(5);

      const response = await POST(postJson({ destination: 'existing', channelId: '111' }));

      expect(response.status).toBe(200);
      expect(upsertGuildArchiveConfig).toHaveBeenCalled();
    });
  });

  test('a guild the bot can no longer see is reported as 404', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    getGuildSetupTargets.mockRejectedValue(new GuildUnavailableError('gone'));

    const response = await POST(postJson({ destination: 'existing', channelId: '111' }));

    expect(response.status).toBe(404);
    expect(upsertGuildArchiveConfig).not.toHaveBeenCalled();
  });

  test('a cross-origin POST is refused and nothing is persisted', async () => {
    stubEnv();

    const response = await POST(
      postJson({ destination: 'create', channelId: null }, { Origin: 'https://evil.example' }),
    );

    expect(response.status).toBe(403);
    expect(authenticateAdminSession).not.toHaveBeenCalled();
  });

  test('a same-origin POST is still accepted', async () => {
    stubEnv();
    authenticateAdminSession.mockResolvedValue({ guildId: GUILD_ID, userId: USER_ID });
    getGuildSetupTargets.mockResolvedValue({
      channels: [{ id: '111', name: 'general', type: 0 }],
      roles: [],
    });
    upsertGuildArchiveConfig.mockResolvedValue(undefined);
    countArchivedClips.mockResolvedValue(0);

    const response = await POST(
      postJson({ destination: 'existing', channelId: '111' }, { Origin: BASE_URL }),
    );

    expect(response.status).toBe(200);
  });
});
