/**
 * The DM's `아카이브에서 제거` button (product spec §11.1/§11.3), end to end
 * through the route: Discord's MESSAGE_COMPONENT interaction (type 3) must
 * reach `handleRemoveButtonInteraction` and answer with its mapped copy.
 *
 * A DM interaction carries `user`, never `member` -- there is no guild
 * member object to read in a DM -- so the author-check test below is the
 * one that would catch a route that mistakenly read `interaction.member.user.id`
 * (undefined in a DM) instead of `interaction.user.id`.
 */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { CLIP_COMMAND_NAME } from '@/lib/discord/commands';
import { DISCORD_COPY } from '@/lib/discord/copy';
import { removeButtonResultCopy } from '@/lib/discord/interaction-responses';
import { buildRemoveFromArchiveCustomId, type RemoveButtonInteractionResult } from '@/lib/discord/notifications';
import type { prisma as PrismaSingleton } from '@/lib/db';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

const APPLICATION_ID = '1539212298600718416';
const BASE_URL = 'https://clipendpoint.cc';
const BOT_TOKEN = 'bot-token-value';

const MESSAGE_COMPONENT_INTERACTION_TYPE = 3;
const APPLICATION_COMMAND_INTERACTION_TYPE = 2;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
const EPHEMERAL_FLAG = 64;

const NO_MANAGE_GUILD = ((1n << 5n) - 1n).toString();

function fakeSnowflake(): string {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

function signBody(body: string, timestamp: string): { signature: string; timestamp: string } {
  const timestampValue = timestamp;
  const signature = sign(null, Buffer.from(timestampValue + body), privateKey).toString('hex');
  return { signature, timestamp: timestampValue };
}

function signedRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const { signature, timestamp } = signBody(body, '1700000000');
  return new Request(`${BASE_URL}/api/discord/interactions`, {
    method: 'POST',
    headers: {
      'X-Signature-Ed25519': signature,
      'X-Signature-Timestamp': timestamp,
    },
    body,
  });
}

/** A DM interaction on the archive DM's remove button. Carries `user`, never `member`. */
function removeButtonInvocation(opts: {
  interactionToken: string;
  customId: string;
  userId: string;
}): unknown {
  return {
    type: MESSAGE_COMPONENT_INTERACTION_TYPE,
    token: opts.interactionToken,
    user: { id: opts.userId },
    data: { custom_id: opts.customId, component_type: 2 },
  };
}

