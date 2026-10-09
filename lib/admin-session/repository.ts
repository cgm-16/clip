import type { TxClient } from '@/lib/clip/repository';
import { getPrismaClient } from '@/lib/db';
import { lockGuild, withGuildLock } from '@/lib/guild-lock';

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

/**
 * Under the guild lock, so a token is either issued before a deletion (and
 * deleted by it) or after it (and valid for the new setup), never in between.
 */
export async function insertSetupToken(credential: StoredCredential): Promise<void> {
  await withGuildLock(credential.guildId, async (tx) => {
    await tx.setupToken.create({ data: credential });
  });
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
 *
 * The guild lock orders the exchange against deletion: a token deleted first
 * matches nothing.
 */
export async function exchangeSetupTokenForSession(
  setupTokenHash: string,
  session: BearerCredential,
  now: Date,
): Promise<AdminIdentity | null> {
  // The token hash is all the exchange has, so its guild is read first,
  // unlocked, to know which lock to take. The conditional update below still
  // decides the outcome: a deletion that removed the token meanwhile leaves it
  // matching nothing.
  const pending = await getPrismaClient().setupToken.findUnique({
    where: { tokenHash: setupTokenHash },
    select: { guildId: true },
  });
  if (pending === null) {
    return null;
  }

  return getPrismaClient().$transaction(async (tx) => {
    await lockGuild(tx, pending.guildId);
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

/**
 * The token's guild if a used setup token is being re-opened by the admin it
 * was spent for, else null: the token is used but still inside its own
 * lifetime, and the session is live for exactly the token's guild and user
 * (#72). Read-only: re-opening confirms a session the browser already holds
 * and never mints one, so it grants nothing the caller does not already have.
 */
export async function findReopenableSetupTokenGuildByHash(
  setupTokenHash: string,
  sessionTokenHash: string,
  now: Date,
): Promise<string | null> {
  const used = await getPrismaClient().setupToken.findFirst({
    where: { tokenHash: setupTokenHash, usedAt: { not: null }, expiresAt: { gt: now } },
    select: { guildId: true, userId: true },
  });
  if (used === null) {
    return null;
  }
  const session = await getPrismaClient().adminSession.findFirst({
    where: { tokenHash: sessionTokenHash, ...used, revokedAt: null, expiresAt: { gt: now } },
    select: { tokenHash: true },
  });
  return session === null ? null : used.guildId;
}

export async function findLiveAdminSession(
  tokenHash: string,
  now: Date,
): Promise<AdminIdentity | null> {
  return getPrismaClient().adminSession.findFirst({
    where: { tokenHash, revokedAt: null, expiresAt: { gt: now } },
    select: { guildId: true, userId: true },
  });
}

/**
 * True if the session is still live *for this guild*, read on the caller's
 * locked transaction. Admin writers recheck the session here, under the guild
 * lock, because a deletion can revoke it between the request's authentication
 * and its commit.
 */
export async function isAdminSessionLive(
  tx: TxClient,
  tokenHash: string,
  guildId: string,
  now: Date,
): Promise<boolean> {
  const session = await tx.adminSession.findFirst({
    where: { tokenHash, guildId, revokedAt: null, expiresAt: { gt: now } },
    select: { tokenHash: true },
  });
  return session !== null;
}
