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
 * `null` is therefore ambiguous: it means "no such Clip" *or* "the callback
 * returned null". A callback that needs the two told apart must resolve to
 * something else -- every mutation below returns a record or a flag object, so
 * no current caller can hit the ambiguity.
 *
 * Do no external I/O inside `fn`. The row lock is held until the transaction
 * commits, so a Discord round-trip in the callback blocks every other caller
 * for that message and shows up as an intermittent Prisma interactive
 * transaction timeout, which names nothing about the real cause. Fetch first,
 * then lock.
 *
 * The transaction client is handed to the callback as a parameter rather than
 * left for it to reach through the module-level `prisma`: a callback that used
 * the singleton would check out a second pool connection while holding the
 * first, which deadlocks under load rather than merely running slowly.
 *
 * The `tx`-first parameter on every mutation below is a convention, not an
 * enforcement. `TxClient` is `Omit<PrismaClient, ITXClientDenyList>`, which any
 * `prisma.$transaction` client satisfies without holding this row's lock, so
 * the compiler cannot tell a locked client from an unlocked one. It makes the
 * requirement visible at every call site; honouring it is the caller's
 * obligation, and the count-dependent ones -- `removeClipper` and
 * `countClippers` -- return answers that are simply wrong if it is not
 * honoured.
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

/**
 * Records one clipper's preservation signal. The insert is conditional in the
 * database, so simultaneous callers cannot each observe "absent" and both write.
 *
 * The fields are destructured rather than forwarded as `input`: a caller that
 * built its argument with a spread can carry extra keys that TypeScript's
 * excess-property check does not see through, and Prisma then rejects them at
 * runtime with "Unknown argument".
 */
export async function addClipper(
  tx: TxClient,
  input: { guildId: string; sourceMessageId: string; clipperUserId: string },
): Promise<{ added: boolean }> {
  const { guildId, sourceMessageId, clipperUserId } = input;
  const { count } = await tx.clipper.createMany({
    data: [{ guildId, sourceMessageId, clipperUserId }],
    skipDuplicates: true,
  });
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
  const { guildId, sourceMessageId, clipperUserId } = input;
  const { count } = await tx.clipper.deleteMany({
    where: { guildId, sourceMessageId, clipperUserId },
  });
  const remaining = await countClippers(tx, guildId, sourceMessageId);
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
 * The states no caller may move a Clip out of. Author or admin removal
 * overrides every other signal and its tombstone blocks recreation (spec §7.4),
 * so a caller acting on a decision it took before the removal must not write
 * over it.
 */
const TOMBSTONE_STATUSES: ClipStatus[] = ['REMOVED_BY_AUTHOR', 'REMOVED_BY_ADMIN'];

/**
 * Advances a live Clip's workflow state, reporting whether it applied.
 *
 * The tombstone predicate lives in the UPDATE, never in a preceding read. Each
 * of these transitions is decided across a Discord round-trip that is seconds
 * wide and runs outside any lock, so by the time the lock is taken the author
 * may already have removed the Clip; a read-then-write would only re-examine a
 * value it had already lost the race for. `applied: false` is the caller's
 * signal that the Clip was tombstoned while it worked, and that whatever it
 * built on Discord needs cleaning up rather than publishing.
 *
 * Called under `lockClip` the row is known to exist, so `applied: false` can
 * only mean "tombstoned", never "no such Clip".
 *
 * Only the workflow transitions are guarded this way. `clearArchiveMessageIds`
 * and `deleteClippers` must keep working on a tombstoned Clip: recording the
 * Discord delete and dropping the preservation signals is precisely what
 * tombstoning consists of.
 */
async function advanceLiveClip(
  tx: TxClient,
  guildId: string,
  sourceMessageId: string,
  data: Prisma.ClipUpdateManyMutationInput,
): Promise<{ applied: boolean }> {
  const { count } = await tx.clip.updateMany({
    where: { guildId, sourceMessageId, status: { notIn: TOMBSTONE_STATUSES } },
    data,
  });
  return { applied: count === 1 };
}

/**
 * Publishes the archive and the status in one statement, unless the Clip was
 * tombstoned while the archive was being built.
 *
 * Two database guards stand behind the predicate, and both hold against code
 * that has not been written yet: `clips_active_requires_archive` rejects an
 * ACTIVE Clip whose archive is missing or partial, and `clips_active_not_removed`
 * rejects one carrying a removal timestamp. The predicate is what turns the
 * second of those from a raised constraint violation into an outcome the caller
 * can act on.
 */
export function markActive(
  tx: TxClient,
  guildId: string,
  sourceMessageId: string,
  archive: ArchiveMessageIds,
): Promise<{ applied: boolean }> {
  return advanceLiveClip(tx, guildId, sourceMessageId, {
    status: 'ACTIVE',
    archiveProvenanceMessageId: archive.provenanceMessageId,
    archiveForwardMessageId: archive.forwardMessageId,
  });
}

/**
 * Opens the teardown window, unless the Clip was tombstoned meanwhile.
 *
 * No CHECK can stand behind this one: overwriting a tombstone's status with a
 * non-terminal one leaves a row that is still perfectly valid, just no longer a
 * tombstone. The predicate is the only guard there is.
 */
export function markDeleting(
  tx: TxClient,
  guildId: string,
  sourceMessageId: string,
): Promise<{ applied: boolean }> {
  return advanceLiveClip(tx, guildId, sourceMessageId, { status: 'DELETING' });
}

/** Records a failed archive attempt. Guarded for the same reason as `markDeleting`. */
export function markFailed(
  tx: TxClient,
  guildId: string,
  sourceMessageId: string,
): Promise<{ applied: boolean }> {
  return advanceLiveClip(tx, guildId, sourceMessageId, { status: 'FAILED' });
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
