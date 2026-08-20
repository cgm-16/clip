import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { prisma as PrismaSingleton } from '@/lib/db';
import { CLIP_COMMAND_NAME } from '@/lib/discord/commands';
import { DISCORD_COPY } from '@/lib/discord/copy';

// Finding I1: `notifyAuthorOfFirstArchival` can throw (its internal
// `claimAuthorNotification` calls `findUniqueOrThrow` after an `updateMany`,
// which throws if a concurrent deletion drops the row in between). This
// module is otherwise unmocked everywhere else it is used (the DM-button
// handler in `notifications.ts` itself, and `context-commands.test.ts`'s own
// coverage of a real successful DM), so it is mocked here -- and only here,
// in a dedicated file -- rather than adding a file-wide mock to the shared
// `context-commands.test.ts` that every other Clip/Unclip/Remove test in
// this branch also depends on.
const notifyAuthorOfFirstArchival = vi.hoisted(() => vi.fn());
vi.mock('@/lib/discord/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/discord/notifications')>();
  return { ...actual, notifyAuthorOfFirstArchival };
});

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

const APPLICATION_ID = '1539212298600718416';
const BASE_URL = 'https://clipendpoint.cc';
const BOT_TOKEN = 'bot-token-value';

const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
const EPHEMERAL_FLAG = 64;
const APPLICATION_COMMAND_INTERACTION_TYPE = 2;
const MANAGE_GUILD_ONLY = (1n << 5n).toString();

function fakeSnowflake(): string {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

function signedRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const timestamp = '1700000000';
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');

  return new Request(`${BASE_URL}/api/discord/interactions`, {
    method: 'POST',
    headers: {
      'X-Signature-Ed25519': signature,
      'X-Signature-Timestamp': timestamp,
    },
    body,
  });
}

type StubCall = { method: string; url: string; body: Record<string, unknown> | null };

function createFetchStub() {
  const calls: StubCall[] = [];
  let counter = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const urlStr = String(url);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, url: urlStr, body });

    if (method === 'GET' && urlStr.includes('/guilds/')) {
      return new Response(JSON.stringify({ id: 'guild', name: 'Test Guild' }), { status: 200 });
    }
    if (method === 'GET') {
      // The source-message read inside archive creation.
      return new Response(JSON.stringify({ type: 0, timestamp: new Date().toISOString() }), { status: 200 });
    }
    if (method === 'PUT' || method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    counter += 1;
    return new Response(JSON.stringify({ id: `posted-${counter}` }), { status: 200 });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function followupUrl(token: string): string {
  return `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${token}/messages/@original`;
}

describe('runClipCommand: nothing after the member is answered may overwrite that answer', () => {
  let prisma: typeof PrismaSingleton;
  let POST: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    vi.stubEnv('DISCORD_APPLICATION_ID', APPLICATION_ID);
    vi.stubEnv('DISCORD_PUBLIC_KEY', publicKeyHex);
    vi.stubEnv('DISCORD_BOT_TOKEN', BOT_TOKEN);
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
    vi.stubEnv('PUBLIC_BASE_URL', BASE_URL);

    ({ prisma } = await import('@/lib/db'));
    ({ POST } = await import('@/app/api/discord/interactions/route'));
  });

  const cleanupGuildIds: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    notifyAuthorOfFirstArchival.mockReset();
    await prisma.clipper.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.clip.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.guildAllowedRole.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.guildConfig.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    cleanupGuildIds.length = 0;
  });

  test('a genuinely successful Clip stays answered as success even when notifyAuthorOfFirstArchival throws afterward', async () => {
    const guildId = fakeSnowflake();
    cleanupGuildIds.push(guildId);
    const archiveChannelId = fakeSnowflake();
    const sourceChannelId = fakeSnowflake();
    const sourceMessageId = fakeSnowflake();
    const sourceAuthorUserId = fakeSnowflake();
    const clipperId = fakeSnowflake();
    const token = `token-${fakeSnowflake()}`;

    await prisma.guildConfig.create({
      data: { guildId, archiveChannelId, configuredByUserId: fakeSnowflake() },
    });

    // Simulates the race the finding describes: `claimAuthorNotification`'s
    // `updateMany` commits, then a concurrent deletion drops the row before
    // its `findUniqueOrThrow` runs, and that throws.
    notifyAuthorOfFirstArchival.mockRejectedValue(
      new Error('simulated concurrent deletion between updateMany and findUniqueOrThrow'),
    );

    const { fetchImpl, calls } = createFetchStub();
    vi.stubGlobal('fetch', fetchImpl);

    const response = await POST(
      signedRequest({
        type: APPLICATION_COMMAND_INTERACTION_TYPE,
        token,
        guild_id: guildId,
        channel: { name: 'general' },
        // MANAGE_GUILD so authorization does not depend on setting up an
        // allowed-roles config -- this test is about the follow-up ordering,
        // not authorization.
        member: {
          permissions: MANAGE_GUILD_ONLY,
          roles: [],
          user: { id: clipperId },
        },
        data: {
          id: 'command-id',
          name: CLIP_COMMAND_NAME,
          type: 3,
          target_id: sourceMessageId,
          resolved: {
            messages: {
              [sourceMessageId]: {
                id: sourceMessageId,
                channel_id: sourceChannelId,
                author: { id: sourceAuthorUserId },
              },
            },
          },
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: EPHEMERAL_FLAG },
    });

    // Wait for the mocked, throwing call to actually have run (the marker
    // reaction is posted just before it, in the same background task).
    await vi.waitFor(() => {
      expect(notifyAuthorOfFirstArchival).toHaveBeenCalled();
    });
    // Then give the swallowed rejection's `.catch` handler, and any second
    // follow-up it might (incorrectly) issue, a full macrotask to land
    // before inspecting the calls -- asserting immediately after the mock
    // resolves would pass even on the buggy code, since the erroneous
    // second PATCH is still a couple of microtask turns away at that point.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const followupCalls = calls.filter((call) => call.url === followupUrl(token));
    expect(followupCalls).toHaveLength(1);
    expect(followupCalls[0]?.body).toEqual({ content: DISCORD_COPY.success });
  });
});