function contextCommandInvocation(opts: {
  commandName: string;
  guildId: string;
  invokerId: string;
  invokerPermissions: string;
  invokerRoles?: string[];
  interactionToken: string;
  targetMessageId: string;
  targetChannelId: string;
  targetAuthorId: string;
}): unknown {
  return {
    type: APPLICATION_COMMAND_INTERACTION_TYPE,
    token: opts.interactionToken,
    guild_id: opts.guildId,
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

describe('removeButtonResultCopy', () => {
  // Every `RemoveButtonInteractionResult` variant maps to exactly one line
  // of copy, mirroring the `test.each` tables in `context-commands.test.ts`
  // for the other result unions. `REMOVED`/`NOT_FOUND`/`NOT_AUTHORIZED`/`FAILED`
  // are delegated to `removeResultCopy`; this table proves the delegation
  // actually reaches every one of them, not just the ones the route tests
  // below happen to exercise.
  const cases: Array<[string, RemoveButtonInteractionResult, string]> = [
    ['REMOVED', { kind: 'REMOVED' }, DISCORD_COPY.unclipped],
    ['NOT_FOUND', { kind: 'NOT_FOUND' }, DISCORD_COPY.nothingToUnclip],
    ['NOT_AUTHORIZED', { kind: 'NOT_AUTHORIZED' }, DISCORD_COPY.noPermission],
    ['FAILED', { kind: 'FAILED', retryable: true }, DISCORD_COPY.transientFailure],
    ['INVALID_CUSTOM_ID', { kind: 'INVALID_CUSTOM_ID' }, DISCORD_COPY.nothingToUnclip],
  ];
  test.each(cases)('%s maps to its copy', (_label, result, expected) => {
    expect(removeButtonResultCopy(result)).toBe(expected);
  });
});

describe('POST /api/discord/interactions -- MESSAGE_COMPONENT (remove-from-archive button)', () => {
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
      where: { guildId_sourceMessageId: { guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId } },
    });
  }

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

  test('is answered with a deferred ephemeral response, then a follow-up', async () => {
    const fixture = await seedConfiguredGuild();
    const { fetchImpl, calls } = createFetchStub();
    vi.stubGlobal('fetch', fetchImpl);
    await clipAs(fixture, fakeSnowflake(), calls);

    const token = `token-${fakeSnowflake()}`;
    const customId = buildRemoveFromArchiveCustomId(fixture.guildId, fixture.sourceMessageId);

    const response = await POST(
      signedRequest(
        removeButtonInvocation({ interactionToken: token, customId, userId: fixture.sourceAuthorUserId }),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: EPHEMERAL_FLAG },
    });

    const followup = await waitForCall(calls, (call) => call.url === followupUrl(token));
    expect(followup.body).toEqual({ content: DISCORD_COPY.unclipped });
  });

  test('the author removes the archive from the DM button', async () => {
    const fixture = await seedConfiguredGuild();
    const { fetchImpl, calls } = createFetchStub();
    vi.stubGlobal('fetch', fetchImpl);
    await clipAs(fixture, fakeSnowflake(), calls);

    const token = `token-${fakeSnowflake()}`;
    const customId = buildRemoveFromArchiveCustomId(fixture.guildId, fixture.sourceMessageId);

    await POST(
      signedRequest(
        removeButtonInvocation({ interactionToken: token, customId, userId: fixture.sourceAuthorUserId }),
      ),
    );

    const followup = await waitForCall(calls, (call) => call.url === followupUrl(token));
    expect(followup.body).toEqual({ content: DISCORD_COPY.unclipped });

    const clip = await readClip(fixture);
    expect(clip?.status).toBe('REMOVED_BY_AUTHOR');
    await waitForCall(calls, (call) => call.method === 'DELETE');
  });

  // The custom_id is client-carried and re-verified server-side: this is the
  // whole reason `handleRemoveButtonInteraction` re-derives authorization
  // from the locked Clip row instead of trusting the click.
  test('a different user pressing the button is refused, and nothing is deleted', async () => {
    const fixture = await seedConfiguredGuild();
    const { fetchImpl, calls } = createFetchStub();
    vi.stubGlobal('fetch', fetchImpl);
    await clipAs(fixture, fakeSnowflake(), calls);

    const token = `token-${fakeSnowflake()}`;
    const customId = buildRemoveFromArchiveCustomId(fixture.guildId, fixture.sourceMessageId);
    const impostorUserId = fakeSnowflake();

    await POST(
      signedRequest(removeButtonInvocation({ interactionToken: token, customId, userId: impostorUserId })),
    );

    const followup = await waitForCall(calls, (call) => call.url === followupUrl(token));
    expect(followup.body).toEqual({ content: DISCORD_COPY.noPermission });

    const clip = await readClip(fixture);
    expect(clip?.status).toBe('ACTIVE');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  test('a malformed custom_id is refused cleanly with the mapped copy, not a 500', async () => {
    const fixture = await seedConfiguredGuild();
    const { fetchImpl, calls } = createFetchStub();
    vi.stubGlobal('fetch', fetchImpl);

    const token = `token-${fakeSnowflake()}`;
    const response = await POST(
      signedRequest(
        removeButtonInvocation({
          interactionToken: token,
          customId: 'not_a_valid_custom_id',
          userId: fixture.sourceAuthorUserId,
        }),
      ),
    );

    expect(response.status).toBe(200);
    const followup = await waitForCall(calls, (call) => call.url === followupUrl(token));
    expect(followup.body).toEqual({ content: DISCORD_COPY.nothingToUnclip });
  });
});
