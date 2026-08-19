/**
 * The first-clip author DM (product spec §11.1) and the removal it offers.
 *
 * `ClipService` never sends this DM itself and is never given a way to --
 * the interaction handler calls this module after a successful first
 * archival instead, so the concurrency-sensitive core stays exactly the
 * merged, reviewed code it already is.
 */

import { createClipService } from '@/lib/clip/service';
import { claimAuthorNotification, markAuthorNotificationDelivered } from '@/lib/clip/repository';
import type { DiscordArchiveGateway, RemoveResult } from '@/lib/clip/types';
import { DISCORD_COPY } from '@/lib/discord/copy';
import { createDiscordRestClient, DiscordApiError } from '@/lib/discord/rest-client';
import { logClipEvent } from '@/lib/logging/safe-log';

// Discord's message component style constants this module needs.
// https://discord.com/developers/docs/interactions/message-components#button-object-button-styles
const BUTTON_STYLE_DANGER = 4;
const BUTTON_STYLE_LINK = 5;
const ACTION_ROW = 1;
const BUTTON = 2;

// Stable prefix the future interaction router matches `custom_id` against,
// named as a constant so it is retyped nowhere (mirrors `SETUP_COMMAND_NAME`
// in `lib/discord/commands.ts`).
export const REMOVE_FROM_ARCHIVE_CUSTOM_ID_PREFIX = 'clip_remove_from_dm';

/**
 * Encodes the guild and source message a DM's remove button acts on.
 *
 * Discord caps `custom_id` at 100 characters; a prefix plus two snowflakes
 * (each at most 20 digits) comes nowhere close, which the round-trip test
 * asserts rather than assumes.
 */
export function buildRemoveFromArchiveCustomId(guildId: string, sourceMessageId: string): string {
  return `${REMOVE_FROM_ARCHIVE_CUSTOM_ID_PREFIX}:${guildId}:${sourceMessageId}`;
}

/**
 * The inverse of `buildRemoveFromArchiveCustomId`.
 *
 * A `custom_id` arrives from the client on every click, forged or not, so
 * anything that does not match this module's own encoding is refused with
 * `null` rather than thrown -- a malformed id is a routing question, never a
 * crash.
 */
export function parseRemoveFromArchiveCustomId(
  customId: string,
): { guildId: string; sourceMessageId: string } | null {
  const parts = customId.split(':');
  if (parts.length !== 3 || parts[0] !== REMOVE_FROM_ARCHIVE_CUSTOM_ID_PREFIX) {
    return null;
  }
  const [, guildId, sourceMessageId] = parts;
  if (guildId === '' || sourceMessageId === '') {
    return null;
  }
  return { guildId, sourceMessageId };
}

function jumpLink(guildId: string, sourceChannelId: string, sourceMessageId: string): string {
  return `https://discord.com/channels/${guildId}/${sourceChannelId}/${sourceMessageId}`;
}

function firstArchivalDmContent(guildName: string, channelName: string): string {
  return DISCORD_COPY.firstArchivalDm.replace('{guild}', guildName).replace('{channel}', channelName);
}

function firstArchivalDmComponents(guildId: string, sourceChannelId: string, sourceMessageId: string) {
  return [
    {
      type: ACTION_ROW,
      components: [
        {
          type: BUTTON,
          style: BUTTON_STYLE_LINK,
          label: DISCORD_COPY.firstArchivalDmViewOriginal,
          url: jumpLink(guildId, sourceChannelId, sourceMessageId),
        },
        {
          type: BUTTON,
          style: BUTTON_STYLE_DANGER,
          label: DISCORD_COPY.firstArchivalDmRemoveFromArchive,
          custom_id: buildRemoveFromArchiveCustomId(guildId, sourceMessageId),
        },
      ],
    },
  ];
}

function idOf(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'id' in body) {
    const id = (body as { id: unknown }).id;
    if (typeof id === 'string') {
      return id;
    }
  }
  return null;
}

export type NotifyAuthorOfFirstArchivalInput = {
  guildId: string;
  sourceMessageId: string;
  guildName: string;
  channelName: string;
};

