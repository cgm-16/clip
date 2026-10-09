import type { TxClient } from '@/lib/clip/repository';
import { getPrismaClient } from '@/lib/db';

/**
 * Takes this guild's transaction-scoped advisory lock on `tx`. Postgres
 * releases it at commit or rollback; there is no unlock call.
 *
 * Every guild control-plane writer takes this lock first, before any row
 * lock: setup-token issuance and exchange, configuration finalization,
 * guild-data deletion, and every Clip row-lock transaction. That single
 * order is what keeps the combination deadlock-free, and it covers what a
 * row lock cannot: first setup has no `guild_configs` row to lock, and a
 * deletion removes the rows a row lock would wait on.
 *
 * The key is `hashtextextended` of a namespaced guild id, so the lock space
 * is shared with nothing else and works for any id string. Two guilds
 * colliding on one 64-bit hash would only serialize them -- never let two
 * writers to one guild run together.
 *
 * `$executeRaw`, not `$queryRaw`: the function returns `void`, which the
 * driver adapter has no column type to deserialize into.
 *
 * ponytail: this serializes every Clip write in a guild, not just writes to
 * one message -- fine at a guild's interaction rate. If it ever measures
 * slow, keep the guild lock for lifecycle writers and have Clip writers take
 * it in shared mode (`pg_advisory_xact_lock_shared`).
 *
 * Time spent waiting for this lock counts against Prisma's interactive
 * transaction timeout (5s by default). A writer queued behind a large
 * guild's deletion can therefore fail with a transaction timeout rather
 * than wait.
 */
export async function lockGuild(tx: TxClient, guildId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`clip.guild:${guildId}`}, 0))`;
}

/** Runs `fn` in a new transaction holding the guild lock. No Discord I/O inside. */
export function withGuildLock<T>(guildId: string, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return getPrismaClient().$transaction(async (tx) => {
    await lockGuild(tx, guildId);
    return fn(tx);
  });
}
