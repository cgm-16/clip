/**
 * How a Discord interaction is answered: the two response envelopes
 * (immediate and deferred), the follow-up PATCH that completes a deferred
 * one, and the mapping from a `ClipService` result to the one line of copy
 * the member sees.
 *
 * Every response here is ephemeral -- only the invoking member sees it -- and
 * every mapping function below is written as an exhaustive `switch` with no
 * `default`, so a result variant added to `lib/clip/types.ts` without a
 * matching case here is a compile error, not a silent gap (product spec §10.1
 * requires every outcome to reach the member somehow).
 */

import type { ClipCommandResult, RemoveResult, UnclipResult } from '@/lib/clip/types';
import { DISCORD_COPY } from '@/lib/discord/copy';
import type { RemoveButtonInteractionResult } from '@/lib/discord/notifications';
import { createDiscordRestClient } from '@/lib/discord/rest-client';

// Discord interaction callback types this module builds.
// https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object-interaction-callback-type
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
// MessageFlags.EPHEMERAL: only the invoking member sees the message.
const EPHEMERAL_FLAG = 64;

/** An immediate, one-line ephemeral answer (interaction callback type 4). */
export function ephemeralReply(content: string): Response {
  return Response.json({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL_FLAG },
  });
}

/**
 * Tells Discord to wait: the real answer follows via `patchFollowupMessage`.
 *
 * Discord abandons an interaction left unanswered for 3 seconds. Creating an
 * archive is a source-message read, two posts, and (on the first archival) a
 * DM -- work that cannot reliably fit that window, so this is sent first and
 * the outcome is delivered by editing the placeholder afterward.
 */
export function deferredEphemeralReply(): Response {
  return Response.json({
    type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: EPHEMERAL_FLAG },
  });
}

export type FollowupMessageOptions = {
  botToken: string;
  fetchImpl: typeof fetch;
  applicationId: string;
  interactionToken: string;
};

/**
 * Completes a deferred interaction by editing its placeholder response.
 *
 * `PATCH /webhooks/{application_id}/{interaction_token}/messages/@original`
 * is the documented way to answer a deferred interaction; the ephemeral flag
 * set on the deferred reply carries over automatically, so it is not
 * repeated here. Throws on failure -- the caller decides what, if anything,
 * can still be done (there is no further response surface once this fails).
 */
export async function patchFollowupMessage(
  content: string,
  options: FollowupMessageOptions,
): Promise<void> {
  const client = createDiscordRestClient({ botToken: options.botToken, fetchImpl: options.fetchImpl });
  await client.request(
    'PATCH',
    `/webhooks/${options.applicationId}/${options.interactionToken}/messages/@original`,
    { content },
  );
}

/** Narrows the exhaustiveness check in each mapping function to a compile error. */
function unreachableResult(result: never): never {
  throw new Error(`unmapped result variant: ${JSON.stringify(result)}`);
}

/**
 * Every `ClipCommandResult` variant, mapped to exactly one line of copy.
 *
 * `CREATED` and `CLIPPER_ADDED` both read as `success`: either way, this
 * invocation is what put this member's preservation signal on an archived
 * message (spec §10.1's "successful normal actions"). `ALREADY_CLIPPED_BY_USER`
 * is the only "duplicate" case -- this exact member already did this.
 * `REMOVED_BY_AUTHOR_OR_ADMIN` and `SOURCE_UNAVAILABLE` both read as
 * `invalidTarget`: neither is something a retry fixes, and neither exposes
 * why (tombstone vocabulary never reaches the member).
 */
export function clipResultCopy(result: ClipCommandResult): string {
  switch (result.kind) {
    case 'CREATED':
    case 'CLIPPER_ADDED':
      return DISCORD_COPY.success;
    case 'ALREADY_CLIPPED_BY_USER':
      return DISCORD_COPY.duplicate;
    case 'NOT_AUTHORIZED':
      return DISCORD_COPY.noPermission;
    case 'REMOVED_BY_AUTHOR_OR_ADMIN':
    case 'SOURCE_UNAVAILABLE':
      return DISCORD_COPY.invalidTarget;
    case 'FAILED':
      return DISCORD_COPY.transientFailure;
    default:
      return unreachableResult(result);
  }
}

/**
 * Every `UnclipResult` variant, mapped to exactly one line of copy.
 *
 * `NOT_CLIPPED_BY_USER` (a Clip exists, but not from this member) and
 * `NOT_FOUND` (no Clip exists at all) read identically to the member: they
 * asked to withdraw a signal that was never there.
 */
export function unclipResultCopy(result: UnclipResult): string {
  switch (result.kind) {
    case 'UNCLIPPED':
      return DISCORD_COPY.unclipped;
    case 'NOT_CLIPPED_BY_USER':
    case 'NOT_FOUND':
      return DISCORD_COPY.nothingToUnclip;
    case 'FAILED':
      return DISCORD_COPY.transientFailure;
    default:
      return unreachableResult(result);
  }
}

/**
 * Every `RemoveResult` variant, mapped to exactly one line of copy.
 *
 * The handoff table has no row of its own for an author/admin removal, so
 * this reuses Unclip's copy: `REMOVED` reads as `unclipped` (the message is
 * no longer archived, which is the fact both actions share) and `NOT_FOUND`
 * reads as `nothingToUnclip`, the same reuse `/setup` already established for
 * `noPermission`.
 */
export function removeResultCopy(result: RemoveResult): string {
  switch (result.kind) {
    case 'REMOVED':
      return DISCORD_COPY.unclipped;
    case 'NOT_FOUND':
      return DISCORD_COPY.nothingToUnclip;
    case 'NOT_AUTHORIZED':
      return DISCORD_COPY.noPermission;
    case 'FAILED':
      return DISCORD_COPY.transientFailure;
    default:
      return unreachableResult(result);
  }
}

/**
 * Every `RemoveButtonInteractionResult` variant, mapped to exactly one line
 * of copy. The `RemoveResult` variants defer to `removeResultCopy` rather
 * than re-mapping them here -- the DM button and the `Remove from Clip
 * Archive` command answer the same fact ("is this message still archived")
 * and must never drift into two different sentences for it.
 *
 * `INVALID_CUSTOM_ID` has no row of its own in the handoff table. It reuses
 * `nothingToUnclip` rather than `transientFailure`: a `custom_id` this
 * module cannot parse names no Clip to act on, so "이 메시지를 보관한 기록이
 * 없습니다" is the truthful sentence, while `transientFailure`'s "다시 시도해
 * 주세요" would promise that retrying the same button might work, which it
 * never can for a malformed id.
 */
export function removeButtonResultCopy(result: RemoveButtonInteractionResult): string {
  if (result.kind === 'INVALID_CUSTOM_ID') {
    return DISCORD_COPY.nothingToUnclip;
  }
  return removeResultCopy(result);
}
