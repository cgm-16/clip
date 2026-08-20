import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  ClipCommandResult,
  RemoveResult,
  UnclipResult,
} from '@/lib/clip/types';
import {
  CLIP_COMMAND_NAME,
  REMOVE_FROM_CLIP_ARCHIVE_COMMAND_NAME,
  UNCLIP_COMMAND_NAME,
} from '@/lib/discord/commands';
import {
  clipResultCopy,
  removeResultCopy,
  unclipResultCopy,
} from '@/lib/discord/interaction-responses';
import { DISCORD_COPY } from '@/lib/discord/copy';
import type { prisma as PrismaSingleton } from '@/lib/db';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

const APPLICATION_ID = '1539212298600718416';
const BASE_URL = 'https://clipendpoint.cc';
const BOT_TOKEN = 'bot-token-value';

const APPLICATION_COMMAND_INTERACTION_TYPE = 2;
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
const EPHEMERAL_FLAG = 64;

const MANAGE_GUILD_ONLY = (1n << 5n).toString();
const NO_MANAGE_GUILD = ((1n << 5n) - 1n).toString();

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

type ContextCommandOptions = {
  commandName: string;
  guildId: string;
  invokerId: string;
  invokerPermissions: string;
  invokerRoles?: string[];
  interactionToken: string;
  targetMessageId: string;
  targetChannelId: string;
  targetAuthorId: string;
  channelName?: string;
};

function contextCommandInvocation(opts: ContextCommandOptions): unknown {
  return {
    type: APPLICATION_COMMAND_INTERACTION_TYPE,
    token: opts.interactionToken,
    guild_id: opts.guildId,
    channel: opts.channelName === undefined ? undefined : { name: opts.channelName },
    member: {
      permissions: opts.invokerPermissions,
      roles: opts.invokerRoles ?? [],
      user: { id: opts.invokerId },
    },
    data: {
      id: 'command-id',
      name: opts.commandName,
      type: 3,
      target_id: opts.targetMessageId,
      resolved: {
        messages: {
          [opts.targetMessageId]: {
            id: opts.targetMessageId,
            channel_id: opts.targetChannelId,
            author: { id: opts.targetAuthorId },
          },
        },
      },
    },
  };
}

type StubCall = { method: string; url: string; body: Record<string, unknown> | null };
type Responder = (
  method: string,
  url: string,
  body: Record<string, unknown> | null,
) => { status: number; body: unknown } | null;

/**
 * A URL/method-keyed `fetch` stub, standing in for every Discord REST call
 * `route.ts`'s background work makes (source message read, archive posts,
 * marker reaction, guild lookup, DM, and the follow-up PATCH). `responders`
 * let a test override one endpoint's behaviour without having to describe
 * every call in order -- the background work is not awaited by `POST`, so
 * the order some of these calls happen in is an implementation detail, not
 * something a test should assert on.
 */
