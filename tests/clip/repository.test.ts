import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { prisma as PrismaSingleton } from '@/lib/db';
import {
  addClipper,
  claimClip,
  clearArchiveMessageIds,
  countClippers,
  deleteClipWithClippers,
  deleteClippers,
  findGuildArchiveConfig,
  lockClip,
  markActive,
  markDeleting,
  markFailed,
  markRemovedByAdmin,
  markRemovedByAuthor,
  removeClipper,
} from '@/lib/clip/repository';

const CONCURRENT_CLAIMERS = 10;
const CONCURRENT_CLIPPERS = 8;

// Discord snowflakes are opaque strings to us; a random per-test id keeps
// concurrent/re-run test invocations from colliding on the same row.
function fakeSnowflake(): string {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

describe('clip repository', () => {
  let prisma: typeof PrismaSingleton;

  beforeAll(async () => {
    // lib/db.ts validates the full Env, not just DATABASE_URL, on first use of
    // the client, so every other required var needs a value before the first
    // query -- these are otherwise irrelevant to a repository test.
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

  function trackedGuildId(): string {
    const guildId = fakeSnowflake();
    cleanupGuildIds.push(guildId);
    return guildId;
  }

  afterEach(async () => {
    // Both foreign keys are RESTRICT by design, so children go first.
    await prisma.clipper.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.clip.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.guildAllowedRole.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.guildConfig.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    cleanupGuildIds.length = 0;
  });

  /**
   * Opens `callers` pool connections before a race.
   *
   * node-postgres connects lazily, so promises issued against a cold pool can
   * serialize on connection establishment: whoever wins the handshake finishes
   * its whole operation while the rest are still connecting, and the race never
   * happens. Wave 1 shipped a concurrency test that was green against its own
   * regression, and a cold pool is one candidate explanation.
   *
   * Removing this was measured against every race in this file and did not
   * change a single outcome -- see docs/journal/journal-2026-08.md, 2026-08-19.
   * It stays because it removes a confound cheaply, not because it was observed
   * to bite here. A race test that does not race reports nothing, and reports
   * it as a pass.
   */
  async function warmConnectionPool(callers: number): Promise<void> {
    await Promise.all(Array.from({ length: callers }, () => prisma.$queryRaw`SELECT 1`));
  }

  function newClipInput() {
    return {
      guildId: trackedGuildId(),
      sourceMessageId: fakeSnowflake(),
      sourceChannelId: fakeSnowflake(),
      authorUserId: fakeSnowflake(),
    };
  }

  function clipKey(clip: { guildId: string; sourceMessageId: string }) {
    return {
      guildId_sourceMessageId: {
        guildId: clip.guildId,
        sourceMessageId: clip.sourceMessageId,
      },
    };
  }

  function clipperInput(
    clip: { guildId: string; sourceMessageId: string },
    clipperUserId: string,
  ) {
    return { guildId: clip.guildId, sourceMessageId: clip.sourceMessageId, clipperUserId };
  }

  test('simultaneous first claims of one message produce exactly one canonical Clip', async () => {
    const input = newClipInput();

    await warmConnectionPool(CONCURRENT_CLAIMERS);

    const attempts = await Promise.allSettled(
      Array.from({ length: CONCURRENT_CLAIMERS }, () => claimClip(input)),
    );

    // A claim that throws is a defect in its own right: a check-then-insert
    // implementation loses the race with a unique-violation rather than a
    // `created: false`, and the caller has no clip to report on.
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(0);

    const results = attempts.map((attempt) =>
      attempt.status === 'fulfilled' ? attempt.value : null,
    );
    expect(results.filter((result) => result?.created === true)).toHaveLength(1);
    expect(results.filter((result) => result?.created === false)).toHaveLength(
      CONCURRENT_CLAIMERS - 1,
    );

    // Every caller must be able to act on the same canonical row, winner or not.
    for (const result of results) {
      expect(result?.clip).toMatchObject({
        guildId: input.guildId,
        sourceMessageId: input.sourceMessageId,
        sourceChannelId: input.sourceChannelId,
        authorUserId: input.authorUserId,
        status: 'PENDING',
        archiveProvenanceMessageId: null,
        archiveForwardMessageId: null,
      });
    }

    expect(await prisma.clip.count({ where: { guildId: input.guildId } })).toBe(1);
  });

  test('the same user clipping simultaneously produces exactly one Clipper', async () => {
    const input = newClipInput();
    const clipperUserId = fakeSnowflake();
    await claimClip(input);

    await warmConnectionPool(CONCURRENT_CLIPPERS);

    // Every caller enters through `lockClip`, which holds `FOR UPDATE` on the
    // one row to commit, so they serialize: this pins the end-to-end property a
    // double-click must have, but it cannot tell `addClipper`'s conditional
    // insert apart from a check-then-insert. The unlocked race below is what
    // covers that.
    const attempts = await Promise.allSettled(
      Array.from({ length: CONCURRENT_CLIPPERS }, () =>
        lockClip(input.guildId, input.sourceMessageId, (tx) =>
          addClipper(tx, {
            guildId: input.guildId,
            sourceMessageId: input.sourceMessageId,
            clipperUserId,
          }),
        ),
      ),
    );

    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(0);

    const added = attempts.filter(
      (attempt) => attempt.status === 'fulfilled' && attempt.value?.added === true,
    );
    expect(added).toHaveLength(1);
    expect(await prisma.clipper.count({ where: { guildId: input.guildId } })).toBe(1);
  });

  test('addClipper de-duplicates in the database, not in its caller', async () => {
    const input = newClipInput();
    const clipperUserId = fakeSnowflake();
    await claimClip(input);

    await warmConnectionPool(CONCURRENT_CLIPPERS);

    // Deliberately not through `lockClip`: these transactions take no clip lock,
    // so they genuinely overlap and `addClipper`'s own `ON CONFLICT DO NOTHING`
    // is the only thing deciding the winner. A check-then-insert loses this race
    // with a unique violation instead of a quiet `added: false`.
    const attempts = await Promise.allSettled(
      Array.from({ length: CONCURRENT_CLIPPERS }, () =>
        prisma.$transaction((tx) => addClipper(tx, clipperInput(input, clipperUserId))),
      ),
    );

    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(0);
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled' && attempt.value.added),
    ).toHaveLength(1);
    expect(await prisma.clipper.count({ where: { guildId: input.guildId } })).toBe(1);
  });

  test('two simultaneous Unclips report the remaining count exactly once each', async () => {
    const input = newClipInput();
    const firstClipperUserId = fakeSnowflake();
    const secondClipperUserId = fakeSnowflake();
    await claimClip(input);
    await lockClip(input.guildId, input.sourceMessageId, async (tx) => {
      await addClipper(tx, clipperInput(input, firstClipperUserId));
      await addClipper(tx, clipperInput(input, secondClipperUserId));
    });

    await warmConnectionPool(2);

    const attempts = await Promise.allSettled(
      [firstClipperUserId, secondClipperUserId].map((clipperUserId) =>
        lockClip(input.guildId, input.sourceMessageId, (tx) =>
          removeClipper(tx, {
            guildId: input.guildId,
            sourceMessageId: input.sourceMessageId,
            clipperUserId,
          }),
        ),
      ),
    );

    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(0);

    const outcomes = attempts.map((attempt) =>
      attempt.status === 'fulfilled' ? attempt.value : null,
    );
    expect(outcomes.every((outcome) => outcome?.removed === true)).toBe(true);

    // The multiset, not its minimum: both callers observing 0 is the defect
    // this test exists to catch, and "at least one saw 0" would not see it.
    const remaining = outcomes
      .map((outcome) => outcome?.remaining)
      .sort((left, right) => Number(left) - Number(right));
    expect(remaining).toEqual([0, 1]);

    expect(await prisma.clipper.count({ where: { guildId: input.guildId } })).toBe(0);
  });

  test('an author tombstone blocks a later claim instead of reviving the Clip', async () => {
    const input = newClipInput();
    const removedAt = new Date();
    await claimClip(input);
    await lockClip(input.guildId, input.sourceMessageId, (tx) =>
      markRemovedByAuthor(tx, input.guildId, input.sourceMessageId, removedAt),
    );

    const reclaim = await claimClip(input);

    expect(reclaim.created).toBe(false);
    expect(reclaim.clip.status).toBe('REMOVED_BY_AUTHOR');
    expect(await prisma.clip.count({ where: { guildId: input.guildId } })).toBe(1);

    // The tombstone must survive the claim untouched, or §16 retention has
    // nothing to retain.
    const row = await prisma.clip.findUniqueOrThrow({
      where: clipKey(input),
    });
    expect(row.removedAt?.getTime()).toBe(removedAt.getTime());
  });

  test('an admin tombstone drops every preservation signal but keeps the Clip row', async () => {
    const input = newClipInput();
    const removedAt = new Date();
    await claimClip(input);
    await lockClip(input.guildId, input.sourceMessageId, async (tx) => {
      await addClipper(tx, clipperInput(input, fakeSnowflake()));
      await addClipper(tx, clipperInput(input, fakeSnowflake()));
      await deleteClippers(tx, input.guildId, input.sourceMessageId);
      await markRemovedByAdmin(tx, input.guildId, input.sourceMessageId, removedAt);
    });

    expect(await prisma.clipper.count({ where: { guildId: input.guildId } })).toBe(0);

    const reclaim = await claimClip(input);
    expect(reclaim.created).toBe(false);
    expect(reclaim.clip.status).toBe('REMOVED_BY_ADMIN');
  });

  test('a removal during the archive round-trip stops the activation that follows', async () => {
    const input = newClipInput();
    const archive = {
      provenanceMessageId: fakeSnowflake(),
      forwardMessageId: fakeSnowflake(),
    };
    const removedAt = new Date();

    // 1. A clipper claims the Clip.
    await claimClip(input);
    // 2. Discord builds the archive. Seconds wide, and held under no lock --
    //    which is the entire reason the rest of this sequence is reachable.
    // 3. The author removes the Clip before that round-trip returns.
    await lockClip(input.guildId, input.sourceMessageId, (tx) =>
      markRemovedByAuthor(tx, input.guildId, input.sourceMessageId, removedAt),
    );
    // 4. The clipper's call finally takes the lock and tries to publish.
    const outcome = await lockClip(input.guildId, input.sourceMessageId, (tx) =>
      markActive(tx, input.guildId, input.sourceMessageId, archive),
    );

    expect(outcome).toEqual({ applied: false });

    // The tombstone survives intact, and the archive it would have published is
    // still unrecorded -- so the caller can tell it must delete it on Discord.
    const row = await prisma.clip.findUniqueOrThrow({ where: clipKey(input) });
    expect(row).toMatchObject({
      status: 'REMOVED_BY_AUTHOR',
      archiveProvenanceMessageId: null,
      archiveForwardMessageId: null,
    });
    expect(row.removedAt?.getTime()).toBe(removedAt.getTime());
  });

  test('a tombstone refuses every later workflow transition', async () => {
    const input = newClipInput();
    await claimClip(input);
    await lockClip(input.guildId, input.sourceMessageId, (tx) =>
      markRemovedByAdmin(tx, input.guildId, input.sourceMessageId, new Date()),
    );

    // No CHECK stands behind these two: overwriting a tombstone's status with a
    // non-terminal one leaves a row that is still valid, merely no longer a
    // tombstone. The predicate in the UPDATE is the only guard there is.
    expect(
      await lockClip(input.guildId, input.sourceMessageId, (tx) =>
        markDeleting(tx, input.guildId, input.sourceMessageId),
      ),
    ).toEqual({ applied: false });
    expect(
      await lockClip(input.guildId, input.sourceMessageId, (tx) =>
        markFailed(tx, input.guildId, input.sourceMessageId),
      ),
    ).toEqual({ applied: false });

    expect((await prisma.clip.findUniqueOrThrow({ where: clipKey(input) })).status).toBe(
      'REMOVED_BY_ADMIN',
    );
  });

  test('the database rejects an ACTIVE Clip carrying a removal timestamp', async () => {
    const input = newClipInput();
    await claimClip(input);
    await prisma.clip.update({
      where: clipKey(input),
      data: { status: 'REMOVED_BY_AUTHOR', removedAt: new Date() },
    });

    // Written through the client rather than the repository, so the guard being
    // tested is the database's and not `markActive`'s predicate. Both archive
    // ids are supplied, so `clips_active_requires_archive` is satisfied and
    // `clips_active_not_removed` is the only constraint left to reject it.
    await expect(
      prisma.clip.update({
        where: clipKey(input),
        data: {
          status: 'ACTIVE',
          archiveProvenanceMessageId: fakeSnowflake(),
          archiveForwardMessageId: fakeSnowflake(),
        },
      }),
    ).rejects.toThrow(/clips_active_not_removed/);

    expect((await prisma.clip.findUniqueOrThrow({ where: clipKey(input) })).status).toBe(
      'REMOVED_BY_AUTHOR',
    );
  });

  test('the database rejects an ACTIVE Clip with missing archive ids', async () => {
    const input = newClipInput();
    await claimClip(input);

    // Written through the client rather than the repository: the point of the
    // CHECK is that it holds against code that has not been written yet.
    await expect(
      prisma.clip.update({
        where: clipKey(input),
        data: { status: 'ACTIVE' },
      }),
    ).rejects.toThrow(/clips_active_requires_archive/);

    expect(
      (await prisma.clip.findUniqueOrThrow({
        where: clipKey(input),
      })).status,
    ).toBe('PENDING');
  });

  test('archive ids may be cleared only once the Clip has left ACTIVE', async () => {
    const input = newClipInput();
    const archive = {
      provenanceMessageId: fakeSnowflake(),
      forwardMessageId: fakeSnowflake(),
    };
    await claimClip(input);

    await expect(
      lockClip(input.guildId, input.sourceMessageId, async (tx) => {
        await markActive(tx, input.guildId, input.sourceMessageId, archive);
        await clearArchiveMessageIds(tx, input.guildId, input.sourceMessageId);
      }),
    ).rejects.toThrow(/clips_active_requires_archive/);

    // The rejected transaction rolled back, so the Clip never became ACTIVE.
    await lockClip(input.guildId, input.sourceMessageId, async (tx, clip) => {
      expect(clip.status).toBe('PENDING');
      await markActive(tx, input.guildId, input.sourceMessageId, archive);
      await markDeleting(tx, input.guildId, input.sourceMessageId);
      await clearArchiveMessageIds(tx, input.guildId, input.sourceMessageId);
    });

    expect(
      await prisma.clip.findUniqueOrThrow({
        where: clipKey(input),
      }),
    ).toMatchObject({
      status: 'DELETING',
      archiveProvenanceMessageId: null,
      archiveForwardMessageId: null,
    });
  });

  test('deleting a Clip with its clippers leaves no tombstone', async () => {
    const input = newClipInput();
    await claimClip(input);
    await lockClip(input.guildId, input.sourceMessageId, async (tx) => {
      await addClipper(tx, clipperInput(input, fakeSnowflake()));
      await addClipper(tx, clipperInput(input, fakeSnowflake()));
      await deleteClipWithClippers(tx, input.guildId, input.sourceMessageId);
    });

    expect(await prisma.clip.count({ where: { guildId: input.guildId } })).toBe(0);
    expect(await prisma.clipper.count({ where: { guildId: input.guildId } })).toBe(0);

    const reclaim = await claimClip(input);
    expect(reclaim.created).toBe(true);
    expect(reclaim.clip.status).toBe('PENDING');
  });

  test('lockClip resolves to null without running its callback for an unknown Clip', async () => {
    const guildId = trackedGuildId();
    let ran = false;

    const result = await lockClip(guildId, fakeSnowflake(), async () => {
      ran = true;
      return 'unreachable';
    });

    expect(result).toBeNull();
    expect(ran).toBe(false);
  });

  test('removeClipper reports removed: false for a user who never clipped', async () => {
    const input = newClipInput();
    const clipperUserId = fakeSnowflake();
    await claimClip(input);
    await lockClip(input.guildId, input.sourceMessageId, (tx) =>
      addClipper(tx, clipperInput(input, clipperUserId)),
    );

    const outcome = await lockClip(input.guildId, input.sourceMessageId, (tx) =>
      removeClipper(tx, clipperInput(input, fakeSnowflake())),
    );

    expect(outcome).toEqual({ removed: false, remaining: 1 });
    expect(
      await lockClip(input.guildId, input.sourceMessageId, (tx) =>
        countClippers(tx, input.guildId, input.sourceMessageId),
      ),
    ).toBe(1);
  });

  test('a FAILED Clip keeps its row so the caller can see why', async () => {
    const input = newClipInput();
    await claimClip(input);

    await lockClip(input.guildId, input.sourceMessageId, (tx) =>
      markFailed(tx, input.guildId, input.sourceMessageId),
    );

    const reclaim = await claimClip(input);
    expect(reclaim.created).toBe(false);
    expect(reclaim.clip.status).toBe('FAILED');
  });

  test('findGuildArchiveConfig returns the archive channel and every allowed role', async () => {
    const guildId = trackedGuildId();
    const archiveChannelId = fakeSnowflake();
    const allowedRoleIds = [fakeSnowflake(), fakeSnowflake()];
    await prisma.guildConfig.create({
      data: {
        guildId,
        archiveChannelId,
        configuredByUserId: fakeSnowflake(),
        allowedRoles: { create: allowedRoleIds.map((roleId) => ({ roleId })) },
      },
    });

    const config = await findGuildArchiveConfig(guildId);

    expect(config?.archiveChannelId).toBe(archiveChannelId);
    expect(config?.allowedRoleIds.slice().sort()).toEqual(allowedRoleIds.slice().sort());
  });

  test('findGuildArchiveConfig returns null for a guild that never completed setup', async () => {
    expect(await findGuildArchiveConfig(fakeSnowflake())).toBeNull();
  });
});
