import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  claimClip,
  finalizeGuildArchiveConfig,
  findArchiveChangeBlocker,
} from '@/lib/clip/repository';
import { createClipService } from '@/lib/clip/service';
import type { PrismaClient } from '@/generated/prisma/client';
import { createFakeGateway, type FakeDiscordArchiveGateway } from './fake-gateway';

// The seam between the claim transaction and the joined `lockClip` is not
// reachable through the gateway, so the repository's `lockClip` is wrapped:
// a one-shot hook runs before it delegates to the real one.
const seam = vi.hoisted(() => ({ beforeNextLockClip: null as (() => Promise<void>) | null }));
vi.mock('@/lib/clip/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/clip/repository')>();
  return {
    ...actual,
    lockClip: (async (...args: Parameters<typeof actual.lockClip>) => {
      const hook = seam.beforeNextLockClip;
      seam.beforeNextLockClip = null;
      await hook?.();
      return actual.lockClip(...args);
    }) as typeof actual.lockClip,
  };
});

function fakeSnowflake(): string {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

describe('stale PENDING takeover', () => {
  let prisma: PrismaClient;
  let gateway: FakeDiscordArchiveGateway;
  let service: ReturnType<typeof createClipService>;
  const cleanupGuildIds: string[] = [];

  beforeAll(async () => {
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
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    seam.beforeNextLockClip = null;
    await prisma.clipper.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.clip.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.guildAllowedRole.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.guildConfig.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.adminSession.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    cleanupGuildIds.length = 0;
  });

  // A repoint is allowed while a PENDING Clip is past its lease. If it commits
  // between a re-clip's claim and its takeover, the takeover must not refresh
  // the lease or post into the abandoned channel: either would leave the row
  // PENDING with a fresh lease, refusing retries and further repoints for the
  // lease's length.
  test('a repoint between the claim and the takeover stops the takeover before anything posts', async () => {
    const guildId = fakeSnowflake();
    const oldChannelId = fakeSnowflake();
    const newChannelId = fakeSnowflake();
    const allowedRoleId = fakeSnowflake();
    const sourceChannelId = fakeSnowflake();
    const sourceMessageId = fakeSnowflake();
    const sourceAuthorUserId = fakeSnowflake();
    cleanupGuildIds.push(guildId);
    await prisma.guildConfig.create({
      data: {
        guildId,
        archiveChannelId: oldChannelId,
        configuredByUserId: fakeSnowflake(),
        allowedRoles: { create: [{ roleId: allowedRoleId }] },
      },
    });
    await claimClip({ guildId, sourceMessageId, sourceChannelId, authorUserId: sourceAuthorUserId });
    const key = { guildId_sourceMessageId: { guildId, sourceMessageId } };
    const lapsed = new Date(Date.now() - 6 * 60_000);
    await prisma.clip.update({ where: key, data: { updatedAt: lapsed } });

    const repointInput = async () => ({
      guildId,
      sessionTokenHash: await liveSession(),
      archiveChannelId: newChannelId,
      configuredByUserId: fakeSnowflake(),
      allowedRoleIds: [allowedRoleId],
    });
    async function liveSession(): Promise<string> {
      const tokenHash = fakeSnowflake();
      await prisma.adminSession.create({
        data: { tokenHash, guildId, userId: fakeSnowflake(), expiresAt: new Date(Date.now() + 60_000) },
      });
      return tokenHash;
    }
    const clipInput = {
      guildId,
      sourceChannelId,
      sourceMessageId,
      sourceAuthorUserId,
      clipperUserId: fakeSnowflake(),
      clipperRoleIds: [allowedRoleId],
      clipperHasManageGuild: false,
    };

    let repoint: Awaited<ReturnType<typeof finalizeGuildArchiveConfig>> | undefined;
    seam.beforeNextLockClip = async () => {
      repoint = await finalizeGuildArchiveConfig(await repointInput());
    };
    const raced = await service.clip(clipInput);

    expect(seam.beforeNextLockClip).toBeNull();
    expect(repoint).toEqual({ kind: 'SAVED' });
    expect(raced).toEqual({ kind: 'FAILED', retryable: true });
    expect(gateway.createCalls).toEqual([]);
    expect(gateway.deleteCalls).toEqual([]);
    expect((await prisma.clip.findUnique({ where: key }))?.updatedAt).toEqual(lapsed);
    expect(await findArchiveChangeBlocker(guildId)).toBeNull();

    const retried = await service.clip(clipInput);
    expect(retried.kind).toBe('CREATED');
    expect(gateway.createCalls.map((call) => call.archiveChannelId)).toEqual([newChannelId]);
    expect((await prisma.clip.findUnique({ where: key }))?.status).toBe('ACTIVE');
  });
});
