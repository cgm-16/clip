import { afterEach, describe, expect, test, vi } from 'vitest';
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
vi.mock('@/lib/clip/repository', () => ({ upsertGuildArchiveConfig, countArchivedClips }));

const { POST } = await import('@/app/setup/save/route');

const BASE_URL = 'https://clipendpoint.cc';
const GUILD_ID = '1539212298600718416';
const OTHER_GUILD_ID = '1539212298600718499';
const USER_ID = '1539212298600718417';
const SESSION_COOKIE = `${ADMIN_SESSION_COOKIE_NAME}=session-bearer`;

// Only the paths that reach parseEnv (an Origin header present, or code past
// the session/body checks) need a full env -- same reasoning as
// tests/admin-session/exchange-route.test.ts's stubEnv.
function stubEnv(): void {
  vi.stubEnv('DATABASE_URL', 'postgresql://clip:pw@localhost:5433/clip_dev');
  vi.stubEnv('DISCORD_APPLICATION_ID', '1539212298600718416');
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