function createFetchStub(responders: Responder[] = []) {
  const calls: StubCall[] = [];
  let counter = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const urlStr = String(url);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, url: urlStr, body });

    for (const responder of responders) {
      const result = responder(method, urlStr, body);
      if (result !== null) {
        return new Response(result.body === null ? null : JSON.stringify(result.body), {
          status: result.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

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

async function waitForCall(
  calls: readonly StubCall[],
  predicate: (call: StubCall) => boolean,
): Promise<StubCall> {
  return vi.waitFor(() => {
    const found = calls.find(predicate);
    if (found === undefined) {
      throw new Error('expected call not observed yet');
    }
    return found;
  });
}

function followupUrl(token: string): string {
  return `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${token}/messages/@original`;
}

describe('context command result copy mapping', () => {
  // Every variant of the three result unions maps to exactly one Korean
  // string. A variant with no case in `interaction-responses.ts` is a
  // compile error there (no `default`), so this is belt-and-suspenders
  // coverage that the *values* those cases pick are the intended ones.
  const clipCases: Array<[string, ClipCommandResult, string]> = [
    ['CREATED', { kind: 'CREATED', archive: { provenanceMessageId: 'p', forwardMessageId: 'f' } }, DISCORD_COPY.success],
    ['CLIPPER_ADDED', { kind: 'CLIPPER_ADDED', archive: null }, DISCORD_COPY.success],
    ['ALREADY_CLIPPED_BY_USER', { kind: 'ALREADY_CLIPPED_BY_USER', archive: null }, DISCORD_COPY.duplicate],
    ['NOT_AUTHORIZED', { kind: 'NOT_AUTHORIZED' }, DISCORD_COPY.noPermission],
    ['REMOVED_BY_AUTHOR_OR_ADMIN', { kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' }, DISCORD_COPY.invalidTarget],
    ['SOURCE_UNAVAILABLE', { kind: 'SOURCE_UNAVAILABLE' }, DISCORD_COPY.invalidTarget],
    ['FAILED retryable', { kind: 'FAILED', retryable: true }, DISCORD_COPY.transientFailure],
    ['FAILED not retryable', { kind: 'FAILED', retryable: false }, DISCORD_COPY.transientFailure],
  ];
  test.each(clipCases)('ClipCommandResult %s maps to its copy', (_label, result, expected) => {
    expect(clipResultCopy(result)).toBe(expected);
  });

  const unclipCases: Array<[string, UnclipResult, string]> = [
    ['UNCLIPPED remaining', { kind: 'UNCLIPPED', remaining: 3 }, DISCORD_COPY.unclipped],
    ['UNCLIPPED last', { kind: 'UNCLIPPED', remaining: 0 }, DISCORD_COPY.unclipped],
    ['NOT_CLIPPED_BY_USER', { kind: 'NOT_CLIPPED_BY_USER' }, DISCORD_COPY.nothingToUnclip],
    ['NOT_FOUND', { kind: 'NOT_FOUND' }, DISCORD_COPY.nothingToUnclip],
    ['FAILED', { kind: 'FAILED', retryable: true }, DISCORD_COPY.transientFailure],
  ];
  test.each(unclipCases)('UnclipResult %s maps to its copy', (_label, result, expected) => {
    expect(unclipResultCopy(result)).toBe(expected);
  });

  const removeCases: Array<[string, RemoveResult, string]> = [
    ['REMOVED', { kind: 'REMOVED' }, DISCORD_COPY.unclipped],
    ['NOT_FOUND', { kind: 'NOT_FOUND' }, DISCORD_COPY.nothingToUnclip],
    ['NOT_AUTHORIZED', { kind: 'NOT_AUTHORIZED' }, DISCORD_COPY.noPermission],
    ['FAILED', { kind: 'FAILED', retryable: false }, DISCORD_COPY.transientFailure],
  ];
  test.each(removeCases)('RemoveResult %s maps to its copy', (_label, result, expected) => {
    expect(removeResultCopy(result)).toBe(expected);
  });
});

describe('Clip / Unclip / Remove context commands', () => {
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
    vi.restoreAllMocks();
    await prisma.clipper.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.clip.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.guildAllowedRole.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.guildConfig.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    cleanupGuildIds.length = 0;
  });

  type Fixture = {
    guildId: string;
    archiveChannelId: string;
    allowedRoleId: string;
    sourceChannelId: string;
    sourceMessageId: string;
    sourceAuthorUserId: string;
  };

  function newFixture(): Fixture {
    const fixture: Fixture = {
      guildId: fakeSnowflake(),
      archiveChannelId: fakeSnowflake(),
      allowedRoleId: fakeSnowflake(),
      sourceChannelId: fakeSnowflake(),
      sourceMessageId: fakeSnowflake(),
      sourceAuthorUserId: fakeSnowflake(),
    };
    cleanupGuildIds.push(fixture.guildId);
    return fixture;
  }

  async function seedConfiguredGuild(): Promise<Fixture> {
    const fixture = newFixture();
    await prisma.guildConfig.create({
      data: {
        guildId: fixture.guildId,
        archiveChannelId: fixture.archiveChannelId,
        configuredByUserId: fakeSnowflake(),
        allowedRoles: { create: [{ roleId: fixture.allowedRoleId }] },
      },
    });
    return fixture;
  }

  function readClip(fixture: Fixture) {
    return prisma.clip.findUnique({
      where: {
        guildId_sourceMessageId: { guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId },
      },
    });
  }

  function countClipperRows(fixture: Fixture): Promise<number> {
    return prisma.clipper.count({
      where: { guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId },
    });
  }

  describe('Clip', () => {
    test('an unauthorized member is refused and no Clip is created', async () => {
      const fixture = await seedConfiguredGuild();
      const { fetchImpl, calls } = createFetchStub();
      vi.stubGlobal('fetch', fetchImpl);
      const token = `token-${fakeSnowflake()}`;

      const response = await POST(
        signedRequest(
          contextCommandInvocation({
            commandName: CLIP_COMMAND_NAME,
            guildId: fixture.guildId,
            invokerId: fakeSnowflake(),
            invokerPermissions: NO_MANAGE_GUILD,
            invokerRoles: [], // holds none of the guild's allowed roles
            interactionToken: token,
            targetMessageId: fixture.sourceMessageId,
            targetChannelId: fixture.sourceChannelId,
            targetAuthorId: fixture.sourceAuthorUserId,
          }),
        ),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: EPHEMERAL_FLAG },
      });

      const followup = await waitForCall(calls, (call) => call.url === followupUrl(token));
      expect(followup.body).toEqual({ content: DISCORD_COPY.noPermission });

      expect(await readClip(fixture)).toBeNull();
      // No archive post and no marker reaction: an unauthorized attempt
      // never reaches Discord for anything beyond the follow-up.
      expect(calls.some((call) => call.method === 'POST' && call.url.includes('/messages'))).toBe(false);
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    });

    test('an authorized first clip creates the archive, adds the marker, and notifies the author', async () => {
      const fixture = await seedConfiguredGuild();
      const { fetchImpl, calls } = createFetchStub();
      vi.stubGlobal('fetch', fetchImpl);
      const token = `token-${fakeSnowflake()}`;
      const clipperId = fakeSnowflake();

      const response = await POST(
        signedRequest(
          contextCommandInvocation({
            commandName: CLIP_COMMAND_NAME,
            guildId: fixture.guildId,
            invokerId: clipperId,
            invokerPermissions: NO_MANAGE_GUILD,
            invokerRoles: [fixture.allowedRoleId],
            interactionToken: token,
            targetMessageId: fixture.sourceMessageId,
            targetChannelId: fixture.sourceChannelId,
            targetAuthorId: fixture.sourceAuthorUserId,
            channelName: 'general',
          }),
        ),
      );

      await expect(response.json()).resolves.toEqual({
        type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: EPHEMERAL_FLAG },
      });

      const followup = await waitForCall(calls, (call) => call.url === followupUrl(token));
      expect(followup.body).toEqual({ content: DISCORD_COPY.success });

      const clip = await readClip(fixture);
      expect(clip?.status).toBe('ACTIVE');
      expect(await countClipperRows(fixture)).toBe(1);

      // The marker reaction, added on the source message.
      await waitForCall(
        calls,
        (call) =>
          call.method === 'PUT' &&
          call.url.includes(`/channels/${fixture.sourceChannelId}/messages/${fixture.sourceMessageId}/reactions/`),
      );

      // The first-clip author DM: a channel open, then a message post into it.
      await waitForCall(calls, (call) => call.method === 'POST' && call.url === 'https://discord.com/api/v10/users/@me/channels');
    });

    test('clipping an already-archived message adds this member as a clipper without a second archive', async () => {
      const fixture = await seedConfiguredGuild();
      const { fetchImpl, calls } = createFetchStub();
      vi.stubGlobal('fetch', fetchImpl);
      const firstToken = `token-${fakeSnowflake()}`;

      await POST(
        signedRequest(
          contextCommandInvocation({
            commandName: CLIP_COMMAND_NAME,
            guildId: fixture.guildId,
            invokerId: fakeSnowflake(),
            invokerPermissions: NO_MANAGE_GUILD,
            invokerRoles: [fixture.allowedRoleId],
            interactionToken: firstToken,
            targetMessageId: fixture.sourceMessageId,
            targetChannelId: fixture.sourceChannelId,
            targetAuthorId: fixture.sourceAuthorUserId,
          }),
        ),
      );
      await waitForCall(calls, (call) => call.url === followupUrl(firstToken));

      const secondToken = `token-${fakeSnowflake()}`;
      const secondClipperId = fakeSnowflake();
      await POST(
        signedRequest(
          contextCommandInvocation({
            commandName: CLIP_COMMAND_NAME,
            guildId: fixture.guildId,
            invokerId: secondClipperId,
            invokerPermissions: NO_MANAGE_GUILD,
            invokerRoles: [fixture.allowedRoleId],
            interactionToken: secondToken,
            targetMessageId: fixture.sourceMessageId,
            targetChannelId: fixture.sourceChannelId,
            targetAuthorId: fixture.sourceAuthorUserId,
          }),
        ),
      );
      const secondFollowup = await waitForCall(calls, (call) => call.url === followupUrl(secondToken));

      expect(secondFollowup.body).toEqual({ content: DISCORD_COPY.success });
      expect(await countClipperRows(fixture)).toBe(2);

      // The same member clipping a third time is a true duplicate.
      const thirdToken = `token-${fakeSnowflake()}`;
      await POST(
        signedRequest(
          contextCommandInvocation({
            commandName: CLIP_COMMAND_NAME,
            guildId: fixture.guildId,
            invokerId: secondClipperId,
            invokerPermissions: NO_MANAGE_GUILD,
            invokerRoles: [fixture.allowedRoleId],
            interactionToken: thirdToken,
            targetMessageId: fixture.sourceMessageId,
            targetChannelId: fixture.sourceChannelId,
            targetAuthorId: fixture.sourceAuthorUserId,
          }),
        ),
      );
      const thirdFollowup = await waitForCall(calls, (call) => call.url === followupUrl(thirdToken));
      expect(thirdFollowup.body).toEqual({ content: DISCORD_COPY.duplicate });
      expect(await countClipperRows(fixture)).toBe(2);
    });
  });

  describe('Unclip', () => {
    async function clipAs(fixture: Fixture, userId: string, calls: StubCall[]): Promise<void> {
      const token = `token-${fakeSnowflake()}`;
      await POST(
        signedRequest(
          contextCommandInvocation({
            commandName: CLIP_COMMAND_NAME,
            guildId: fixture.guildId,
            invokerId: userId,
            invokerPermissions: NO_MANAGE_GUILD,
            invokerRoles: [fixture.allowedRoleId],
            interactionToken: token,
            targetMessageId: fixture.sourceMessageId,
            targetChannelId: fixture.sourceChannelId,
            targetAuthorId: fixture.sourceAuthorUserId,
          }),
        ),
      );
      await waitForCall(calls, (call) => call.url === followupUrl(token));
    }

    test('unclipping by member B does not remove member A signal', async () => {
      const fixture = await seedConfiguredGuild();
      const { fetchImpl, calls } = createFetchStub();
      vi.stubGlobal('fetch', fetchImpl);
      const userA = fakeSnowflake();
      const userB = fakeSnowflake();

      await clipAs(fixture, userA, calls);
      await clipAs(fixture, userB, calls);
      expect(await countClipperRows(fixture)).toBe(2);

      const unclipToken = `token-${fakeSnowflake()}`;
      await POST(
        signedRequest(
          contextCommandInvocation({
            commandName: UNCLIP_COMMAND_NAME,
            guildId: fixture.guildId,
            invokerId: userB,
            invokerPermissions: NO_MANAGE_GUILD,
            interactionToken: unclipToken,
            targetMessageId: fixture.sourceMessageId,
            targetChannelId: fixture.sourceChannelId,
            targetAuthorId: fixture.sourceAuthorUserId,
          }),
        ),
      );
      const followup = await waitForCall(calls, (call) => call.url === followupUrl(unclipToken));
      expect(followup.body).toEqual({ content: DISCORD_COPY.unclipped });

      expect(await countClipperRows(fixture)).toBe(1);
      const remainingClipper = await prisma.clipper.findFirst({
        where: { guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId },
      });
      expect(remainingClipper?.clipperUserId).toBe(userA);
      expect((await readClip(fixture))?.status).toBe('ACTIVE');

      // Signal remains, so the archive stays up: no marker removal.
      expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    });

    test('unclipping the last signal tears the archive down and removes the marker', async () => {
      const fixture = await seedConfiguredGuild();
      const { fetchImpl, calls } = createFetchStub();
      vi.stubGlobal('fetch', fetchImpl);
      const userA = fakeSnowflake();

      await clipAs(fixture, userA, calls);

      const unclipToken = `token-${fakeSnowflake()}`;
      await POST(
        signedRequest(
          contextCommandInvocation({
            commandName: UNCLIP_COMMAND_NAME,
            guildId: fixture.guildId,
            invokerId: userA,
            invokerPermissions: NO_MANAGE_GUILD,
            interactionToken: unclipToken,
            targetMessageId: fixture.sourceMessageId,
            targetChannelId: fixture.sourceChannelId,
            targetAuthorId: fixture.sourceAuthorUserId,
          }),
        ),
      );
      const followup = await waitForCall(calls, (call) => call.url === followupUrl(unclipToken));
      expect(followup.body).toEqual({ content: DISCORD_COPY.unclipped });

      await waitForCall(
        calls,
        (call) =>
          call.method === 'DELETE' &&
          call.url.includes(`/channels/${fixture.sourceChannelId}/messages/${fixture.sourceMessageId}/reactions/`),
      );
      expect(await readClip(fixture)).toBeNull();
    });

    test('unclipping with no recorded signal reports there is nothing to unclip', async () => {
      const fixture = await seedConfiguredGuild();
      const { fetchImpl, calls } = createFetchStub();
      vi.stubGlobal('fetch', fetchImpl);

      const token = `token-${fakeSnowflake()}`;
      await POST(
        signedRequest(
          contextCommandInvocation({
            commandName: UNCLIP_COMMAND_NAME,
            guildId: fixture.guildId,
            invokerId: fakeSnowflake(),
            invokerPermissions: NO_MANAGE_GUILD,
            interactionToken: token,
            targetMessageId: fixture.sourceMessageId,
            targetChannelId: fixture.sourceChannelId,
            targetAuthorId: fixture.sourceAuthorUserId,
          }),
        ),
      );
      const followup = await waitForCall(calls, (call) => call.url === followupUrl(token));
      expect(followup.body).toEqual({ content: DISCORD_COPY.nothingToUnclip });
    });
  });

  describe('Remove from Clip Archive', () => {
    async function clipAs(fixture: Fixture, userId: string, calls: StubCall[]): Promise<void> {
      const token = `token-${fakeSnowflake()}`;
      await POST(
        signedRequest(
          contextCommandInvocation({
            commandName: CLIP_COMMAND_NAME,
            guildId: fixture.guildId,
            invokerId: userId,
            invokerPermissions: NO_MANAGE_GUILD,
            invokerRoles: [fixture.allowedRoleId],
            interactionToken: token,
            targetMessageId: fixture.sourceMessageId,
            targetChannelId: fixture.sourceChannelId,
            targetAuthorId: fixture.sourceAuthorUserId,
          }),
        ),
      );
      await waitForCall(calls, (call) => call.url === followupUrl(token));
    }

    test('a non-author, non-admin cannot remove the archive', async () => {
      const fixture = await seedConfiguredGuild();
      const { fetchImpl, calls } = createFetchStub();
      vi.stubGlobal('fetch', fetchImpl);
      await clipAs(fixture, fakeSnowflake(), calls);

      const token = `token-${fakeSnowflake()}`;
      await POST(
        signedRequest(
          contextCommandInvocation({
            commandName: REMOVE_FROM_CLIP_ARCHIVE_COMMAND_NAME,
            guildId: fixture.guildId,
            invokerId: fakeSnowflake(), // neither the author nor a manager
            invokerPermissions: NO_MANAGE_GUILD,
            interactionToken: token,
            targetMessageId: fixture.sourceMessageId,
            targetChannelId: fixture.sourceChannelId,
            targetAuthorId: fixture.sourceAuthorUserId,
          }),
        ),
      );
      const followup = await waitForCall(calls, (call) => call.url === followupUrl(token));
      expect(followup.body).toEqual({ content: DISCORD_COPY.noPermission });

      expect((await readClip(fixture))?.status).toBe('ACTIVE');
      expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    });

    test('the source author can remove their own archived message', async () => {
      const fixture = await seedConfiguredGuild();
      const { fetchImpl, calls } = createFetchStub();
      vi.stubGlobal('fetch', fetchImpl);
      await clipAs(fixture, fakeSnowflake(), calls);

      const token = `token-${fakeSnowflake()}`;
      await POST(
        signedRequest(
          contextCommandInvocation({
            commandName: REMOVE_FROM_CLIP_ARCHIVE_COMMAND_NAME,
            guildId: fixture.guildId,
            invokerId: fixture.sourceAuthorUserId,
            invokerPermissions: NO_MANAGE_GUILD,
            interactionToken: token,
            targetMessageId: fixture.sourceMessageId,
            targetChannelId: fixture.sourceChannelId,
            targetAuthorId: fixture.sourceAuthorUserId,
          }),
        ),
      );
      const followup = await waitForCall(calls, (call) => call.url === followupUrl(token));
      expect(followup.body).toEqual({ content: DISCORD_COPY.unclipped });

      const clip = await readClip(fixture);
      expect(clip?.status).toBe('REMOVED_BY_AUTHOR');
      await waitForCall(
        calls,
        (call) =>
          call.method === 'DELETE' &&
          call.url.includes(`/channels/${fixture.sourceChannelId}/messages/${fixture.sourceMessageId}/reactions/`),
      );
    });

    test('a guild admin can remove a message they did not author', async () => {
      const fixture = await seedConfiguredGuild();
      const { fetchImpl, calls } = createFetchStub();
      vi.stubGlobal('fetch', fetchImpl);
      await clipAs(fixture, fakeSnowflake(), calls);

      const token = `token-${fakeSnowflake()}`;
      await POST(
        signedRequest(
          contextCommandInvocation({
            commandName: REMOVE_FROM_CLIP_ARCHIVE_COMMAND_NAME,
            guildId: fixture.guildId,
            invokerId: fakeSnowflake(),
            invokerPermissions: MANAGE_GUILD_ONLY,
            interactionToken: token,
            targetMessageId: fixture.sourceMessageId,
            targetChannelId: fixture.sourceChannelId,
            targetAuthorId: fixture.sourceAuthorUserId,
          }),
        ),
      );
      const followup = await waitForCall(calls, (call) => call.url === followupUrl(token));
      expect(followup.body).toEqual({ content: DISCORD_COPY.unclipped });
      expect((await readClip(fixture))?.status).toBe('REMOVED_BY_ADMIN');
    });
  });
});
