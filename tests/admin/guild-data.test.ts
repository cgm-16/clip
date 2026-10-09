import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { deleteGuildData } from '@/lib/admin/guild-data';
import { exchangeSetupToken, issueSetupToken } from '@/lib/admin-session/service';
import { finalizeGuildArchiveConfig, lockClip } from '@/lib/clip/repository';

// Discord snowflakes are opaque strings to us; a random per-test id keeps
// concurrent/re-run test invocations from colliding on the same row.
function fakeSnowflake(): string {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

describe('deleteGuildData', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    // lib/db.ts validates the full Env on first use of the client.
    // DATABASE_URL is deliberately left untouched: it must come from the real
    // Postgres the test runs against, supplied by the invoking command.
    vi.stubEnv('DISCORD_APPLICATION_ID', '1539212298600718416');
    vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
    vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-value');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');

    prisma = (await import('@/lib/db')).getPrismaClient();
  });

  const cleanupGuildIds: string[] = [];

  function trackedGuildId(): string {
    const guildId = fakeSnowflake();
    cleanupGuildIds.push(guildId);
    return guildId;
  }

  afterEach(async () => {
    // Both foreign keys are RESTRICT by design, so children go first.
    const where = { guildId: { in: cleanupGuildIds } };
    await prisma.clipper.deleteMany({ where });
    await prisma.clip.deleteMany({ where });
    await prisma.guildAllowedRole.deleteMany({ where });
    await prisma.guildConfig.deleteMany({ where });
    await prisma.setupToken.deleteMany({ where });
    await prisma.adminSession.deleteMany({ where });
    cleanupGuildIds.length = 0;
  });

  // Opens pool connections before a race; see tests/clip/repository.test.ts.
  async function warmConnectionPool(callers: number): Promise<void> {
    await Promise.all(Array.from({ length: callers }, () => prisma.$queryRaw`SELECT 1`));
  }

  async function seedGuild(guildId: string) {
    const sessionTokenHash = fakeSnowflake();
    await prisma.guildConfig.create({
      data: { guildId, archiveChannelId: fakeSnowflake(), configuredByUserId: fakeSnowflake() },
    });
    await prisma.guildAllowedRole.create({ data: { guildId, roleId: fakeSnowflake() } });
    const sourceMessageId = fakeSnowflake();
    await prisma.clip.create({
      data: {
        guildId,
        sourceMessageId,
        sourceChannelId: fakeSnowflake(),
        authorUserId: fakeSnowflake(),
        status: 'ACTIVE',
        archiveProvenanceMessageId: fakeSnowflake(),
        archiveForwardMessageId: fakeSnowflake(),
      },
    });
    await prisma.clip.create({
      data: {
        guildId,
        sourceMessageId: fakeSnowflake(),
        sourceChannelId: fakeSnowflake(),
        authorUserId: fakeSnowflake(),
        status: 'REMOVED_BY_AUTHOR',
        removedAt: new Date(),
      },
    });
    await prisma.clipper.create({ data: { guildId, sourceMessageId, clipperUserId: fakeSnowflake() } });
    await prisma.setupToken.create({
      data: { tokenHash: fakeSnowflake(), guildId, userId: fakeSnowflake(), expiresAt: new Date(Date.now() + 60_000) },
    });
    await prisma.adminSession.create({
      data: { tokenHash: sessionTokenHash, guildId, userId: fakeSnowflake(), expiresAt: new Date(Date.now() + 60_000) },
    });
    return { sessionTokenHash };
  }

  async function countsFor(guildId: string) {
    return {
      configs: await prisma.guildConfig.count({ where: { guildId } }),
      roles: await prisma.guildAllowedRole.count({ where: { guildId } }),
      clips: await prisma.clip.count({ where: { guildId } }),
      clippers: await prisma.clipper.count({ where: { guildId } }),
      tokens: await prisma.setupToken.count({ where: { guildId } }),
      sessions: await prisma.adminSession.count({ where: { guildId } }),
    };
  }

  const NONE = { configs: 0, roles: 0, clips: 0, clippers: 0, tokens: 0, sessions: 0 };

  test('deletes every control-plane row for the guild, tombstones included, and nothing else', async () => {
    const target = trackedGuildId();
    const other = trackedGuildId();
    const { sessionTokenHash } = await seedGuild(target);
    await seedGuild(other);
    const otherBefore = await countsFor(other);

    expect(await deleteGuildData(target, sessionTokenHash)).toEqual({ kind: 'DELETED' });
    expect(await countsFor(target)).toEqual(NONE);
    expect(await countsFor(other)).toEqual(otherBefore);
  });

  test('a revoked session deletes nothing', async () => {
    const guildId = trackedGuildId();
    await seedGuild(guildId);
    const before = await countsFor(guildId);
    expect(await deleteGuildData(guildId, 'not-a-live-session')).toEqual({ kind: 'SESSION_REVOKED' });
    expect(await countsFor(guildId)).toEqual(before);
  });

  test('a save authenticated before the deletion cannot recreate the configuration after it', async () => {
    const guildId = trackedGuildId();
    const { sessionTokenHash } = await seedGuild(guildId);
    await deleteGuildData(guildId, sessionTokenHash);
    const late = await finalizeGuildArchiveConfig({
      guildId,
      archiveChannelId: fakeSnowflake(),
      configuredByUserId: fakeSnowflake(),
      allowedRoleIds: [],
      sessionTokenHash,
    });
    expect(late).toEqual({ kind: 'SESSION_REVOKED' });
    expect(await prisma.guildConfig.count({ where: { guildId } })).toBe(0);
  });

  test('a setup token issued before the deletion cannot be exchanged after it', async () => {
    const guildId = trackedGuildId();
    const issued = await issueSetupToken(guildId, fakeSnowflake());
    const { sessionTokenHash } = await seedGuild(guildId);
    await deleteGuildData(guildId, sessionTokenHash);
    expect(await exchangeSetupToken(issued.token)).toBeNull();
    expect(await prisma.adminSession.count({ where: { guildId } })).toBe(0);
  });

  test('deletion waits for an in-flight Clip row transaction', async () => {
    const guildId = trackedGuildId();
    const { sessionTokenHash } = await seedGuild(guildId);
    const clip = await prisma.clip.findFirstOrThrow({ where: { guildId, status: 'ACTIVE' } });
    await warmConnectionPool(2);
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const clipTx = lockClip(guildId, clip.sourceMessageId, async () => {
      holding.resolve();
      await release.promise;
      return 'done';
    });
    await holding.promise;
    const deletion = deleteGuildData(guildId, sessionTokenHash);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await prisma.guildConfig.count({ where: { guildId } })).toBe(1);
    release.resolve();
    expect(await clipTx).toBe('done');
    expect(await deletion).toEqual({ kind: 'DELETED' });
  });
});
