import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createClipService } from '@/lib/clip/service';
import {
  ArchiveCreationFailedError,
  type ClipCommandResult,
  type ClipInput,
  type UnclipResult,
} from '@/lib/clip/types';
import type { PrismaClient } from '@/generated/prisma/client';
import { createFakeGateway, type FakeDiscordArchiveGateway } from '../clip/fake-gateway';

/*
 * Spec §9 races driven through the service against a real Postgres, so the
 * Discord side effect (the fake gateway's call log) is counted alongside the
 * rows. The repository-level races in tests/clip/repository.test.ts cover the
 * SQL alone; these cover what the service does with it.
 *
 * `Promise.all` alone rarely lands inside the windows that matter, which are
 * the Discord round-trips the service makes outside any lock. The fake
 * gateway's one-shot hooks run concurrent requests inside exactly those
 * windows. Nothing asserts inside a hook: a throw there is swallowed by the
 * service's own error handling and would read as a product outcome.
 */

// N concurrent requests. Each one holds a pool connection while it waits on
// the guild lock, and node-postgres' default pool is 10, so N stays below it:
// above that the race silently becomes a queue.
const N = 6;

function fakeSnowflake(): string {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

function users(count: number): string[] {
  return Array.from({ length: count }, fakeSnowflake);
}

describe('clip service under concurrency', () => {
  let prisma: PrismaClient;
  let gateway: FakeDiscordArchiveGateway;
  let service: ReturnType<typeof createClipService>;
  const cleanupGuildIds: string[] = [];

  beforeAll(async () => {
    // lib/db.ts validates the full Env on first use; DATABASE_URL comes from
    // the invoking command.
    vi.stubEnv('DISCORD_APPLICATION_ID', '1539212298600718416');
    vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
    vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-value');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');
    prisma = (await import('@/lib/db')).getPrismaClient();
  });

  beforeEach(() => {
    gateway = createFakeGateway();
    service = createClipService(gateway);
    // State transitions log to stdout; tests/clip/service.test.ts asserts the
    // payloads, so the stub here only keeps output pristine.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Both foreign keys are RESTRICT, so children go first.
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

  async function seedConfiguredGuild(): Promise<Fixture> {
    const fixture: Fixture = {
      guildId: fakeSnowflake(),
      archiveChannelId: fakeSnowflake(),
      allowedRoleId: fakeSnowflake(),
      sourceChannelId: fakeSnowflake(),
      sourceMessageId: fakeSnowflake(),
      sourceAuthorUserId: fakeSnowflake(),
    };
    cleanupGuildIds.push(fixture.guildId);
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

  function clipAs(fixture: Fixture, clipperUserId: string): Promise<ClipCommandResult> {
    const input: ClipInput = {
      guildId: fixture.guildId,
      sourceChannelId: fixture.sourceChannelId,
      sourceMessageId: fixture.sourceMessageId,
      sourceAuthorUserId: fixture.sourceAuthorUserId,
      clipperUserId,
      clipperRoleIds: [fixture.allowedRoleId],
      clipperHasManageGuild: false,
    };
    return service.clip(input);
  }

  function unclipAs(fixture: Fixture, clipperUserId: string): Promise<UnclipResult> {
    return service.unclip({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      clipperUserId,
    });
  }

  function removeAsAuthor(fixture: Fixture) {
    return service.removeByAuthorOrAdmin({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      invokerUserId: fixture.sourceAuthorUserId,
      invokerHasManageGuild: false,
    });
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

  function kinds(results: readonly { kind: string }[]): string[] {
    return results.map((result) => result.kind).sort();
  }

  /** A seeded ACTIVE Clip with every user in `clippers` signalled. */
  async function activeClipWith(fixture: Fixture, clippers: readonly string[]): Promise<void> {
    for (const clipper of clippers) {
      await clipAs(fixture, clipper);
    }
    expect((await readClip(fixture))?.status).toBe('ACTIVE');
    expect(gateway.createCalls).toHaveLength(1);
  }

  test('parallel clips of one source by different users post one archive and record every clipper', async () => {
    const fixture = await seedConfiguredGuild();
    const racers = users(N);
    // A second wave lands inside the creator's Discord round-trip, while the
    // row is still PENDING with no archive: the window where "should I create
    // too?" is most tempting to answer wrongly.
    const insideCreate = users(N);
    let insideResults: ClipCommandResult[] = [];
    gateway.onNextCreate(async () => {
      insideResults = await Promise.all(insideCreate.map((user) => clipAs(fixture, user)));
    });

    const results = await Promise.all(racers.map((user) => clipAs(fixture, user)));

    expect(gateway.createCalls).toHaveLength(1);
    expect(kinds(results)).toEqual(['CREATED', ...Array(N - 1).fill('CLIPPER_ADDED')].sort());
    expect(kinds(insideResults)).toEqual(Array(N).fill('CLIPPER_ADDED'));
    const clip = await readClip(fixture);
    expect(clip?.status).toBe('ACTIVE');
    expect(clip?.archiveProvenanceMessageId).toBe('provenance-1');
    expect(await countClipperRows(fixture)).toBe(2 * N);
    expect(gateway.deleteCalls).toHaveLength(0);
  });

  test('parallel clips by one user record one signal and post one archive', async () => {
    const fixture = await seedConfiguredGuild();
    const user = fakeSnowflake();
    let insideResults: ClipCommandResult[] = [];
    gateway.onNextCreate(async () => {
      insideResults = await Promise.all(Array.from({ length: N }, () => clipAs(fixture, user)));
    });

    const results = await Promise.all(Array.from({ length: N }, () => clipAs(fixture, user)));

    expect(gateway.createCalls).toHaveLength(1);
    expect(kinds(results)).toEqual(
      ['CREATED', ...Array(N - 1).fill('ALREADY_CLIPPED_BY_USER')].sort(),
    );
    expect(kinds(insideResults)).toEqual(Array(N).fill('ALREADY_CLIPPED_BY_USER'));
    expect((await readClip(fixture))?.status).toBe('ACTIVE');
    expect(await countClipperRows(fixture)).toBe(1);
  });

  test('parallel final unclips by every clipper delete the archive exactly once', async () => {
    const fixture = await seedConfiguredGuild();
    const clippers = users(N);
    await activeClipWith(fixture, clippers);

    const results = await Promise.all(clippers.map((user) => unclipAs(fixture, user)));

    expect(kinds(results)).toEqual(Array(N).fill('UNCLIPPED'));
    // Exactly one unclip saw zero remaining; every other count is distinct.
    const remaining = results.map((result) => (result.kind === 'UNCLIPPED' ? result.remaining : -1));
    expect(remaining.sort()).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(gateway.deleteCalls).toEqual([
      {
        archiveChannelId: fixture.archiveChannelId,
        ids: { provenanceMessageId: 'provenance-1', forwardMessageId: 'forward-1' },
      },
    ]);
    expect(await readClip(fixture)).toBeNull();
    expect(await countClipperRows(fixture)).toBe(0);
  });

  test('author removal inside the first archive round-trip wins over every racing clip', async () => {
    // The removal commits after the claim and before the archive publishes:
    // the creator's freshly posted pair must come back down, not go ACTIVE.
    const fixture = await seedConfiguredGuild();
    let removal: Awaited<ReturnType<typeof removeAsAuthor>> | undefined;
    gateway.onNextCreate(async () => {
      removal = await removeAsAuthor(fixture);
    });

    const results = await Promise.all(users(N).map((user) => clipAs(fixture, user)));

    expect(removal).toEqual({ kind: 'REMOVED' });
    expect(gateway.createCalls).toHaveLength(1);
    // The creator reports the tombstone; a racer reports either the signal it
    // recorded before the removal (which the removal then dropped) or the
    // tombstone. None reports an archive.
    expect(results.filter((result) => result.kind === 'REMOVED_BY_AUTHOR_OR_ADMIN').length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      expect(['CLIPPER_ADDED', 'REMOVED_BY_AUTHOR_OR_ADMIN']).toContain(result.kind);
      if (result.kind === 'CLIPPER_ADDED') {
        expect(result.archive).toBeNull();
      }
    }
    expect(gateway.deleteCalls).toEqual([
      {
        archiveChannelId: fixture.archiveChannelId,
        ids: { provenanceMessageId: 'provenance-1', forwardMessageId: 'forward-1' },
      },
    ]);
    const tombstone = await readClip(fixture);
    expect(tombstone?.status).toBe('REMOVED_BY_AUTHOR');
    expect(tombstone?.archiveProvenanceMessageId).toBeNull();
    expect(tombstone?.archiveForwardMessageId).toBeNull();
    expect(await countClipperRows(fixture)).toBe(0);

    const later = await Promise.all(users(N).map((user) => clipAs(fixture, user)));
    expect(kinds(later)).toEqual(Array(N).fill('REMOVED_BY_AUTHOR_OR_ADMIN'));
    expect(gateway.createCalls).toHaveLength(1);
    expect(await countClipperRows(fixture)).toBe(0);
  });

  test('clips landing inside an author removal’s archive delete are refused', async () => {
    // The reverse ordering: the tombstone is committed and the Discord delete
    // is in flight when the clips arrive.
    const fixture = await seedConfiguredGuild();
    await activeClipWith(fixture, users(1));
    let insideResults: ClipCommandResult[] = [];
    gateway.onNextDelete(async () => {
      insideResults = await Promise.all(users(N).map((user) => clipAs(fixture, user)));
    });

    expect(await removeAsAuthor(fixture)).toEqual({ kind: 'REMOVED' });

    expect(kinds(insideResults)).toEqual(Array(N).fill('REMOVED_BY_AUTHOR_OR_ADMIN'));
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.deleteCalls).toHaveLength(1);
    const tombstone = await readClip(fixture);
    expect(tombstone?.status).toBe('REMOVED_BY_AUTHOR');
    expect(tombstone?.archiveProvenanceMessageId).toBeNull();
    expect(await countClipperRows(fixture)).toBe(0);
  });

  test('a retryable create failure is never ACTIVE, and parallel retries converge on one archive', async () => {
    const fixture = await seedConfiguredGuild();
    const first = fakeSnowflake();
    gateway.failNextCreate(
      new ArchiveCreationFailedError('discord rate limited the post', {
        retryable: true,
        orphanedProvenanceMessageId: null,
        step: 'provenance_post',
        failure: { failure: 'http', httpStatus: '429', discordCode: '0' },
      }),
    );

    expect(await clipAs(fixture, first)).toEqual({ kind: 'FAILED', retryable: true });
    const failed = await readClip(fixture);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.archiveProvenanceMessageId).toBeNull();
    expect(failed?.archiveForwardMessageId).toBeNull();

    // A FAILED Clip lets every clipper that reaches it build the archive, so
    // several retries may each post a pair. Exactly one may publish; every
    // other pair must be taken back down.
    const retries = await Promise.all([first, ...users(N - 1)].map((user) => clipAs(fixture, user)));

    expect(retries.filter((result) => result.kind === 'CREATED')).toHaveLength(1);
    const clip = await readClip(fixture);
    expect(clip?.status).toBe('ACTIVE');
    const winner = {
      provenanceMessageId: clip?.archiveProvenanceMessageId,
      forwardMessageId: clip?.archiveForwardMessageId,
    };
    const posted = gateway.createCalls.length - 1;
    expect(posted).toBeGreaterThanOrEqual(1);
    const postedPairs = Array.from({ length: posted }, (_, i) => ({
      provenanceMessageId: `provenance-${i + 1}`,
      forwardMessageId: `forward-${i + 1}`,
    }));
    expect(postedPairs).toContainEqual(winner);
    expect(gateway.deleteCalls.map((call) => call.ids).sort(byProvenance)).toEqual(
      postedPairs.filter((pair) => pair.provenanceMessageId !== winner.provenanceMessageId),
    );
    expect(await countClipperRows(fixture)).toBe(N);
  });

  test('a final unclip whose Discord delete fails keeps the row DELETING with its ids', async () => {
    const fixture = await seedConfiguredGuild();
    const clippers = users(N);
    await activeClipWith(fixture, clippers);
    gateway.failNextDelete(new Error('discord unavailable'));

    const results = await Promise.all(clippers.map((user) => unclipAs(fixture, user)));

    expect(kinds(results)).toEqual(Array(N).fill('UNCLIPPED'));
    expect(gateway.deleteCalls).toHaveLength(1);
    // The ids are the only handle on two messages still up in the archive
    // channel, so neither the row nor the ids may go.
    const stuck = await readClip(fixture);
    expect(stuck?.status).toBe('DELETING');
    expect(stuck?.archiveProvenanceMessageId).toBe('provenance-1');
    expect(stuck?.archiveForwardMessageId).toBe('forward-1');
    expect(await countClipperRows(fixture)).toBe(0);

    // The retry path that exists today: removal retries the same delete and
    // clears the ids once Discord confirms it.
    expect(await removeAsAuthor(fixture)).toEqual({ kind: 'REMOVED' });
    expect(gateway.deleteCalls.map((call) => call.ids)).toEqual([
      { provenanceMessageId: 'provenance-1', forwardMessageId: 'forward-1' },
      { provenanceMessageId: 'provenance-1', forwardMessageId: 'forward-1' },
    ]);
    const tombstone = await readClip(fixture);
    expect(tombstone?.status).toBe('REMOVED_BY_AUTHOR');
    expect(tombstone?.archiveProvenanceMessageId).toBeNull();
  });

  test('parallel clips landing inside the final unclip’s delete revive one archive', async () => {
    // §9.3 / §9.8 with N revivers at once: the finalizer must rebuild exactly
    // one archive for all of them, never one each and never none.
    const fixture = await seedConfiguredGuild();
    const first = fakeSnowflake();
    await activeClipWith(fixture, [first]);
    const revivers = users(N);
    let insideResults: ClipCommandResult[] = [];
    gateway.onNextDelete(async () => {
      insideResults = await Promise.all(revivers.map((user) => clipAs(fixture, user)));
    });

    expect(await unclipAs(fixture, first)).toEqual({ kind: 'UNCLIPPED', remaining: 0 });

    expect(kinds(insideResults)).toEqual(Array(N).fill('CLIPPER_ADDED'));
    expect(gateway.createCalls).toHaveLength(2);
    expect(gateway.deleteCalls).toHaveLength(1);
    const clip = await readClip(fixture);
    expect(clip?.status).toBe('ACTIVE');
    expect(clip?.archiveProvenanceMessageId).toBe('provenance-2');
    expect(clip?.archiveForwardMessageId).toBe('forward-2');
    expect(await countClipperRows(fixture)).toBe(N);
  });
});

function byProvenance(
  a: { provenanceMessageId: string },
  b: { provenanceMessageId: string },
): number {
  return a.provenanceMessageId.localeCompare(b.provenanceMessageId);
}
