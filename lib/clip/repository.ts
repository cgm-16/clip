import type { ClipStatus, Prisma } from '@/generated/prisma/client';
import type { ArchiveMessageIds } from '@/lib/clip/types';
import { prisma } from '@/lib/db';

/** A Prisma client scoped to an open transaction. See `lockClip`. */
export type TxClient = Prisma.TransactionClient;

/** The Clip state the domain reasons about. Deliberately not the whole row. */
export type ClipRecord = {
  guildId: string;
  sourceMessageId: string;
  sourceChannelId: string;
  authorUserId: string;
  status: ClipStatus;
  archiveProvenanceMessageId: string | null;
  archiveForwardMessageId: string | null;
};

const clipRecordSelect = {
  guildId: true,
  sourceMessageId: true,
  sourceChannelId: true,
  authorUserId: true,
  status: true,
  archiveProvenanceMessageId: true,
  archiveForwardMessageId: true,
} as const;

function clipKey(guildId: string, sourceMessageId: string) {
  return { guildId_sourceMessageId: { guildId, sourceMessageId } };
}

/**
 * Creates the canonical Clip if absent and returns the row either way.
 *
 * The insert is conditional in the database (`ON CONFLICT DO NOTHING`), never an
 * upsert and never a read followed by a create. An upsert's update branch walks
 * straight over a `REMOVED_BY_AUTHOR` row, which is the harassment loop §7.4
 * exists to prevent; an application-level pre-read would let every one of ten
 * concurrent callers observe "absent" and race to create.
 *
 * Reading after the fact is safe: the conditional insert has already decided the
 * winner, and nothing ever rewrites a Clip's guild, message, channel or author.
 *
 * `created: false` means only "this call did not insert the row" -- it says
 * nothing about whether the archive exists. Callers must branch on
 * `clip.status`, since a claim whose follow-up work failed leaves a `PENDING`
 * row that a later caller still has to finish.
 */
export async function claimClip(input: {
  guildId: string;
  sourceMessageId: string;
  sourceChannelId: string;
  authorUserId: string;
}): Promise<{ created: boolean; clip: ClipRecord }> {
  const { count } = await prisma.clip.createMany({
    data: [input],
    skipDuplicates: true,
  });
  const clip = await prisma.clip.findUniqueOrThrow({
    where: clipKey(input.guildId, input.sourceMessageId),
    select: clipRecordSelect,
  });
  return { created: count === 1, clip };
}

/**
 * Runs `fn` with the canonical Clip row locked `FOR UPDATE` for the duration of
 * the transaction. Resolves to null without calling `fn` if the Clip is absent.
 *
 * The transaction client is handed to the callback as a parameter rather than
 * left for it to reach through the module-level `prisma`: a callback that used
 * the singleton would check out a second pool connection while holding the
 * first, which deadlocks under load rather than merely running slowly. Every
 * mutation below therefore takes `tx` first, so none of them is callable
 * outside a lock.
 */
export function lockClip<T>(
  guildId: string,
  sourceMessageId: string,
  fn: (tx: TxClient, clip: ClipRecord) => Promise<T>,
): Promise<T | null> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$executeRaw`
      SELECT 1 FROM clips
      WHERE guild_id = ${guildId} AND source_message_id = ${sourceMessageId}
      FOR UPDATE
    `;
    if (locked === 0) {
      return null;
    }

    const clip = await tx.clip.findUniqueOrThrow({
      where: clipKey(guildId, sourceMessageId),
      select: clipRecordSelect,
    });
    return fn(tx, clip);
  });
}

export async function addClipper(
  tx: TxClient,
  input: { guildId: string; sourceMessageId: string; clipperUserId: string },
): Promise<{ added: boolean }> {
  const { count } = await tx.clipper.createMany({ data: [input], skipDuplicates: true });
  return { added: count === 1 };
}

/**
 * Withdraws one clipper's preservation signal and reports how many survive it.
 *
 * `remaining` is read inside the caller's lock, so exactly one of two
 * simultaneous unclips can see zero.
 */
