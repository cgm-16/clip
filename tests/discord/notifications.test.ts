import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createClipService } from '@/lib/clip/service';
import type { ClipInput } from '@/lib/clip/types';
import type { prisma as PrismaSingleton } from '@/lib/db';
import { DISCORD_COPY } from '@/lib/discord/copy';
import {
  buildRemoveFromArchiveCustomId,
  handleRemoveButtonInteraction,
  notifyAuthorOfFirstArchival,
  parseRemoveFromArchiveCustomId,
} from '@/lib/discord/notifications';
import { createFakeGateway, type FakeDiscordArchiveGateway } from '../clip/fake-gateway';

const BOT_TOKEN = 'bot-token-value';

function fakeSnowflake(): string {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

type StubResponse = { status: number; body: unknown };

function json(body: unknown, status = 200): StubResponse {
  return { status, body };
}

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function stubFetch(responses: readonly StubResponse[]) {
  const calls: Call[] = [];
  let index = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const next = responses[index];
    index += 1;
    if (next === undefined) {
      throw new Error(`unexpected fetch call ${index}: ${String(url)}`);
    }
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return new Response(next.body === null ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const DM_CHANNEL_ID = '3000000000000000001';

describe('discord notifications', () => {
  let prisma: typeof PrismaSingleton;
  let gateway: FakeDiscordArchiveGateway;
  let service: ReturnType<typeof createClipService>;

  beforeAll(async () => {
    vi.stubEnv('DISCORD_APPLICATION_ID', '1539212298600718416');
    vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
    vi.stubEnv('DISCORD_BOT_TOKEN', BOT_TOKEN);
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');

    ({ prisma } = await import('@/lib/db'));
  });

  const cleanupGuildIds: string[] = [];

  beforeEach(() => {
    gateway = createFakeGateway();
    service = createClipService(gateway);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
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

  function clipInput(fixture: Fixture, clipperUserId: string): ClipInput {
    return {
      guildId: fixture.guildId,
      sourceChannelId: fixture.sourceChannelId,
      sourceMessageId: fixture.sourceMessageId,
      sourceAuthorUserId: fixture.sourceAuthorUserId,
      clipperUserId,
      clipperRoleIds: [fixture.allowedRoleId],
      clipperHasManageGuild: false,
    };
  }

  function readClip(fixture: Fixture) {
    return prisma.clip.findUnique({
      where: {
        guildId_sourceMessageId: {
          guildId: fixture.guildId,
          sourceMessageId: fixture.sourceMessageId,
        },
      },
    });
  }

  function countClipperRows(fixture: Fixture): Promise<number> {
    return prisma.clipper.count({
      where: { guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId },
    });
  }

  async function createArchivedClip(fixture: Fixture): Promise<void> {
    const result = await service.clip(clipInput(fixture, fakeSnowflake()));
    if (result.kind !== 'CREATED') {
      throw new Error(`fixture setup expected CREATED, got ${result.kind}`);
    }
  }

  describe('notifyAuthorOfFirstArchival', () => {
    test('opens a DM with the author and posts the copy with both actions', async () => {
      const fixture = await seedConfiguredGuild();
      await createArchivedClip(fixture);
      const { fetchImpl, calls } = stubFetch([
        json({ id: DM_CHANNEL_ID }),
        json({ id: '4000000000000000001' }),
      ]);

      const result = await notifyAuthorOfFirstArchival(
        { guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId, guildName: 'Test Guild', channelName: 'general' },
        { botToken: BOT_TOKEN, fetchImpl },
      );

      expect(result).toEqual({ kind: 'DELIVERED' });
      expect(calls).toHaveLength(2);

      const [open, post] = calls;
      expect(open.method).toBe('POST');
      expect(open.url).toContain('/users/@me/channels');
      // The recipient must come from the Clip row, never from caller input --
      // the same protection §11.3 wants for the removal path, applied here to
      // where the DM goes.
      expect(open.body).toEqual({ recipient_id: fixture.sourceAuthorUserId });

      expect(post.method).toBe('POST');
      expect(post.url).toContain(`/channels/${DM_CHANNEL_ID}/messages`);
      expect(post.body?.content).toBe(
        DISCORD_COPY.firstArchivalDm.replace('{guild}', 'Test Guild').replace('{channel}', 'general'),
      );

      const components = post.body?.components as Array<{ components: Array<Record<string, unknown>> }>;
      const buttons = components[0].components;
      const viewOriginal = buttons.find((b) => b.style === 5);
      const remove = buttons.find((b) => b.style !== 5);
      expect(viewOriginal).toMatchObject({
        label: DISCORD_COPY.firstArchivalDmViewOriginal,
        url: `https://discord.com/channels/${fixture.guildId}/${fixture.sourceChannelId}/${fixture.sourceMessageId}`,
      });
      expect(remove).toMatchObject({
        label: DISCORD_COPY.firstArchivalDmRemoveFromArchive,
        custom_id: buildRemoveFromArchiveCustomId(fixture.guildId, fixture.sourceMessageId),
      });

      const clip = await readClip(fixture);
      expect(clip?.authorNotificationStatus).toBe('DELIVERED');
    });

    test('suppresses mentions so a troll guild/channel name cannot ping anyone', async () => {
      const fixture = await seedConfiguredGuild();
      await createArchivedClip(fixture);
      const { fetchImpl, calls } = stubFetch([
        json({ id: DM_CHANNEL_ID }),
        json({ id: '4000000000000000002' }),
      ]);

      await notifyAuthorOfFirstArchival(
        { guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId, guildName: '@everyone', channelName: 'general' },
        { botToken: BOT_TOKEN, fetchImpl },
      );

      expect(calls[1].body?.allowed_mentions).toEqual({ parse: [] });
    });

    test('a DM the recipient has closed (50007) is UNDELIVERABLE and does not touch the clip', async () => {
      const fixture = await seedConfiguredGuild();
      await createArchivedClip(fixture);
      const { fetchImpl } = stubFetch([
        json({ id: DM_CHANNEL_ID }),
        json({ code: 50007, message: 'Cannot send messages to this user' }, 403),
      ]);

      const result = await notifyAuthorOfFirstArchival(
        { guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId, guildName: 'Test Guild', channelName: 'general' },
        { botToken: BOT_TOKEN, fetchImpl },
      );

      expect(result).toEqual({ kind: 'UNDELIVERABLE' });
      const clip = await readClip(fixture);
      expect(clip?.authorNotificationStatus).toBe('UNDELIVERABLE');
      // §17 case 9: the Clip stays valid; a DM failure never rolls it back.
      expect(clip?.status).toBe('ACTIVE');
    });

    test('a failure opening the DM channel is also UNDELIVERABLE, never fatal', async () => {
      const fixture = await seedConfiguredGuild();
      await createArchivedClip(fixture);
      const { fetchImpl } = stubFetch([json({ code: 50007, message: 'Cannot send messages to this user' }, 403)]);

      const result = await notifyAuthorOfFirstArchival(
        { guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId, guildName: 'Test Guild', channelName: 'general' },
        { botToken: BOT_TOKEN, fetchImpl },
      );

      expect(result).toEqual({ kind: 'UNDELIVERABLE' });
      expect((await readClip(fixture))?.authorNotificationStatus).toBe('UNDELIVERABLE');
    });

    test('a second clipper on the same message never triggers a second DM', async () => {
      const fixture = await seedConfiguredGuild();
      await createArchivedClip(fixture);
      const first = stubFetch([json({ id: DM_CHANNEL_ID }), json({ id: '4000000000000000003' })]);

      const firstResult = await notifyAuthorOfFirstArchival(
        { guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId, guildName: 'Test Guild', channelName: 'general' },
        { botToken: BOT_TOKEN, fetchImpl: first.fetchImpl },
      );
      expect(firstResult).toEqual({ kind: 'DELIVERED' });

      // A later request joins the same canonical Clip as a second clipper.
      // The route that would call notify only does so on a first ("CREATED")
      // archival -- this test proves the guard notify itself owns: calling it
      // again for the same Clip, whatever the caller's reason, is a no-op.
      await service.clip(clipInput(fixture, fakeSnowflake()));

      const second = stubFetch([]);
      const secondResult = await notifyAuthorOfFirstArchival(
        { guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId, guildName: 'Test Guild', channelName: 'general' },
        { botToken: BOT_TOKEN, fetchImpl: second.fetchImpl },
      );

      expect(secondResult).toEqual({ kind: 'SKIPPED' });
      expect(second.calls).toHaveLength(0);
      expect(await countClipperRows(fixture)).toBe(2);
    });

    test('calling notify twice in a row (a retried request) sends exactly one DM', async () => {
      const fixture = await seedConfiguredGuild();
      await createArchivedClip(fixture);
      const first = stubFetch([json({ id: DM_CHANNEL_ID }), json({ id: '4000000000000000004' })]);

      await notifyAuthorOfFirstArchival(
        { guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId, guildName: 'Test Guild', channelName: 'general' },
        { botToken: BOT_TOKEN, fetchImpl: first.fetchImpl },
      );

      const retry = stubFetch([]);
      const retryResult = await notifyAuthorOfFirstArchival(
        { guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId, guildName: 'Test Guild', channelName: 'general' },
        { botToken: BOT_TOKEN, fetchImpl: retry.fetchImpl },
      );

      expect(retryResult).toEqual({ kind: 'SKIPPED' });
      expect(retry.calls).toHaveLength(0);
    });
  });

  describe('custom_id encoding', () => {
    test('round-trips guild and source message id', () => {
      const guildId = fakeSnowflake();
      const sourceMessageId = fakeSnowflake();

      const customId = buildRemoveFromArchiveCustomId(guildId, sourceMessageId);

      expect(customId.length).toBeLessThanOrEqual(100);
      expect(parseRemoveFromArchiveCustomId(customId)).toEqual({ guildId, sourceMessageId });
    });

    test('rejects a custom_id it did not build', () => {
      expect(parseRemoveFromArchiveCustomId('not_a_clip_custom_id')).toBeNull();
      expect(parseRemoveFromArchiveCustomId('clip_remove_from_dm:onlyoneparts')).toBeNull();
    });
  });

  describe('handleRemoveButtonInteraction', () => {
    test('the author can remove their own archive', async () => {
      const fixture = await seedConfiguredGuild();
      await createArchivedClip(fixture);
      const customId = buildRemoveFromArchiveCustomId(fixture.guildId, fixture.sourceMessageId);

      const result = await handleRemoveButtonInteraction(
        { customId, interactingUserId: fixture.sourceAuthorUserId },
        { gateway },
      );

      expect(result).toEqual({ kind: 'REMOVED' });
      expect(gateway.deleteCalls).toHaveLength(1);
      const tombstone = await readClip(fixture);
      expect(tombstone?.status).toBe('REMOVED_BY_AUTHOR');
    });

    // Non-vacuous coverage of §11.3's server-side re-check: a forged or
    // shared custom_id carries the guild and message id, but the interacting
    // user is not this Clip's author. The request must be refused, and
    // refused all the way down -- nothing about the Clip may change.
    test('a different user cannot remove someone else\'s archive', async () => {
      const fixture = await seedConfiguredGuild();
      await createArchivedClip(fixture);
      const customId = buildRemoveFromArchiveCustomId(fixture.guildId, fixture.sourceMessageId);
      const impostorUserId = fakeSnowflake();

      const result = await handleRemoveButtonInteraction(
        { customId, interactingUserId: impostorUserId },
        { gateway },
      );

      expect(result).toEqual({ kind: 'NOT_AUTHORIZED' });
      expect(gateway.deleteCalls).toHaveLength(0);
      const clip = await readClip(fixture);
      expect(clip?.status).toBe('ACTIVE');
      expect(clip?.archiveProvenanceMessageId).toBe('provenance-1');
      expect(clip?.archiveForwardMessageId).toBe('forward-1');
      expect(await countClipperRows(fixture)).toBe(1);
    });

    test('a forged custom_id is refused cleanly, not thrown', async () => {
      const result = await handleRemoveButtonInteraction(
        { customId: 'garbage', interactingUserId: fakeSnowflake() },
        { gateway },
      );

      expect(result).toEqual({ kind: 'INVALID_CUSTOM_ID' });
      expect(gateway.deleteCalls).toHaveLength(0);
    });
  });
});
