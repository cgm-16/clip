import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createClipService } from '@/lib/clip/service';
import {
  ArchiveCreationFailedError,
  ArchiveTargetUnavailableError,
  type ClipInput,
} from '@/lib/clip/types';
import type { prisma as PrismaSingleton } from '@/lib/db';
import { createFakeGateway, type FakeDiscordArchiveGateway } from './fake-gateway';

// Discord snowflakes are opaque strings to us; a random per-test id keeps
// concurrent/re-run test invocations from colliding on the same row.
function fakeSnowflake(): string {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

describe('clip service', () => {
  let prisma: typeof PrismaSingleton;
  let gateway: FakeDiscordArchiveGateway;
  let service: ReturnType<typeof createClipService>;

  beforeAll(async () => {
    // lib/db.ts validates the full Env, not just DATABASE_URL, on first use of
    // the client, so every other required var needs a value before the first
    // query -- these are otherwise irrelevant to a service test.
    // DATABASE_URL is deliberately left untouched: it must come from the real
    // Postgres the test runs against, supplied by the invoking command.
    vi.stubEnv('DISCORD_APPLICATION_ID', '1539212298600718416');
    vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
    vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-value');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');

    ({ prisma } = await import('@/lib/db'));
  });

  const cleanupGuildIds: string[] = [];

  beforeEach(() => {
    gateway = createFakeGateway();
    service = createClipService(gateway);
    // The service logs every state transition to stdout. Stubbing keeps test
    // output pristine; `logs a state transition` below asserts on the payload
    // so the stub cannot hide a missing or unsafe log line.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Both foreign keys are RESTRICT by design, so children go first.
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

  test('the first clip creates exactly one archive and reaches ACTIVE', async () => {
    const fixture = await seedConfiguredGuild();
    const clipperUserId = fakeSnowflake();

    const result = await service.clip(clipInput(fixture, clipperUserId));

    expect(result).toEqual({
      kind: 'CREATED',
      archive: { provenanceMessageId: 'provenance-1', forwardMessageId: 'forward-1' },
    });
    expect(gateway.createCalls).toEqual([
      {
        guildId: fixture.guildId,
        archiveChannelId: fixture.archiveChannelId,
        sourceChannelId: fixture.sourceChannelId,
        sourceMessageId: fixture.sourceMessageId,
        sourceAuthorUserId: fixture.sourceAuthorUserId,
      },
    ]);
    const clip = await readClip(fixture);
    expect(clip?.status).toBe('ACTIVE');
    expect(clip?.archiveProvenanceMessageId).toBe('provenance-1');
    expect(clip?.archiveForwardMessageId).toBe('forward-1');
    expect(await countClipperRows(fixture)).toBe(1);
  });

  test('logs the state transition rather than anything that could carry content', async () => {
    const fixture = await seedConfiguredGuild();
    const logged = vi.mocked(console.log);

    await service.clip(clipInput(fixture, fakeSnowflake()));

    const lines = logged.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(lines).toEqual([
      {
        event: 'clip.state_changed',
        guildId: fixture.guildId,
        sourceMessageId: fixture.sourceMessageId,
        stateFrom: 'PENDING',
        stateTo: 'ACTIVE',
      },
    ]);
  });

  test('a second clipper joins the existing archive instead of creating another', async () => {
    const fixture = await seedConfiguredGuild();
    await service.clip(clipInput(fixture, fakeSnowflake()));

    const result = await service.clip(clipInput(fixture, fakeSnowflake()));

    expect(result).toEqual({
      kind: 'CLIPPER_ADDED',
      archive: { provenanceMessageId: 'provenance-1', forwardMessageId: 'forward-1' },
    });
    // §9.4 / §17 case 6: only the request that claimed the Clip may create the
    // archive, so the second clipper must not post a second pair of messages.
    expect(gateway.createCalls).toHaveLength(1);
    expect(await countClipperRows(fixture)).toBe(2);
  });

  test('the same user clipping twice is idempotent', async () => {
    const fixture = await seedConfiguredGuild();
    const clipperUserId = fakeSnowflake();
    await service.clip(clipInput(fixture, clipperUserId));

    const result = await service.clip(clipInput(fixture, clipperUserId));

    expect(result).toEqual({
      kind: 'ALREADY_CLIPPED_BY_USER',
      archive: { provenanceMessageId: 'provenance-1', forwardMessageId: 'forward-1' },
    });
    expect(gateway.createCalls).toHaveLength(1);
    expect(await countClipperRows(fixture)).toBe(1);
  });

  test('an unauthorized member writes no state and posts nothing', async () => {
    const fixture = await seedConfiguredGuild();

    const result = await service.clip({
      ...clipInput(fixture, fakeSnowflake()),
      clipperRoleIds: [fakeSnowflake()],
      clipperHasManageGuild: false,
    });

    expect(result).toEqual({ kind: 'NOT_AUTHORIZED' });
    expect(await readClip(fixture)).toBeNull();
    expect(await countClipperRows(fixture)).toBe(0);
    expect(gateway.createCalls).toHaveLength(0);
  });

  test('an unconfigured guild fails safely without writing state', async () => {
    // §17 case 12: clipping fails until an admin configures an archive channel.
    const fixture = newFixture();

    const result = await service.clip(clipInput(fixture, fakeSnowflake()));

    expect(result).toEqual({ kind: 'FAILED', retryable: false });
    expect(await readClip(fixture)).toBeNull();
    expect(gateway.createCalls).toHaveLength(0);
  });

  test('the last unclip deletes both archive messages and the Clip row', async () => {
    const fixture = await seedConfiguredGuild();
    const clipperUserId = fakeSnowflake();
    await service.clip(clipInput(fixture, clipperUserId));

    const result = await service.unclip({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      clipperUserId,
    });

    expect(result).toEqual({ kind: 'UNCLIPPED', remaining: 0 });
    expect(gateway.deleteCalls).toEqual([
      {
        archiveChannelId: fixture.archiveChannelId,
        ids: { provenanceMessageId: 'provenance-1', forwardMessageId: 'forward-1' },
      },
    ]);
    expect(await readClip(fixture)).toBeNull();
    expect(await countClipperRows(fixture)).toBe(0);
  });

  test('an unclip with clippers remaining leaves the archive untouched', async () => {
    const fixture = await seedConfiguredGuild();
    const first = fakeSnowflake();
    await service.clip(clipInput(fixture, first));
    await service.clip(clipInput(fixture, fakeSnowflake()));

    const result = await service.unclip({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      clipperUserId: first,
    });

    expect(result).toEqual({ kind: 'UNCLIPPED', remaining: 1 });
    expect(gateway.deleteCalls).toHaveLength(0);
    const clip = await readClip(fixture);
    expect(clip?.status).toBe('ACTIVE');
    expect(clip?.archiveProvenanceMessageId).toBe('provenance-1');
    expect(clip?.archiveForwardMessageId).toBe('forward-1');
    expect(await countClipperRows(fixture)).toBe(1);
  });

  test('unclipping a Clip nobody signalled for reports NOT_CLIPPED_BY_USER', async () => {
    const fixture = await seedConfiguredGuild();
    await service.clip(clipInput(fixture, fakeSnowflake()));

    const result = await service.unclip({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      clipperUserId: fakeSnowflake(),
    });

    expect(result).toEqual({ kind: 'NOT_CLIPPED_BY_USER' });
    expect(gateway.deleteCalls).toHaveLength(0);
  });

  test('unclipping a message that was never clipped reports NOT_FOUND', async () => {
    const fixture = await seedConfiguredGuild();

    const result = await service.unclip({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      clipperUserId: fakeSnowflake(),
    });

    expect(result).toEqual({ kind: 'NOT_FOUND' });
  });

  test('the last unclip of a FAILED Clip deletes the row without a Discord delete', async () => {
    // The archive never existed, so `PENDING/FAILED -> DELETING` still has to
    // reach the row deletion or the Clip is stranded DELETING forever.
    const fixture = await seedConfiguredGuild();
    const clipperUserId = fakeSnowflake();
    gateway.failNextCreate(
      new ArchiveCreationFailedError('discord rejected the forward', {
        retryable: true,
        orphanedProvenanceMessageId: null,
      }),
    );
    await service.clip(clipInput(fixture, clipperUserId));

    const result = await service.unclip({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      clipperUserId,
    });

    expect(result).toEqual({ kind: 'UNCLIPPED', remaining: 0 });
    expect(gateway.deleteCalls).toHaveLength(0);
    expect(await readClip(fixture)).toBeNull();
    expect(await countClipperRows(fixture)).toBe(0);
  });

  test('author removal deletes the archive and leaves a tombstone that blocks recreation', async () => {
    const fixture = await seedConfiguredGuild();
    await service.clip(clipInput(fixture, fakeSnowflake()));

    const result = await service.removeByAuthorOrAdmin({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      invokerUserId: fixture.sourceAuthorUserId,
      invokerHasManageGuild: false,
    });

    expect(result).toEqual({ kind: 'REMOVED' });
    expect(gateway.deleteCalls).toEqual([
      {
        archiveChannelId: fixture.archiveChannelId,
        ids: { provenanceMessageId: 'provenance-1', forwardMessageId: 'forward-1' },
      },
    ]);
    const tombstone = await readClip(fixture);
    expect(tombstone?.status).toBe('REMOVED_BY_AUTHOR');
    expect(tombstone?.removedAt).not.toBeNull();
    expect(tombstone?.archiveProvenanceMessageId).toBeNull();
    expect(tombstone?.archiveForwardMessageId).toBeNull();
    // §7.4: removal overrides every preservation signal.
    expect(await countClipperRows(fixture)).toBe(0);

    // §7.4 again: the tombstone blocks the harassment loop, for anyone.
    const recreate = await service.clip(clipInput(fixture, fakeSnowflake()));
    expect(recreate).toEqual({ kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' });
    expect(gateway.createCalls).toHaveLength(1);
    expect(await countClipperRows(fixture)).toBe(0);
    expect((await readClip(fixture))?.status).toBe('REMOVED_BY_AUTHOR');
  });

  test('admin removal leaves a REMOVED_BY_ADMIN tombstone with the same override', async () => {
    const fixture = await seedConfiguredGuild();
    await service.clip(clipInput(fixture, fakeSnowflake()));

    const result = await service.removeByAuthorOrAdmin({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      invokerUserId: fakeSnowflake(),
      invokerHasManageGuild: true,
    });

    expect(result).toEqual({ kind: 'REMOVED' });
    expect(gateway.deleteCalls).toHaveLength(1);
    const tombstone = await readClip(fixture);
    expect(tombstone?.status).toBe('REMOVED_BY_ADMIN');
    expect(await countClipperRows(fixture)).toBe(0);

    const recreate = await service.clip(clipInput(fixture, fakeSnowflake()));
    expect(recreate).toEqual({ kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' });
    expect(gateway.createCalls).toHaveLength(1);
  });

  test('a member who is neither the author nor a guild manager cannot remove', async () => {
    const fixture = await seedConfiguredGuild();
    await service.clip(clipInput(fixture, fakeSnowflake()));

    const result = await service.removeByAuthorOrAdmin({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      invokerUserId: fakeSnowflake(),
      invokerHasManageGuild: false,
    });

    expect(result).toEqual({ kind: 'NOT_AUTHORIZED' });
    expect(gateway.deleteCalls).toHaveLength(0);
    expect((await readClip(fixture))?.status).toBe('ACTIVE');
    expect(await countClipperRows(fixture)).toBe(1);
  });

  test('removing again retries a Discord delete the first removal could not complete', async () => {
    // Ids surviving on a tombstone are the pair the removal was meant to take
    // down -- nothing can write ids onto a terminal row, because `markActive`
    // is their only writer and it is gated on a transition the tombstones do
    // not have. A retry is therefore the author's only way to get two messages
    // that are still up out of the archive channel.
    const fixture = await seedConfiguredGuild();
    await service.clip(clipInput(fixture, fakeSnowflake()));
    gateway.failNextDelete(new Error('discord unavailable'));

    const removeInput = {
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      invokerUserId: fixture.sourceAuthorUserId,
      invokerHasManageGuild: false,
    };
    expect(await service.removeByAuthorOrAdmin(removeInput)).toEqual({ kind: 'REMOVED' });
    const stranded = await readClip(fixture);
    expect(stranded?.status).toBe('REMOVED_BY_AUTHOR');
    expect(stranded?.archiveProvenanceMessageId).toBe('provenance-1');
    expect(stranded?.archiveForwardMessageId).toBe('forward-1');

    expect(await service.removeByAuthorOrAdmin(removeInput)).toEqual({ kind: 'REMOVED' });

    const expectedDelete = {
      archiveChannelId: fixture.archiveChannelId,
      ids: { provenanceMessageId: 'provenance-1', forwardMessageId: 'forward-1' },
    };
    expect(gateway.deleteCalls).toEqual([expectedDelete, expectedDelete]);
    const tombstone = await readClip(fixture);
    expect(tombstone?.archiveProvenanceMessageId).toBeNull();
    expect(tombstone?.archiveForwardMessageId).toBeNull();
    // The retry deletes an archive; it never re-tombstones. A second
    // transition out of a terminal status would throw, and `removedAt` must
    // keep naming the removal that actually happened.
    expect(tombstone?.status).toBe('REMOVED_BY_AUTHOR');
    expect(tombstone?.removedAt).toEqual(stranded?.removedAt);
  });

  test('a failed archive creation stays FAILED and a retry reaches ACTIVE', async () => {
    const fixture = await seedConfiguredGuild();
    const clipperUserId = fakeSnowflake();
    gateway.failNextCreate(
      new ArchiveCreationFailedError('discord rate limited the post', {
        retryable: true,
        orphanedProvenanceMessageId: null,
      }),
    );

    const failed = await service.clip(clipInput(fixture, clipperUserId));

    expect(failed).toEqual({ kind: 'FAILED', retryable: true });
    const afterFailure = await readClip(fixture);
    // §17 case 7: no false ACTIVE, and the row stays recoverable.
    expect(afterFailure?.status).toBe('FAILED');
    expect(afterFailure?.archiveProvenanceMessageId).toBeNull();
    expect(afterFailure?.archiveForwardMessageId).toBeNull();

    const retry = await service.clip(clipInput(fixture, clipperUserId));

    expect(retry).toEqual({
      kind: 'CREATED',
      archive: { provenanceMessageId: 'provenance-1', forwardMessageId: 'forward-1' },
    });
    const afterRetry = await readClip(fixture);
    expect(afterRetry?.status).toBe('ACTIVE');
    expect(afterRetry?.archiveProvenanceMessageId).toBe('provenance-1');
    expect(gateway.createCalls).toHaveLength(2);
    expect(await countClipperRows(fixture)).toBe(1);
  });

  test('an unforwardable or invisible source message reports SOURCE_UNAVAILABLE', async () => {
    const fixture = await seedConfiguredGuild();
    gateway.failNextCreate(new ArchiveTargetUnavailableError('message 160014'));

    const result = await service.clip(clipInput(fixture, fakeSnowflake()));

    expect(result).toEqual({ kind: 'SOURCE_UNAVAILABLE' });
    expect((await readClip(fixture))?.status).toBe('FAILED');
    expect(gateway.deleteCalls).toHaveLength(0);
  });

  test('a posted provenance message whose forward failed is deleted, not left orphaned', async () => {
    // §17 case 19: never leave a provenance line pointing at a snapshot that
    // does not exist.
    const fixture = await seedConfiguredGuild();
    gateway.failNextCreate(
      new ArchiveCreationFailedError('forward rejected after provenance posted', {
        retryable: false,
        orphanedProvenanceMessageId: 'orphaned-provenance',
      }),
    );

    const result = await service.clip(clipInput(fixture, fakeSnowflake()));

    expect(result).toEqual({ kind: 'FAILED', retryable: false });
    expect(gateway.deleteCalls).toEqual([
      {
        archiveChannelId: fixture.archiveChannelId,
        ids: {
          provenanceMessageId: 'orphaned-provenance',
          forwardMessageId: 'orphaned-provenance',
        },
      },
    ]);
    const clip = await readClip(fixture);
    expect(clip?.status).toBe('FAILED');
    expect(clip?.archiveProvenanceMessageId).toBeNull();
    expect(clip?.archiveForwardMessageId).toBeNull();
  });

  test('a clip arriving during deletion converges to a new archive', async () => {
    // §9.3 / §9.8, driven deterministically: the hook runs inside the Discord
    // delete, which is exactly the window between "the archive is gone" and
    // "the finalizer retakes the lock".
    const fixture = await seedConfiguredGuild();
    const first = fakeSnowflake();
    const reviver = fakeSnowflake();
    await service.clip(clipInput(fixture, first));
    gateway.onNextDelete(async () => {
      const revival = await service.clip(clipInput(fixture, reviver));
      expect(revival.kind).toBe('CLIPPER_ADDED');
    });

    const result = await service.unclip({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      clipperUserId: first,
    });

    expect(result).toEqual({ kind: 'UNCLIPPED', remaining: 0 });
    const clip = await readClip(fixture);
    expect(clip?.status).toBe('ACTIVE');
    // A *different* pair: an ACTIVE row still carrying the deleted pair would
    // point at content Discord no longer has.
    expect(clip?.archiveProvenanceMessageId).toBe('provenance-2');
    expect(clip?.archiveForwardMessageId).toBe('forward-2');
    expect(gateway.createCalls).toHaveLength(2);
    expect(gateway.deleteCalls).toHaveLength(1);
    expect(await countClipperRows(fixture)).toBe(1);
  });

  test('author removal arriving during deletion leaves the tombstone standing', async () => {
    // The same window as the revival test, carrying the other thing that can
    // land in it. The finalizer decided to delete the row while the Clip was
    // DELETING with no clippers; by the time it retakes the lock that is no
    // longer what the row is, and §7.4's tombstone outranks the deletion it
    // was sent to finish. Deleting the row here would unblock recreation of a
    // message its author explicitly removed.
    const fixture = await seedConfiguredGuild();
    const first = fakeSnowflake();
    await service.clip(clipInput(fixture, first));
    gateway.onNextDelete(async () => {
      const removal = await service.removeByAuthorOrAdmin({
        guildId: fixture.guildId,
        sourceMessageId: fixture.sourceMessageId,
        invokerUserId: fixture.sourceAuthorUserId,
        invokerHasManageGuild: false,
      });
      expect(removal).toEqual({ kind: 'REMOVED' });
    });

    const result = await service.unclip({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      clipperUserId: first,
    });

    expect(result).toEqual({ kind: 'UNCLIPPED', remaining: 0 });
    const tombstone = await readClip(fixture);
    expect(tombstone?.status).toBe('REMOVED_BY_AUTHOR');
    expect(tombstone?.removedAt).not.toBeNull();
    expect(tombstone?.archiveProvenanceMessageId).toBeNull();
    expect(tombstone?.archiveForwardMessageId).toBeNull();
    expect(await countClipperRows(fixture)).toBe(0);
    // Nothing is recreated to replace an archive nobody may re-clip.
    expect(gateway.createCalls).toHaveLength(1);

    const recreate = await service.clip(clipInput(fixture, fakeSnowflake()));
    expect(recreate).toEqual({ kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' });
    expect((await readClip(fixture))?.status).toBe('REMOVED_BY_AUTHOR');
  });

  test('a failed Discord delete keeps the row and its ids rather than losing the archive', async () => {
    // The ids are the control plane's only handle on two messages that are
    // still up. Deleting the row here would strand published content in the
    // archive channel with nothing left to reconcile it against.
    const fixture = await seedConfiguredGuild();
    const first = fakeSnowflake();
    await service.clip(clipInput(fixture, first));
    gateway.failNextDelete(new Error('discord unavailable'));

    const result = await service.unclip({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      clipperUserId: first,
    });

    expect(result).toEqual({ kind: 'UNCLIPPED', remaining: 0 });
    const clip = await readClip(fixture);
    expect(clip).not.toBeNull();
    expect(clip?.status).toBe('DELETING');
    expect(clip?.archiveProvenanceMessageId).toBe('provenance-1');
    expect(clip?.archiveForwardMessageId).toBe('forward-1');
    expect(await countClipperRows(fixture)).toBe(0);
  });

  test('a publish that wins the deletion window is left alone, not cleared', async () => {
    // The end state of a concurrent `publishArchive`: the row is ACTIVE again
    // and its ids are that publish's, not the pair this finalizer took down.
    // Written directly under the delete hook rather than raced for -- the
    // interleaving that produces it is real but not deterministically
    // reachable, while the state it produces is exactly this.
    // Clearing here violates `clips_active_requires_archive` and rejects the
    // whole unclip; the ids are also not this finalizer's to clear.
    const fixture = await seedConfiguredGuild();
    const first = fakeSnowflake();
    await service.clip(clipInput(fixture, first));
    gateway.onNextDelete(async () => {
      await prisma.clip.update({
        where: {
          guildId_sourceMessageId: {
            guildId: fixture.guildId,
            sourceMessageId: fixture.sourceMessageId,
          },
        },
        data: {
          status: 'ACTIVE',
          archiveProvenanceMessageId: 'provenance-9',
          archiveForwardMessageId: 'forward-9',
        },
      });
    });

    const result = await service.unclip({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      clipperUserId: first,
    });

    expect(result).toEqual({ kind: 'UNCLIPPED', remaining: 0 });
    const clip = await readClip(fixture);
    expect(clip?.status).toBe('ACTIVE');
    expect(clip?.archiveProvenanceMessageId).toBe('provenance-9');
    expect(clip?.archiveForwardMessageId).toBe('forward-9');
  });

  test('a revival whose archive cannot be rebuilt keeps no ids for the pair it deleted', async () => {
    // The one surviving state that exposes the finalizer's id clear. Every
    // other outcome hides it: a tombstone clears the ids on its own path, a
    // successful revival overwrites them via `markActive`, and a completed
    // deletion takes the row with it. Here the Clip stays DELETING with a
    // clipper, so ids pointing at two messages Discord no longer has would be
    // the "already deleted vs. never attempted" ambiguity §9.3 forbids -- and
    // the state the eventual reconciliation has to read.
    const fixture = await seedConfiguredGuild();
    const first = fakeSnowflake();
    const reviver = fakeSnowflake();
    await service.clip(clipInput(fixture, first));
    gateway.onNextDelete(async () => {
      const revival = await service.clip(clipInput(fixture, reviver));
      expect(revival.kind).toBe('CLIPPER_ADDED');
      // Applies to the finalizer's rebuild, which is the next create: the
      // reviving clip does not create a second archive.
      gateway.failNextCreate(new ArchiveTargetUnavailableError('source gone'));
    });

    const result = await service.unclip({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      clipperUserId: first,
    });

    expect(result).toEqual({ kind: 'UNCLIPPED', remaining: 0 });
    const clip = await readClip(fixture);
    expect(clip?.status).toBe('DELETING');
    expect(clip?.archiveProvenanceMessageId).toBeNull();
    expect(clip?.archiveForwardMessageId).toBeNull();
    expect(await countClipperRows(fixture)).toBe(1);
    expect(gateway.createCalls).toHaveLength(2);
    expect(gateway.deleteCalls).toHaveLength(1);
  });

  test('a revival whose reviver withdraws during the rebuild publishes nothing', async () => {
    // The clipper count that justified the rebuild is read under one lock and
    // acted on after a Discord round-trip. The withdrawal below lands inside
    // that round-trip and takes the `ALREADY_DELETING` branch, which starts no
    // second finalizer -- it defers to this one. Publishing here would leave an
    // ACTIVE Clip nobody signalled for, and `removeClipper` reports `false` for
    // everyone, so no unclip could ever take that archive down again.
    const fixture = await seedConfiguredGuild();
    const first = fakeSnowflake();
    const reviver = fakeSnowflake();
    await service.clip(clipInput(fixture, first));

    gateway.onNextDelete(async () => {
      const revival = await service.clip(clipInput(fixture, reviver));
      expect(revival.kind).toBe('CLIPPER_ADDED');
    });
    gateway.onNextCreate(async () => {
      const withdrawal = await service.unclip({
        guildId: fixture.guildId,
        sourceMessageId: fixture.sourceMessageId,
        clipperUserId: reviver,
      });
      expect(withdrawal).toEqual({ kind: 'UNCLIPPED', remaining: 0 });
    });

    const result = await service.unclip({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      clipperUserId: first,
    });

    expect(result).toEqual({ kind: 'UNCLIPPED', remaining: 0 });
    expect(await readClip(fixture)).toBeNull();
    expect(await countClipperRows(fixture)).toBe(0);
    // Two pairs were posted and both came back down: the original, and the
    // rebuild that nobody was left to want.
    expect(gateway.createCalls).toHaveLength(2);
    expect(gateway.deleteCalls).toHaveLength(2);
  });

  test('deletion with nothing arriving in the window removes the Clip once', async () => {
    const fixture = await seedConfiguredGuild();
    const first = fakeSnowflake();
    await service.clip(clipInput(fixture, first));
    gateway.onNextDelete(async () => {});

    const result = await service.unclip({
      guildId: fixture.guildId,
      sourceMessageId: fixture.sourceMessageId,
      clipperUserId: first,
    });

    expect(result).toEqual({ kind: 'UNCLIPPED', remaining: 0 });
    expect(await readClip(fixture)).toBeNull();
    expect(await countClipperRows(fixture)).toBe(0);
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.deleteCalls).toHaveLength(1);
  });
});
