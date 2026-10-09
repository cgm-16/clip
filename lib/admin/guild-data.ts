import { isAdminSessionLive } from '@/lib/admin-session/repository';
import { withGuildLock } from '@/lib/guild-lock';

/**
 * Deletes everything Clip stores for one guild, in one transaction, under
 * the guild lock: configuration, allowed roles, Clips (tombstones and
 * notification state included), clippers, setup tokens and admin sessions.
 * A failure rolls all of it back.
 *
 * It makes no Discord calls (spec §16). The archive channel, its messages
 * and the source messages survive, and Clip can no longer locate or manage
 * them -- the confirmation copy says so.
 *
 * The session is rechecked under the lock, like a save: a request
 * authenticated before a concurrent deletion must not act after it.
 * Children go before parents because both foreign keys are RESTRICT.
 */
export async function deleteGuildData(
  guildId: string,
  sessionTokenHash: string,
  now: Date = new Date(),
): Promise<{ kind: 'DELETED' } | { kind: 'SESSION_REVOKED' }> {
  return withGuildLock(guildId, async (tx) => {
    if (!(await isAdminSessionLive(tx, sessionTokenHash, guildId, now))) {
      return { kind: 'SESSION_REVOKED' as const };
    }
    await tx.clipper.deleteMany({ where: { guildId } });
    await tx.clip.deleteMany({ where: { guildId } });
    await tx.guildAllowedRole.deleteMany({ where: { guildId } });
    await tx.guildConfig.deleteMany({ where: { guildId } });
    await tx.setupToken.deleteMany({ where: { guildId } });
    await tx.adminSession.deleteMany({ where: { guildId } });
    return { kind: 'DELETED' as const };
  });
}
