import type { ClipStatus } from '@/generated/prisma/client';
import { canClip } from '@/lib/clip/authorization';
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
  type ClipRecord,
} from '@/lib/clip/repository';
import { assertTransition, canTransition, isTerminalStatus } from '@/lib/clip/state-machine';
import {
  ArchiveCreationFailedError,
  ArchiveTargetUnavailableError,
  type ArchiveMessageIds,
  type ClipCommandResult,
  type ClipInput,
  type DiscordArchiveGateway,
  type RemoveInput,
  type RemoveResult,
  type UnclipInput,
  type UnclipResult,
} from '@/lib/clip/types';
import { logClipEvent } from '@/lib/logging/safe-log';

/** Identifies the canonical Clip every operation here serializes around. */
type ClipKey = { guildId: string; sourceMessageId: string };

/**
 * The archive as a pair, or null when the Clip has none.
 *
 * Half a pair is not an archive: `clips_active_requires_archive` makes a
 * half-populated ACTIVE row impossible, and outside ACTIVE a lone id would
 * describe a Discord message the control plane cannot address as an entry.
 */
function archiveOf(clip: ClipRecord): ArchiveMessageIds | null {
  if (clip.archiveProvenanceMessageId === null || clip.archiveForwardMessageId === null) {
    return null;
  }
  return {
    provenanceMessageId: clip.archiveProvenanceMessageId,
    forwardMessageId: clip.archiveForwardMessageId,
  };
}

function logTransition(key: ClipKey, from: ClipStatus, to: ClipStatus): void {
  logClipEvent({
    event: 'clip.state_changed',
    guildId: key.guildId,
    sourceMessageId: key.sourceMessageId,
    stateFrom: from,
    stateTo: to,
  });
}

/**
 * The error code for a log line. Never the message: an exception raised by the
 * Discord client can carry a response body, and a response body can carry
 * message content (§12, §17 case 18).
 */
function errorCodeOf(error: unknown): string {
  if (error instanceof ArchiveTargetUnavailableError) {
    return 'ARCHIVE_TARGET_UNAVAILABLE';
  }
  if (error instanceof ArchiveCreationFailedError) {
    return error.retryable ? 'ARCHIVE_CREATE_RETRYABLE' : 'ARCHIVE_CREATE_PERMANENT';
  }
  return 'ARCHIVE_UNEXPECTED_ERROR';
}