export type NotifyAuthorOfFirstArchivalOptions = {
  botToken: string;
  fetchImpl: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type NotifyAuthorOfFirstArchivalResult =
  | { kind: 'DELIVERED' }
  | { kind: 'UNDELIVERABLE' }
  // Nothing to claim: either this Clip was already notified (a retry, or a
  // later clipper joining the same canonical Clip -- see `claimClip` in
  // `lib/clip/repository.ts`) or the Clip does not exist.
  | { kind: 'SKIPPED' };

/**
 * Sends the one-time first-clip DM, or reports why it did not.
 *
 * `claimAuthorNotification` is the entire idempotency guard: a conditional
 * database write, checked before this function goes anywhere near Discord,
 * so a retried call or a process restart after a crash never produces a
 * second DM (spec §11.1's "record notification status so retries/restarts
 * do not spam the author"). No caller of this function needs to track
 * whether it already ran.
 *
 * A failure opening the DM channel and a failure posting into it are both
 * `UNDELIVERABLE`. Discord returns `50007` (cannot send to this user)
 * typically on the message post rather than the channel open, but P0 has no
 * retry worker for either failure -- only the interaction that triggered
 * this call ever attempts it -- so both collapse to the same outcome rather
 * than the caller needing to distinguish which leg failed.
 */
export async function notifyAuthorOfFirstArchival(
  input: NotifyAuthorOfFirstArchivalInput,
  options: NotifyAuthorOfFirstArchivalOptions,
): Promise<NotifyAuthorOfFirstArchivalResult> {
  const claim = await claimAuthorNotification(input.guildId, input.sourceMessageId);
  if (claim === null) {
    return { kind: 'SKIPPED' };
  }

  const client = createDiscordRestClient(options);
  try {
    // The recipient is the author id this claim just read off the Clip row,
    // never anything the caller supplied -- the same class of check §11.3
    // requires for removal, applied here to where the DM is addressed.
    const channel = await client.request('POST', '/users/@me/channels', {
      recipient_id: claim.authorUserId,
    });
    const channelId = idOf(channel);
    if (channelId === null) {
      throw new DiscordApiError('DM channel open returned no id', { status: 502, code: null });
    }

    await client.request('POST', `/channels/${channelId}/messages`, {
      content: firstArchivalDmContent(input.guildName, input.channelName),
      components: firstArchivalDmComponents(input.guildId, claim.sourceChannelId, input.sourceMessageId),
      // `guildName` and `channelName` are Discord-supplied display names, not
      // markup this module composes -- a name containing `@everyone` or a
      // literal `<@id>` must not be allowed to ping anyone when it is
      // substituted into the DM's content.
      allowed_mentions: { parse: [] },
    });
  } catch (error) {
    logClipEvent({
      event: 'clip.author_notification_undeliverable',
      guildId: input.guildId,
      sourceMessageId: input.sourceMessageId,
      errorCode: error instanceof DiscordApiError ? String(error.code ?? error.status) : 'UNKNOWN',
    });
    return { kind: 'UNDELIVERABLE' };
  }

  await markAuthorNotificationDelivered(input.guildId, input.sourceMessageId);
  logClipEvent({
    event: 'clip.author_notified',
    guildId: input.guildId,
    sourceMessageId: input.sourceMessageId,
  });
  return { kind: 'DELIVERED' };
}

export type RemoveButtonInteractionInput = {
  customId: string;
  interactingUserId: string;
};

export type RemoveButtonInteractionOptions = {
  gateway: DiscordArchiveGateway;
};

export type RemoveButtonInteractionResult = RemoveResult | { kind: 'INVALID_CUSTOM_ID' };

/**
 * Handles a click on the DM's `아카이브에서 제거` button.
 *
 * The `custom_id` travels in the client and is not evidence of anything --
 * it names which Clip to remove, not who may remove it. Authorization is
 * `removeByAuthorOrAdmin`'s own `invokerUserId === locked.authorUserId`
 * check (spec §11.3, already merged and tested against `ClipService`), which
 * this handler defers to rather than re-implementing. `invokerHasManageGuild`
 * is always false here: a DM has no guild permission context, and a guild
 * manager acting on someone else's clip has the admin web UI and the
 * `Remove from Clip Archive` context menu command for that, not this button.
 */
export async function handleRemoveButtonInteraction(
  input: RemoveButtonInteractionInput,
  options: RemoveButtonInteractionOptions,
): Promise<RemoveButtonInteractionResult> {
  const parsed = parseRemoveFromArchiveCustomId(input.customId);
  if (parsed === null) {
    return { kind: 'INVALID_CUSTOM_ID' };
  }

  const service = createClipService(options.gateway);
  return service.removeByAuthorOrAdmin({
    guildId: parsed.guildId,
    sourceMessageId: parsed.sourceMessageId,
    invokerUserId: input.interactingUserId,
    invokerHasManageGuild: false,
  });
}
