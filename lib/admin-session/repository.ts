import { prisma } from '@/lib/db';

/** The `(guild, admin)` pair a setup token or admin session is bound to. */
export type AdminIdentity = {
  guildId: string;
  userId: string;
};

export type StoredCredential = AdminIdentity & {
  tokenHash: string;
  expiresAt: Date;
};

export async function insertSetupToken(credential: StoredCredential): Promise<void> {
  await prisma.setupToken.create({ data: credential });
}

/**
 * Marks a setup token used and returns who it belonged to, or null if it was
 * unknown, already used, or expired.
 *
 * The `usedAt: null` predicate lives in the UPDATE, never in a preceding read:
 * concurrent callers serialize on the row lock, and each loser re-evaluates
 * the predicate against the winner's committed row, so exactly one update
 * reports a count of 1. A read-then-write would let every caller observe the
 * same unused row and mint a session apiece.
 */
export async function consumeSetupToken(
  tokenHash: string,
  now: Date,
): Promise<AdminIdentity | null> {
  const { count } = await prisma.setupToken.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (count !== 1) {
    return null;
  }

  // Safe to read after the fact: the conditional update already decided the
  // winner, and nothing ever rewrites a consumed token's guild or user.
  return prisma.setupToken.findUniqueOrThrow({
    where: { tokenHash },
    select: { guildId: true, userId: true },
  });
}

export async function insertAdminSession(credential: StoredCredential): Promise<void> {
  await prisma.adminSession.create({ data: credential });
}

export async function findLiveAdminSession(
  tokenHash: string,
  now: Date,
): Promise<AdminIdentity | null> {
  return prisma.adminSession.findFirst({
    where: { tokenHash, revokedAt: null, expiresAt: { gt: now } },
    select: { guildId: true, userId: true },
  });
}