export function createClipService(gateway: DiscordArchiveGateway) {
  /**
   * Deletes an archive we can no longer reference, never failing the caller.
   *
   * Every call site has already committed the control-plane outcome the user
   * asked for; the Discord messages are the part that may be left behind. A
   * throw here would replace a recoverable orphan with an unrecoverable lie
   * about what happened.
   */
  async function deleteArchiveQuietly(
    key: ClipKey,
    archiveChannelId: string,
    archive: ArchiveMessageIds,
  ): Promise<boolean> {
    try {
      await gateway.deleteArchiveMessage(archiveChannelId, archive);
      return true;
    } catch (error) {
      logClipEvent({
        event: 'clip.archive_delete_failed',
        guildId: key.guildId,
        sourceMessageId: key.sourceMessageId,
        errorCode: errorCodeOf(error),
      });
      return false;
    }
  }

  /**
   * Records that archive creation did not succeed, unless the Clip moved
   * somewhere `FAILED` is no longer reachable from while the attempt ran.
   *
   * The status is re-read under a fresh lock because the attempt spanned a
   * Discord round-trip: the author may have removed the Clip meanwhile, and
   * `ACTIVE -> FAILED` (a concurrent retry that won) would blank the §9.3
   * signal while leaving both ids in place.
   */
  async function recordArchiveFailure(key: ClipKey): Promise<void> {
    await lockClip(key.guildId, key.sourceMessageId, async (tx, locked) => {
      if (!canTransition(locked.status, 'FAILED')) {
        return;
      }
      assertTransition(locked.status, 'FAILED');
      const { applied } = await markFailed(tx, key.guildId, key.sourceMessageId);
      if (applied) {
        logTransition(key, locked.status, 'FAILED');
      }
    });
  }

  /**
   * Publishes a freshly created archive, or reports that it can no longer be
   * published and must be taken back down.
   *
   * `markActive` is only ever reached with both ids already posted to Discord:
   * `clips_active_requires_archive` rejects the other order at commit time, and
   * an ACTIVE row pointing at messages that do not exist is precisely the false
   * ACTIVE state §17 case 7 forbids.
   */
  async function publishArchive(
    key: ClipKey,
    archive: ArchiveMessageIds,
  ): Promise<{ published: true } | { published: false; clip: ClipRecord | null }> {
    const outcome = await lockClip(key.guildId, key.sourceMessageId, async (tx, locked) => {
      if (!canTransition(locked.status, 'ACTIVE')) {
        return { published: false as const, clip: locked };
      }
      assertTransition(locked.status, 'ACTIVE');
      const { applied } = await markActive(tx, key.guildId, key.sourceMessageId, archive);
      if (!applied) {
        return { published: false as const, clip: locked };
      }
      logTransition(key, locked.status, 'ACTIVE');
      return { published: true as const };
    });
    return outcome ?? { published: false, clip: null };
  }

  async function clip(input: ClipInput): Promise<ClipCommandResult> {
    const key = { guildId: input.guildId, sourceMessageId: input.sourceMessageId };
    const config = await findGuildArchiveConfig(input.guildId);
    if (config === null) {
      // §17 case 12: clipping fails safely until an admin configures the guild.
      // No DB write -- an unconfigured guild has nowhere to put the archive.
      logClipEvent({
        event: 'clip.rejected',
        guildId: input.guildId,
        sourceMessageId: input.sourceMessageId,
        userId: input.clipperUserId,
        errorCode: 'GUILD_NOT_CONFIGURED',
      });
      return { kind: 'FAILED', retryable: false };
    }

    if (
      !canClip({
        hasManageGuild: input.clipperHasManageGuild,
        memberRoleIds: input.clipperRoleIds,
        allowedRoleIds: config.allowedRoleIds,
      })
    ) {
      logClipEvent({
        event: 'clip.rejected',
        guildId: input.guildId,
        sourceMessageId: input.sourceMessageId,
        userId: input.clipperUserId,
        errorCode: 'NOT_AUTHORIZED',
      });
      return { kind: 'NOT_AUTHORIZED' };
    }

    const { created, clip: claimed } = await claimClip({
      guildId: input.guildId,
      sourceMessageId: input.sourceMessageId,
      sourceChannelId: input.sourceChannelId,
      authorUserId: input.sourceAuthorUserId,
    });
    if (isTerminalStatus(claimed.status)) {
      // §7.4: the tombstone blocks recreation, and no preservation signal is
      // recorded against it -- recording one would resurrect the harassment
      // loop the moment the tombstone were ever lifted.
      return { kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' };
    }

    const joined = await lockClip(input.guildId, input.sourceMessageId, async (tx, locked) => {
      if (isTerminalStatus(locked.status)) {
        return { tombstoned: true as const };
      }
      const { added } = await addClipper(tx, {
        guildId: input.guildId,
        sourceMessageId: input.sourceMessageId,
        clipperUserId: input.clipperUserId,
      });
      return {
        tombstoned: false as const,
        added,
        status: locked.status,
        archive: archiveOf(locked),
      };
    });
    if (joined === null) {
      // The Clip was deleted between the claim and the lock, so this request's
      // signal never landed. Retrying re-claims it from scratch.
      return { kind: 'FAILED', retryable: true };
    }
    if (joined.tombstoned) {
      return { kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' };
    }

    // §9.4: only the request that claimed a *new* Clip may create the first
    // archive. A `FAILED` Clip is the one exception, and not a violation of it:
    // it has no archive at all, so completing it creates a first archive rather
    // than a second one. The decision deliberately ignores `added` -- the user
    // retrying a failed clip is usually the same one whose signal is already
    // recorded (§17 case 7).
    const mustCreateArchive = created || joined.status === 'FAILED';
    if (!mustCreateArchive) {
      return joined.added
        ? { kind: 'CLIPPER_ADDED', archive: joined.archive }
        : { kind: 'ALREADY_CLIPPED_BY_USER', archive: joined.archive };
    }

    let archive: ArchiveMessageIds;
    try {
      archive = await gateway.createArchiveMessage({
        archiveChannelId: config.archiveChannelId,
        sourceChannelId: input.sourceChannelId,
        sourceMessageId: input.sourceMessageId,
        sourceAuthorUserId: input.sourceAuthorUserId,
      });
    } catch (error) {
      logClipEvent({
        event: 'clip.archive_failed',
        guildId: input.guildId,
        sourceMessageId: input.sourceMessageId,
        errorCode: errorCodeOf(error),
      });
      if (error instanceof ArchiveCreationFailedError && error.orphanedProvenanceMessageId !== null) {
        // §17 case 19: never leave a provenance line pointing at a snapshot
        // that does not exist. The pair repeats the orphan's id because the
        // forward it described was never posted and has no id of its own; the
        // gateway contract already requires deleting an absent message to be a
        // no-op.
        await deleteArchiveQuietly(key, config.archiveChannelId, {
          provenanceMessageId: error.orphanedProvenanceMessageId,
          forwardMessageId: error.orphanedProvenanceMessageId,
        });
      }
      await recordArchiveFailure(key);
      if (error instanceof ArchiveTargetUnavailableError) {
        return { kind: 'SOURCE_UNAVAILABLE' };
      }
      if (error instanceof ArchiveCreationFailedError) {
        return { kind: 'FAILED', retryable: error.retryable };
      }
      // An error the gateway contract does not describe still leaves the Clip
      // recoverable through the FAILED retry path (§17 case 7) rather than
      // stranding it PENDING.
      return { kind: 'FAILED', retryable: false };
    }

    const published = await publishArchive(key, archive);
    if (published.published) {
      return { kind: 'CREATED', archive };
    }

    // The Clip moved out of reach while the archive was being built, so the two
    // messages just posted are unreferenced and have to come back down.
    await deleteArchiveQuietly(key, config.archiveChannelId, archive);
    if (published.clip === null) {
      return { kind: 'FAILED', retryable: true };
    }
    if (isTerminalStatus(published.clip.status)) {
      return { kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' };
    }
    // A concurrent retry published its archive first; this request's signal is
    // still recorded, so report the archive that won.
    const winning = archiveOf(published.clip);
    return joined.added
      ? { kind: 'CLIPPER_ADDED', archive: winning }
      : { kind: 'ALREADY_CLIPPED_BY_USER', archive: winning };
  }

  /**
   * Finishes the ordinary deletion opened by the last unclip (§9.3).
   *
   * Runs entirely outside the `DELETING` lock: the Discord round-trip is
   * seconds wide, and holding the row lock across it blocks every other caller
   * for that message. That window is the whole difficulty -- a removal, a
   * revival, or both can land inside it, so the state is re-read under a fresh
   * lock rather than assumed from what the unclip saw.
   */
  async function finalizeDeletion(context: {
    key: ClipKey;
    archiveChannelId: string | null;
    archive: ArchiveMessageIds | null;
  }): Promise<void> {
    const { key, archiveChannelId, archive } = context;
    // Whether Discord is done with the pair this finalizer was sent to remove.
    // A Clip with no archive has nothing outstanding; one whose guild lost its
    // configuration has two messages nobody can address, which is the same
    // position as a delete that failed.
    let archiveRemoved = archive === null;
    if (archive !== null && archiveChannelId !== null) {
      archiveRemoved = await deleteArchiveQuietly(key, archiveChannelId, archive);
    }

    const outcome = await lockClip(key.guildId, key.sourceMessageId, async (tx, locked) => {
      if (locked.status === 'ACTIVE') {
        // A concurrent publish won the row while the delete was in flight. Its
        // ids are that publish's, not the pair taken down here, so neither
        // clearing them nor deleting the row is this finalizer's to do --
        // and clearing them would violate `clips_active_requires_archive` and
        // reject the caller's whole unclip.
        return { revived: false as const };
      }
      if (archiveRemoved) {
        // Discord is done with the pair, so the row must say so before the lock
        // is released, or a concurrent revival cannot tell whether the archive
        // still exists.
        await clearArchiveMessageIds(tx, key.guildId, key.sourceMessageId);
      }
      if (isTerminalStatus(locked.status)) {
        // A removal landed in the window. The row this finalizer was sent to
        // delete is now a tombstone, and §7.4 puts that above the deletion:
        // dropping it would unblock recreation of a message its author
        // explicitly removed. The clipper count cannot decide this -- removal
        // drops every clipper row, so a tombstone always reads as zero.
        return { revived: false as const };
      }
      if (!archiveRemoved) {
        // Two messages are still up and the row's ids are the only handle on
        // them. Leaving the Clip DELETING keeps it visible to reconciliation;
        // deleting the row would strand published content with nothing left to
        // match it against.
        return { revived: false as const };
      }
      if ((await countClippers(tx, key.guildId, key.sourceMessageId)) === 0) {
        await deleteClipWithClippers(tx, key.guildId, key.sourceMessageId);
        return { revived: false as const };
      }
      return { revived: true as const, clip: locked };
    });
    if (outcome === null || !outcome.revived) {
      return;
    }

    if (archiveChannelId === null) {
      return;
    }

    // A preservation signal arrived while the delete was in flight, so the Clip
    // must converge back to an active archive (§9.8). The new archive is posted
    // before ACTIVE is written, never after.
    let recreated: ArchiveMessageIds;
    try {
      recreated = await gateway.createArchiveMessage({
        archiveChannelId,
        sourceChannelId: outcome.clip.sourceChannelId,
        sourceMessageId: outcome.clip.sourceMessageId,
        sourceAuthorUserId: outcome.clip.authorUserId,
      });
    } catch (error) {
      logClipEvent({
        event: 'clip.revival_failed',
        guildId: key.guildId,
        sourceMessageId: key.sourceMessageId,
        errorCode: errorCodeOf(error),
      });
      return;
    }

    const published = await publishArchive(key, recreated);
    if (!published.published) {
      await deleteArchiveQuietly(key, archiveChannelId, recreated);
    }
  }

  async function unclip(input: UnclipInput): Promise<UnclipResult> {
    const key = { guildId: input.guildId, sourceMessageId: input.sourceMessageId };
    // Read before the lock: the finalizer needs the archive channel, and no
    // external read may happen inside a `lockClip` callback.
    const config = await findGuildArchiveConfig(input.guildId);

    const outcome = await lockClip(input.guildId, input.sourceMessageId, async (tx, locked) => {
      const { removed, remaining } = await removeClipper(tx, {
        guildId: input.guildId,
        sourceMessageId: input.sourceMessageId,
        clipperUserId: input.clipperUserId,
      });
      if (!removed) {
        return { kind: 'NOT_CLIPPED' as const };
      }
      if (remaining > 0) {
        return { kind: 'KEPT' as const, remaining };
      }
      if (locked.status === 'DELETING') {
        // Deletion is already in flight: this Clip was revived inside the
        // window and has now lost that signal again. Its finalizer re-reads the
        // clipper count under the lock, so it converges without a second
        // finalizer duplicating the Discord delete.
        return { kind: 'ALREADY_DELETING' as const };
      }
      assertTransition(locked.status, 'DELETING');
      const { applied } = await markDeleting(tx, input.guildId, input.sourceMessageId);
      if (!applied) {
        // Unreachable: tombstoning drops every clipper row, so `removed` cannot
        // be true on a tombstoned Clip.
        return { kind: 'ALREADY_DELETING' as const };
      }
      logTransition(key, locked.status, 'DELETING');
      return { kind: 'DELETING' as const, archive: archiveOf(locked) };
    });

    if (outcome === null) {
      return { kind: 'NOT_FOUND' };
    }
    if (outcome.kind === 'NOT_CLIPPED') {
      return { kind: 'NOT_CLIPPED_BY_USER' };
    }
    if (outcome.kind === 'KEPT') {
      return { kind: 'UNCLIPPED', remaining: outcome.remaining };
    }
    if (outcome.kind === 'DELETING') {
      await finalizeDeletion({
        key,
        archiveChannelId: config?.archiveChannelId ?? null,
        archive: outcome.archive,
      });
    }
    return { kind: 'UNCLIPPED', remaining: 0 };
  }

  async function removeByAuthorOrAdmin(input: RemoveInput): Promise<RemoveResult> {
    const key = { guildId: input.guildId, sourceMessageId: input.sourceMessageId };
    // §17 case 12: an unconfigured guild has no archive channel to delete from,
    // but the control plane must still converge on the tombstone.
    const config = await findGuildArchiveConfig(input.guildId);

    const outcome = await lockClip(input.guildId, input.sourceMessageId, async (tx, locked) => {
      // Not `canClip`: a configured clip role grants preservation, never
      // removal. Only the source author and a guild manager may remove (§7.4).
      const isAuthor = input.invokerUserId === locked.authorUserId;
      if (!isAuthor && !input.invokerHasManageGuild) {
        return { kind: 'NOT_AUTHORIZED' as const };
      }
      if (isTerminalStatus(locked.status)) {
        // Already tombstoned: removal is idempotent (§9.3 of the invariants),
        // so the tombstone stands as written and `removedAt` keeps naming the
        // removal that made it. Ids can still be on it, though: `markActive`
        // is their only writer and `publishArchive` gates it on a transition
        // no tombstone has, so ids here are the pair an earlier Discord delete
        // failed to take down. Returning them makes this call retry that
        // delete rather than report a cleanup that never happened.
        return { kind: 'REMOVED' as const, archive: archiveOf(locked) };
      }

      const next = isAuthor ? 'REMOVED_BY_AUTHOR' : 'REMOVED_BY_ADMIN';
      assertTransition(locked.status, next);
      const now = new Date();
      if (isAuthor) {
        await markRemovedByAuthor(tx, input.guildId, input.sourceMessageId, now);
      } else {
        await markRemovedByAdmin(tx, input.guildId, input.sourceMessageId, now);
      }
      // §7.4: removal overrides all clipper signals. Signals left behind would
      // let a later Unclip report a preservation that no longer means anything.
      await deleteClippers(tx, input.guildId, input.sourceMessageId);
      logTransition(key, locked.status, next);
      return { kind: 'REMOVED' as const, archive: archiveOf(locked) };
    });

    if (outcome === null) {
      return { kind: 'NOT_FOUND' };
    }
    if (outcome.kind === 'NOT_AUTHORIZED') {
      return { kind: 'NOT_AUTHORIZED' };
    }
    if (outcome.archive !== null && config !== null) {
      // The tombstone is committed before the Discord delete is attempted. If
      // the delete fails, the tombstone keeps ids that may still address live
      // messages -- visible, reconcilable, and far better than leaving the Clip
      // clippable while its archive is gone.
      const deleted = await deleteArchiveQuietly(key, config.archiveChannelId, outcome.archive);
      if (deleted) {
        await lockClip(key.guildId, key.sourceMessageId, (tx) =>
          clearArchiveMessageIds(tx, key.guildId, key.sourceMessageId),
        );
      }
    }
    return { kind: 'REMOVED' };
  }

  return { clip, unclip, removeByAuthorOrAdmin };
}
