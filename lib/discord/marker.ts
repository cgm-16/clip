/**
 * Bot-owned 📎 marker reaction on the source message (DAG node 3.2).
 *
 * Presence of the bot's own reaction means "an archive exists for this
 * message" -- nothing else. This module only ever touches the bot's own
 * reaction, via Discord's `@me` reaction endpoints, and exposes no way to
 * read anyone else's reactions: a member adding their own copy of the same
 * emoji carries no Clip meaning and must never be readable as a clipper
 * signal (spec). The returned surface is deliberately write-only.
 *
 * A failure here must never fail the clip -- the archive itself is what
 * makes a Clip valid, not the marker. Both operations therefore swallow
 * their own errors and log safely instead of throwing.
 */

import { createDiscordRestClient, DiscordApiError, type DiscordRestClient } from '@/lib/discord/rest-client';
import { logClipEvent } from '@/lib/logging/safe-log';

// U+1F4CE (📎), percent-encoded as UTF-8 bytes -- the form Discord's
// reaction endpoints require in the path.
const MARKER_EMOJI = '%F0%9F%93%8E';

export type CreateArchiveMarkerOptions = {
  botToken: string;
  fetchImpl: typeof fetch;
};

export type ArchiveMarker = {
  /** Adds the bot's marker to the source message. Never throws. */
  add(sourceChannelId: string, sourceMessageId: string): Promise<void>;
  /** Removes the bot's own marker. Never throws. */
  remove(sourceChannelId: string, sourceMessageId: string): Promise<void>;
};

export function createArchiveMarker(options: CreateArchiveMarkerOptions): ArchiveMarker {
  const client: DiscordRestClient = createDiscordRestClient(options);

  async function call(
    method: 'PUT' | 'DELETE',
    sourceChannelId: string,
    sourceMessageId: string,
    event: string
  ): Promise<void> {
    try {
      await client.request(
        method,
        `/channels/${sourceChannelId}/messages/${sourceMessageId}/reactions/${MARKER_EMOJI}/@me`
      );
    } catch (error) {
      // Non-fatal by design: the marker is a convenience indicator, not part
      // of the Clip's validity. Only identifiers and an error code are
      // logged -- never a response body, per the no-content-in-logs rule.
      logClipEvent({
        event,
        sourceMessageId,
        errorCode:
          error instanceof DiscordApiError
            ? String(error.code ?? error.status)
            : 'unknown',
      });
    }
  }

  return {
    add(sourceChannelId, sourceMessageId) {
      return call('PUT', sourceChannelId, sourceMessageId, 'archive_marker_add_failed');
    },
    remove(sourceChannelId, sourceMessageId) {
      return call('DELETE', sourceChannelId, sourceMessageId, 'archive_marker_remove_failed');
    },
  };
}
