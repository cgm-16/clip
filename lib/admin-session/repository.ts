import { prisma } from '@/lib/db';

/** The `(guild, admin)` pair a setup token or admin session is bound to. */
export type AdminIdentity = {
  guildId: string;
  userId: string;
};

/** The stored form of a bearer value: its hash and the instant it lapses. */
export type BearerCredential = {
  tokenHash: string;
  expiresAt: Date;
};

export type StoredCredential = AdminIdentity & BearerCredential;

export async function insertSetupToken(credential: StoredCredential): Promise<void> {
  await prisma.setupToken.create({ data: credential });
}

/**
 * Exchanges a setup token for an admin session, or returns null if the token
 * was unknown, already used, or expired.
 *
 * The `usedAt: null` predicate lives in the UPDATE, never in a preceding read:
 * concurrent callers serialize on the row lock, and each loser re-evaluates
 * the predicate against the winner's committed row, so exactly one update
 * reports a count of 1. A read-then-write would let every caller observe the
 * same unused row and mint a session apiece.
 *
 * Both writes share one transaction so the token is spent only if the session
 * it pays for exists. Consuming it in its own statement would burn the token
 * whenever the insert failed, stranding the admin on a dead link they cannot
 * retry. The transaction also holds the row lock through to commit rather than
 * releasing it at the end of the UPDATE, so the one-winner property above
 * survives unchanged.
 *
 * The session's guild and user come from the consumed token rather than from
 * the caller: a session can only ever be scoped to the pair its token was
 * issued for.
 */
export async function exchangeSetupTokenForSession(
  setupTokenHash: string,
  session: BearerCredential,
  now: Date,
): Promise<AdminIdentity | null> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.setupToken.updateMany({
      where: { tokenHash: setupTokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count !== 1) {
      return null;
    }

    // Safe to read after the fact: the conditional update already decided the
    // winner, and nothing ever rewrites a consumed token's guild or user.
    const identity = await tx.setupToken.findUniqueOrThrow({
      where: { tokenHash: setupTokenHash },
      select: { guildId: true, userId: true },
    });

    await tx.adminSession.create({ data: { ...session, ...identity } });

    return identity;
  });
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