export async function removeClipper(
  tx: TxClient,
  input: { guildId: string; sourceMessageId: string; clipperUserId: string },
): Promise<{ removed: boolean; remaining: number }> {
  const { count } = await tx.clipper.deleteMany({ where: input });
  const remaining = await countClippers(tx, input.guildId, input.sourceMessageId);
  return { removed: count === 1, remaining };
}

export function countClippers(
  tx: TxClient,
  guildId: string,
  sourceMessageId: string,
): Promise<number> {
  return tx.clipper.count({ where: { guildId, sourceMessageId } });
}

/**
 * Publishes the archive and the status in one statement. The
 * `clips_active_requires_archive` CHECK rejects any attempt to split them, so a
 * Clip can never reach `ACTIVE` with a missing or partial Discord archive.
 */
export async function markActive(
  tx: TxClient,
  guildId: string,
  sourceMessageId: string,
  archive: ArchiveMessageIds,
): Promise<void> {
  await tx.clip.update({
    where: clipKey(guildId, sourceMessageId),
    data: {
      status: 'ACTIVE',
      archiveProvenanceMessageId: archive.provenanceMessageId,
      archiveForwardMessageId: archive.forwardMessageId,
    },
  });
}

export async function markDeleting(
  tx: TxClient,
  guildId: string,
  sourceMessageId: string,
): Promise<void> {
  await tx.clip.update({ where: clipKey(guildId, sourceMessageId), data: { status: 'DELETING' } });
}

export async function markFailed(
  tx: TxClient,
  guildId: string,
  sourceMessageId: string,
): Promise<void> {
  await tx.clip.update({ where: clipKey(guildId, sourceMessageId), data: { status: 'FAILED' } });
}

export async function markRemovedByAuthor(
  tx: TxClient,
  guildId: string,
  sourceMessageId: string,
  now: Date,
): Promise<void> {
  await tx.clip.update({
    where: clipKey(guildId, sourceMessageId),
    data: { status: 'REMOVED_BY_AUTHOR', removedAt: now },
  });
}

export async function markRemovedByAdmin(
  tx: TxClient,
  guildId: string,
  sourceMessageId: string,
  now: Date,
): Promise<void> {
  await tx.clip.update({
    where: clipKey(guildId, sourceMessageId),
    data: { status: 'REMOVED_BY_ADMIN', removedAt: now },
  });
}

/**
 * Clears both archive ids. Legal only once the Clip has left `ACTIVE`; the
 * CHECK enforces it. Recording a successful Discord delete this way is what
 * later lets the finalizer tell "already deleted, must recreate" apart from
 * "not yet attempted" (§9.3).
 */
export async function clearArchiveMessageIds(
  tx: TxClient,
  guildId: string,
  sourceMessageId: string,
): Promise<void> {
  await tx.clip.update({
    where: clipKey(guildId, sourceMessageId),
    data: { archiveProvenanceMessageId: null, archiveForwardMessageId: null },
  });
}

/** Drops every preservation signal, keeping the Clip row. Used when tombstoning. */
export async function deleteClippers(
  tx: TxClient,
  guildId: string,
  sourceMessageId: string,
): Promise<void> {
  await tx.clipper.deleteMany({ where: { guildId, sourceMessageId } });
}

/** Ordinary deletion: removes the clipper rows, then the Clip row. Leaves no tombstone. */
export async function deleteClipWithClippers(
  tx: TxClient,
  guildId: string,
  sourceMessageId: string,
): Promise<void> {
  await deleteClippers(tx, guildId, sourceMessageId);
  await tx.clip.delete({ where: clipKey(guildId, sourceMessageId) });
}

/** Reads for the service. Null when the guild has never completed setup. */
export async function findGuildArchiveConfig(
  guildId: string,
): Promise<{ archiveChannelId: string; allowedRoleIds: string[] } | null> {
  const config = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: { archiveChannelId: true, allowedRoles: { select: { roleId: true } } },
  });
  if (config === null) {
    return null;
  }
  return {
    archiveChannelId: config.archiveChannelId,
    allowedRoleIds: config.allowedRoles.map((role) => role.roleId),
  };
}
