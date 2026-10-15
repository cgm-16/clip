import type { ClipStatus } from '@/generated/prisma/client';
import { canClip } from '@/lib/clip/authorization';
import {
  addClipper,
  claimClipInTransaction,
  clearArchiveMessageIds,
  countClippers,
  deleteClipWithClippers,
  deleteClippers,
  findGuildArchiveConfig,
  lockClip,
  lockGuildConfig,
  markActive,
  markDeleting,
  markFailed,
  markRemovedByAdmin,
  markRemovedByAuthor,
  readArchiveChannelId,
  removeClipper,
  replaceArchiveMessageIds,
  leaseExpiredBefore,
  takeOverStaleClip,
  type ClipRecord,
  type TxClient,
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
import { logClipEvent, type SafeClipLog } from '@/lib/logging/safe-log';

/**
 * Takes over a `PENDING` or `DELETING` Clip whose owner is past the lease. See
 * `takeOverStaleClip`; any other status is never taken over.
 */
async function takeOverIfStale(tx: TxClient, clip: ClipRecord): Promise<boolean> {
  if (clip.status !== 'PENDING' && clip.status !== 'DELETING') {
    return false;
  }
  const { taken } = await takeOverStaleClip(
    tx,
    clip.guildId,
    clip.sourceMessageId,
    clip.status,
    leaseExpiredBefore(),
  );
  return taken;
}

/** Identifies the canonical Clip every operation here serializes around. */
type ClipKey = { guildId: string; sourceMessageId: string };

/**
 * Where `finalizeDeletion` left the Clip: ACTIVE on the pair it holds --
 * published by this finalizer or by a concurrent publish that won the row --
 * a tombstone, or anything else: deleted, FAILED, or still DELETING.
 */
type DeletionOutcome =
  | { kind: 'ACTIVE'; archive: ArchiveMessageIds }
  | { kind: 'TOMBSTONED' }
  | { kind: 'UNSETTLED' };

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

function logClipRejected(input: ClipInput, errorCode: string): void {
  logClipEvent({
    event: 'clip.rejected',
    guildId: input.guildId,
    sourceMessageId: input.sourceMessageId,
    userId: input.clipperUserId,
    errorCode,
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

/**
 * Which Discord call failed and how, for an archive-creation log line: the
 * step plus the status and Discord code, or `timeout` / `network`. Built from
 * the error's typed fields, never its message.
 */
function archiveFailureFields(
  error: unknown,
): Pick<SafeClipLog, 'step' | 'failure' | 'httpStatus' | 'discordCode'> {
  if (
    !(error instanceof ArchiveCreationFailedError) &&
    !(error instanceof ArchiveTargetUnavailableError)
  ) {
    return {};
  }
  return { step: error.step, ...error.failure };
}

/** The reply to a clip whose signal is recorded on a Clip holding `archive`. */
function signalReply(added: boolean, archive: ArchiveMessageIds | null): ClipCommandResult {
  return added
    ? { kind: 'CLIPPER_ADDED', archive }
    : { kind: 'ALREADY_CLIPPED_BY_USER', archive };
}

/**
 * The reply when an archive this request posted lost the row to someone else
 * and has been taken back down. `clip` is the row as the losing write found
 * it, or null when it was gone, its configuration replaced, or its archive
 * channel repointed.
 */
function lostPublishReply(clip: ClipRecord | null, added: boolean): ClipCommandResult {
  if (clip === null) {
    return { kind: 'FAILED', retryable: true };
  }
  if (isTerminalStatus(clip.status)) {
    return { kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' };
  }
  // A concurrent retry published its archive first, or the row still holds a
  // pair whose deletion is unfinished; this request's signal is still
  // recorded, so report the archive the row holds.
  return signalReply(added, archiveOf(clip));
}

/**
 * `lockClip`'s configuration check for the lifetime a request started under.
 * A guild with no configuration (§17 case 12) passes null, which still lets
 * Unclip and removal converge -- and refuses if a setup appeared meanwhile.
 */
function configurationOptions(configurationId: string | null): { configurationId: string | null } {
  return { configurationId };
}

export function createClipService(gateway: DiscordArchiveGateway) {
  /**
   * Deletes an archive we can no longer reference, never failing the caller.
   *
   * Every call site has already committed the control-plane outcome the user
   * asked for; the Discord messages are the part that may be left behind. A
   * throw here would replace a recoverable orphan with an unrecoverable lie
   * about what happened. The failure log names the pair so an orphan can be
   * found and deleted by hand.
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
        archiveProvenanceMessageId: archive.provenanceMessageId,
        archiveForwardMessageId: archive.forwardMessageId,
        errorCode: errorCodeOf(error),
      });
      return false;
    }
  }

  /**
   * §17 case 19: never leave a provenance line pointing at a snapshot that
   * does not exist. The pair repeats the orphan's id because the forward it
   * described was never posted and has no id of its own; the gateway contract
   * already requires deleting an absent message to be a no-op.
   */
  async function deleteOrphanedProvenance(
    key: ClipKey,
    archiveChannelId: string,
    error: unknown,
  ): Promise<void> {
    if (error instanceof ArchiveCreationFailedError && error.orphanedProvenanceMessageId !== null) {
      await deleteArchiveQuietly(key, archiveChannelId, {
        provenanceMessageId: error.orphanedProvenanceMessageId,
        forwardMessageId: error.orphanedProvenanceMessageId,
      });
    }
  }

  /**
   * Reposts an ACTIVE Clip's archive when Discord confirms its copy is gone,
   * then replies to the clip that found it.
   *
   * The repost goes to the guild's current archive channel: setup refuses to
   * repoint the channel while live Clips exist unless Discord confirms the old
   * one is gone, so every ACTIVE pair lives in the current channel.
   *
   * Runs outside any lock, like every other Discord round-trip here. The swap
   * applies only if the row is still ACTIVE on exactly `archive`, so an
   * unclip, a removal, a re-setup or a concurrent repost that landed in the
   * window wins, and this request's pair comes back down instead. The old
   * pair is deleted only once the swap applied: before that it is still the
   * row's, and its provenance line may be all that survives of it.
   *
   * A failed repost leaves the row as it was -- still ACTIVE on the old ids,
   * still shown as missing -- rather than FAILED, which would blank a Clip
   * whose members are still asking to keep it.
   */
  async function repostIfMissing(context: {
    input: ClipInput;
    archiveChannelId: string;
    configurationId: string;
    archive: ArchiveMessageIds;
    added: boolean;
  }): Promise<ClipCommandResult> {
    const { input, archiveChannelId, configurationId, archive, added } = context;
    const key = { guildId: input.guildId, sourceMessageId: input.sourceMessageId };
    if (!(await gateway.isArchiveCopyMissing(archiveChannelId, archive))) {
      return signalReply(added, archive);
    }

    let reposted: ArchiveMessageIds;
    try {
      reposted = await gateway.createArchiveMessage({
        guildId: input.guildId,
        archiveChannelId,
        sourceChannelId: input.sourceChannelId,
        sourceMessageId: input.sourceMessageId,
        sourceAuthorUserId: input.sourceAuthorUserId,
      });
    } catch (error) {
      logClipEvent({
        event: 'clip.repost_failed',
        guildId: key.guildId,
        sourceMessageId: key.sourceMessageId,
        errorCode: errorCodeOf(error),
        ...archiveFailureFields(error),
      });
      await deleteOrphanedProvenance(key, archiveChannelId, error);
      return signalReply(added, archive);
    }

    const swap = await lockClip(key.guildId, key.sourceMessageId, async (tx, locked) => {
      const { applied } = await replaceArchiveMessageIds(
        tx,
        key.guildId,
        key.sourceMessageId,
        archive,
        reposted,
      );
      return { applied, clip: locked };
    }, { configurationId });
    if (swap?.applied) {
      logClipEvent({
        event: 'clip.reposted',
        guildId: key.guildId,
        sourceMessageId: key.sourceMessageId,
        archiveProvenanceMessageId: reposted.provenanceMessageId,
        archiveForwardMessageId: reposted.forwardMessageId,
      });
      await deleteArchiveQuietly(key, archiveChannelId, archive);
      return signalReply(added, reposted);
    }
    await deleteArchiveQuietly(key, archiveChannelId, reposted);
    return lostPublishReply(swap?.clip ?? null, added);
  }

  /**
   * Records that archive creation did not succeed, unless the Clip moved
   * somewhere `FAILED` is no longer reachable from while the attempt ran.
   *
   * A Clip with no clipper and no archive is deleted instead: every signal was
   * withdrawn during the attempt, so a FAILED row would preserve nothing.
   *
   * The status is re-read under a fresh lock because the attempt spanned a
   * Discord round-trip: the author may have removed the Clip meanwhile, and
   * `ACTIVE -> FAILED` (a concurrent retry that won) would blank the §9.3
   * signal while leaving both ids in place.
   */
  async function recordArchiveFailure(key: ClipKey, configurationId: string): Promise<void> {
    await lockClip(key.guildId, key.sourceMessageId, async (tx, locked) => {
      if (!canTransition(locked.status, 'FAILED')) {
        return;
      }
      if (
        archiveOf(locked) === null &&
        (await countClippers(tx, key.guildId, key.sourceMessageId)) === 0
      ) {
        await deleteClipWithClippers(tx, key.guildId, key.sourceMessageId);
        return;
      }
      assertTransition(locked.status, 'FAILED');
      const { applied } = await markFailed(tx, key.guildId, key.sourceMessageId);
      if (applied) {
        logTransition(key, locked.status, 'FAILED');
      }
    }, { configurationId });
  }

  /**
   * Publishes a freshly created archive, or reports that it can no longer be
   * published and must be taken back down.
   *
   * `markActive` is only ever reached with both ids already posted to Discord:
   * `clips_active_requires_archive` rejects the other order at commit time, and
   * an ACTIVE row pointing at messages that do not exist is precisely the false
   * ACTIVE state §17 case 7 forbids.
   *
   * `archiveChannelId` is the channel the pair was posted into. A FAILED Clip
   * holding no ids, or a PENDING one past its lease, does not block a repoint
   * (`findArchiveChangeBlocker`), so the guild may have moved off that channel
   * during the post; the publish is then declined.
   */
  async function publishArchive(
    key: ClipKey,
    archive: ArchiveMessageIds,
    archiveChannelId: string,
    configurationId: string | null,
  ): Promise<{ published: true } | { published: false; clip: ClipRecord | null }> {
    const outcome = await lockClip(key.guildId, key.sourceMessageId, async (tx, locked) => {
      if (!canTransition(locked.status, 'ACTIVE')) {
        return { published: false as const, clip: locked };
      }
      // An ACTIVE Clip is one at least one member is still asking to keep. With
      // no clipper rows left, `removeClipper` reports `removed: false` to
      // everyone, so no unclip could ever take the archive down again and only
      // an author or admin removal would clear it. The count is read under the
      // same lock that writes ACTIVE: the caller's own count was read before a
      // Discord round-trip, and the signal can be withdrawn inside it.
      if ((await countClippers(tx, key.guildId, key.sourceMessageId)) === 0) {
        return { published: false as const, clip: locked };
      }
      assertTransition(locked.status, 'ACTIVE');
      const { applied } = await markActive(tx, key.guildId, key.sourceMessageId, archive);
      if (!applied) {
        return { published: false as const, clip: locked };
      }
      logTransition(key, locked.status, 'ACTIVE');
      return { published: true as const };
    }, { ...configurationOptions(configurationId), archiveChannelId });
    return outcome ?? { published: false, clip: null };
  }

  async function clip(input: ClipInput): Promise<ClipCommandResult> {
    const key = { guildId: input.guildId, sourceMessageId: input.sourceMessageId };
    const claim = await lockGuildConfig(input.guildId, async (tx, config) => {
      if (
        !canClip({
          hasManageGuild: input.clipperHasManageGuild,
          memberRoleIds: input.clipperRoleIds,
          allowedRoleIds: config.allowedRoleIds,
        })
      ) {
        return { kind: 'NOT_AUTHORIZED' as const };
      }

      const claimed = await claimClipInTransaction(tx, {
        guildId: input.guildId,
        sourceMessageId: input.sourceMessageId,
        sourceChannelId: input.sourceChannelId,
        authorUserId: input.sourceAuthorUserId,
      });
      return { kind: 'CLAIMED' as const, config, ...claimed };
    });
    if (claim === null) {
      // §17 case 12: clipping fails safely until an admin configures the guild.
      // No DB write -- an unconfigured guild has nowhere to put the archive.
      logClipRejected(input, 'GUILD_NOT_CONFIGURED');
      return { kind: 'FAILED', retryable: false };
    }

    if (claim.kind === 'NOT_AUTHORIZED') {
      logClipRejected(input, 'NOT_AUTHORIZED');
      return { kind: 'NOT_AUTHORIZED' };
    }

    const { config, created, clip: claimed } = claim;
    // Every later write rechecks the configuration this claim ran under: a
    // deletion followed by re-setup inside the Discord round-trip must not let
    // this request write onto the new configuration's Clip.
    const { configurationId } = config;
    if (isTerminalStatus(claimed.status)) {
      // §7.4: the tombstone blocks recreation, and no preservation signal is
      // recorded against it -- recording one would resurrect the harassment
      // loop the moment the tombstone were ever lifted.
      logClipRejected(input, claimed.status);
      return { kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' };
    }

    const joined = await lockClip(input.guildId, input.sourceMessageId, async (tx, locked) => {
      if (isTerminalStatus(locked.status)) {
        return { tombstoned: true as const, status: locked.status };
      }
      const { added } = await addClipper(tx, {
        guildId: input.guildId,
        sourceMessageId: input.sourceMessageId,
        clipperUserId: input.clipperUserId,
      });
      // After the signal, in the same transaction: a takeover of a DELETING
      // Clip decides revive-or-delete by the clipper count, which must already
      // include this one.
      const takenOver = await takeOverIfStale(tx, locked);
      return {
        tombstoned: false as const,
        added,
        status: locked.status,
        takenOver,
        archive: archiveOf(locked),
      };
    }, { ...configurationOptions(configurationId), archiveChannelId: config.archiveChannelId });
    if (joined === null) {
      // The Clip was deleted between the claim and the lock, or the archive
      // channel was repointed in that gap, so this request's signal never
      // landed and nothing was posted. Retrying re-claims it from scratch.
      // A row this request created would otherwise sit PENDING inside its
      // lease, unreachable by a retry; a row it did not create may belong to
      // a live creator, so it is left alone.
      if (created) await recordArchiveFailure(key, configurationId);
      return { kind: 'FAILED', retryable: true };
    }
    if (joined.tombstoned) {
      logClipRejected(input, joined.status);
      return { kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' };
    }

    if (joined.status === 'DELETING' && joined.takenOver) {
      // The finalizer that owned this deletion is gone. This request finishes
      // it: retry the Discord delete, then revive on the signal just recorded.
      // `joined.archive` is the pair being taken down, so the reply reports
      // only what the finalizer left, and success only for an ACTIVE pair.
      const deletion = await finalizeDeletion({
        key,
        archiveChannelId: config.archiveChannelId,
        archive: joined.archive,
        configurationId,
      });
      if (deletion.kind === 'TOMBSTONED') {
        return { kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' };
      }
      if (deletion.kind === 'UNSETTLED') {
        return { kind: 'FAILED', retryable: true };
      }
      return signalReply(joined.added, deletion.archive);
    }

    // §9.4: only the request that claimed a *new* Clip may create the first
    // archive. A `FAILED` Clip is one exception, and not a violation of it:
    // it has no archive at all, so completing it creates a first archive rather
    // than a second one. The decision deliberately ignores `added` -- the user
    // retrying a failed clip is usually the same one whose signal is already
    // recorded (§17 case 7). A `PENDING` Clip past the lease is the other: its
    // creator is gone, and the lease claim makes this request the only one
    // that replaces it. A `PENDING` Clip inside the lease is never taken over,
    // because its creator may still be mid-round-trip.
    const mustCreateArchive =
      created || joined.status === 'FAILED' || (joined.status === 'PENDING' && joined.takenOver);
    if (!mustCreateArchive) {
      // Only an ACTIVE Clip: a PENDING one inside the lease has a creator
      // still mid-round-trip, and its missing copy is not missing yet.
      if (joined.status === 'ACTIVE' && joined.archive !== null) {
        return repostIfMissing({
          input,
          archiveChannelId: config.archiveChannelId,
          configurationId,
          archive: joined.archive,
          added: joined.added,
        });
      }
      return signalReply(joined.added, joined.archive);
    }

    let archive: ArchiveMessageIds;
    try {
      archive = await gateway.createArchiveMessage({
        guildId: input.guildId,
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
        ...archiveFailureFields(error),
      });
      await deleteOrphanedProvenance(key, config.archiveChannelId, error);
      await recordArchiveFailure(key, configurationId);
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

    const published = await publishArchive(key, archive, config.archiveChannelId, configurationId);
    if (published.published) {
      return { kind: 'CREATED', archive };
    }

    // The Clip moved out of reach while the archive was being built, so the two
    // messages just posted are unreferenced and have to come back down.
    await deleteArchiveQuietly(key, config.archiveChannelId, archive);
    return lostPublishReply(published.clip, joined.added);
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
    configurationId: string | null;
  }): Promise<DeletionOutcome> {
    const { key, archiveChannelId, configurationId } = context;
    let archive = context.archive;

    for (;;) {
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
          return { revived: false as const, active: archiveOf(locked) };
        }
        const held = archiveOf(locked);
        if (
          held !== null &&
          (archive === null ||
            held.provenanceMessageId !== archive.provenanceMessageId ||
            held.forwardMessageId !== archive.forwardMessageId)
        ) {
          // The row holds a pair this finalizer was never sent: a taker past
          // the lease revived the Clip and a later deletion of its own now owns
          // these ids. Clearing them or deleting the row would orphan that pair.
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
          return { revived: false as const, tombstoned: true as const };
        }
        if (!archiveRemoved) {
          // Two messages are still up and the row's ids are the only handle on
          // them. Leaving the Clip DELETING lets the first clip or unclip past
          // `STALE_CONTROL_STATE_MS` retry the delete; deleting the row would
          // strand published content with nothing left to match it against.
          return { revived: false as const };
        }
        if ((await countClippers(tx, key.guildId, key.sourceMessageId)) === 0) {
          await deleteClipWithClippers(tx, key.guildId, key.sourceMessageId);
          return { revived: false as const };
        }
        if (
          archiveChannelId !== null &&
          (await readArchiveChannelId(tx, key.guildId)) !== archiveChannelId
        ) {
          // The guild was repointed while the delete was in flight. Reviving
          // would post into a channel it has left, where the publish is
          // declined and the pair taken down again, for as long as a clipper
          // remains. FAILED lets their next clip rebuild in the current channel.
          assertTransition(locked.status, 'FAILED');
          const { applied } = await markFailed(tx, key.guildId, key.sourceMessageId);
          if (applied) {
            logTransition(key, locked.status, 'FAILED');
          }
          return { revived: false as const };
        }
        return { revived: true as const, clip: locked };
      }, configurationOptions(configurationId));
      if (outcome === null || !outcome.revived) {
        if (outcome?.active) {
          return { kind: 'ACTIVE', archive: outcome.active };
        }
        return outcome?.tombstoned ? { kind: 'TOMBSTONED' } : { kind: 'UNSETTLED' };
      }

      // Both come from the same guild configuration, so they are null together.
      if (archiveChannelId === null || configurationId === null) {
        return { kind: 'UNSETTLED' };
      }

      // A preservation signal arrived while the delete was in flight, so the Clip
      // must converge back to an active archive (§9.8). The new archive is posted
      // before ACTIVE is written, never after.
      let recreated: ArchiveMessageIds;
      try {
        recreated = await gateway.createArchiveMessage({
          guildId: outcome.clip.guildId,
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
          ...archiveFailureFields(error),
        });
        // The old pair is gone and its ids cleared, but clippers remain:
        // FAILED lets their next clip rebuild at once instead of leaving a
        // DELETING row that only a lease takeover could pick up again.
        await recordArchiveFailure(key, configurationId);
        return { kind: 'UNSETTLED' };
      }

      const published = await publishArchive(key, recreated, archiveChannelId, configurationId);
      if (published.published) {
        return { kind: 'ACTIVE', archive: recreated };
      }

      // The publish was declined, so the pair just posted is unreferenced. The
      // unclip that withdrew the reviving signal saw DELETING and deferred to
      // this finalizer, so nothing else will take it down or reap the row.
      // Re-entering runs the same delete-and-re-decide the original pair went
      // through; `archive` is the new pair, never one already deleted, so the
      // loop cannot act on a stale `archiveRemoved`.
      //
      // Terminates: another pass needs the reviving clipper withdrawn *during*
      // the rebuild and a fresh clip before the next lock -- two member actions,
      // each behind a Discord round-trip. A removal instead leaves via
      // `isTerminalStatus`, and no replacement clipper leaves via
      // `deleteClipWithClippers`. A publish declined because the archive
      // channel moved ends the next pass: the lock body fails the Clip instead
      // of reviving once the configured channel differs from the captured one.
      archive = recreated;
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
        // A DELETING Clip whose finalizer is gone has no clippers left to
        // withdraw, so the member retrying their unclip lands here. Past the
        // lease this unclip finishes the deletion; the reply stays truthful,
        // since this caller holds no signal. Never for PENDING: an unclip
        // carries no signal that could justify creating an archive.
        if (locked.status === 'DELETING' && (await takeOverIfStale(tx, locked))) {
          return { kind: 'NOT_CLIPPED' as const, takenOver: true as const, archive: archiveOf(locked) };
        }
        return { kind: 'NOT_CLIPPED' as const, takenOver: false as const };
      }
      if (remaining > 0) {
        return { kind: 'KEPT' as const, remaining };
      }
      if (locked.status === 'DELETING') {
        // Deletion is already in flight: this Clip was revived inside the
        // window and has now lost that signal again. Its finalizer re-reads the
        // clipper count under the lock, so it converges without a second
        // finalizer duplicating the Discord delete. Past the lease that
        // finalizer is gone, and this unclip takes its place.
        if (await takeOverIfStale(tx, locked)) {
          return { kind: 'DELETING' as const, archive: archiveOf(locked) };
        }
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
    }, configurationOptions(config?.configurationId ?? null));

    if (outcome === null) {
      return { kind: 'NOT_FOUND' };
    }
    if (outcome.kind === 'NOT_CLIPPED') {
      if (outcome.takenOver) {
        await finalizeDeletion({
          key,
          archiveChannelId: config?.archiveChannelId ?? null,
          archive: outcome.archive,
          configurationId: config?.configurationId ?? null,
        });
      }
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
        configurationId: config?.configurationId ?? null,
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
        return { kind: 'REMOVED' as const, archive: archiveOf(locked), sourceChannelId: locked.sourceChannelId };
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
      return { kind: 'REMOVED' as const, archive: archiveOf(locked), sourceChannelId: locked.sourceChannelId };
    }, configurationOptions(config?.configurationId ?? null));

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
        await lockClip(
          key.guildId,
          key.sourceMessageId,
          (tx) => clearArchiveMessageIds(tx, key.guildId, key.sourceMessageId),
          configurationOptions(config.configurationId),
        );
      }
    }
    return { kind: 'REMOVED', sourceChannelId: outcome.sourceChannelId };
  }

  return { clip, unclip, removeByAuthorOrAdmin };
}
