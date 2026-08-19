import {
  ArchiveCreationFailedError,
  ArchiveTargetUnavailableError,
  type ArchiveMessageIds,
  type CreateArchiveInput,
  type DiscordArchiveGateway,
} from '@/lib/clip/types';
import {
  createDiscordRestClient,
  DiscordApiError,
  DISCORD_ERROR,
  type DiscordRestClient,
} from '@/lib/discord/rest-client';

/**
 * Discord forwards only these four message types; polls, calls, activities and
 * system messages cannot be forwarded (spec §6.3). An unforwardable target is
 * rejected before any state is written, rather than producing an empty entry.
 */
const FORWARDABLE_MESSAGE_TYPES: ReadonlySet<number> = new Set([
  0, // DEFAULT
  19, // REPLY
  20, // CHAT_INPUT_COMMAND
  23, // CONTEXT_MENU_COMMAND
]);

/** `message_reference.type` for a forward. Anything else is a reply. */
const REFERENCE_TYPE_FORWARD = 1;

/**
 * Discord error codes that mean "this target cannot be archived" rather than
 * "the attempt failed". The distinction drives which sentence the member sees:
 * an unavailable target is final and gets `이 메시지는 보관할 수 없습니다`,
 * while a failure invites a retry.
 */
const TARGET_UNAVAILABLE_CODES: ReadonlySet<number> = new Set([
  DISCORD_ERROR.UNKNOWN_MESSAGE,
  DISCORD_ERROR.UNKNOWN_CHANNEL,
  DISCORD_ERROR.MISSING_ACCESS,
  DISCORD_ERROR.MISSING_PERMISSIONS,
  DISCORD_ERROR.CANNOT_FORWARD_UNREADABLE,
]);

function isTargetUnavailable(error: DiscordApiError): boolean {
  if (error.code !== null) {
    return TARGET_UNAVAILABLE_CODES.has(error.code);
  }
  // Discord normally supplies a code. When it does not, 404 and 403 still say
  // plainly that the bot cannot address this message, which is the same outcome.
  return error.status === 404 || error.status === 403;
}

/** The fields of a source message this product is allowed to read. */
type SourceMessage = { type: number; timestamp: string };

function parseSourceMessage(body: unknown): SourceMessage | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { type, timestamp } = body as { type?: unknown; timestamp?: unknown };
  if (typeof type !== 'number' || typeof timestamp !== 'string') {
    return null;
  }
  // Only these two fields are lifted off the payload. The response also carries
  // `content`, `embeds` and `attachments`, and narrowing here is what keeps them
  // from travelling any further into the process (§12).
  return { type, timestamp };
}

function messageIdOf(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'id' in body) {
    const id = (body as { id: unknown }).id;
    if (typeof id === 'string') {
      return id;
    }
  }
  return null;
}

/**
 * The provenance line, built entirely from Discord's own markup.
 *
 * Every element is a machine value that Discord renders in the reader's locale:
 * a user mention, a channel mention, a timestamp, and the jump link. No prose,
 * which is deliberate — `docs/06_DESIGN_HANDOFF.md` specifies no Korean copy for
 * this message, and inventing some would break the handoff's string rule.
 *
 * The clip timestamp is not rendered because it is already there: this message's
 * own Discord timestamp *is* the moment the archive entry was created.
 */
function provenanceContent(input: CreateArchiveInput, originalTimestamp: string): string {
  const originalUnix = Math.floor(Date.parse(originalTimestamp) / 1000);
  const jumpLink = `https://discord.com/channels/${input.guildId}/${input.sourceChannelId}/${input.sourceMessageId}`;
  return (
    `<@${input.sourceAuthorUserId}> · <#${input.sourceChannelId}> · <t:${originalUnix}:f>\n` +
    jumpLink
  );
}

export type DiscordArchiveGatewayOptions = {
  botToken: string;
  fetchImpl: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export function createDiscordArchiveGateway(
  options: DiscordArchiveGatewayOptions
): DiscordArchiveGateway {
  const client: DiscordRestClient = createDiscordRestClient(options);

  /**
   * Removes a message we posted and can no longer use, without masking the
   * failure that made it garbage. A cleanup that throws would replace a precise
   * error ("this target cannot be archived") with an incidental one.
   */
  async function deleteQuietly(channelId: string, messageId: string): Promise<void> {
    try {
      await client.request('DELETE', `/channels/${channelId}/messages/${messageId}`);
    } catch {
      // Intentionally swallowed: the caller is already throwing.
    }
  }

  async function readSourceMessage(input: CreateArchiveInput): Promise<SourceMessage> {
    let body: unknown;
    try {
      body = await client.request(
        'GET',
        `/channels/${input.sourceChannelId}/messages/${input.sourceMessageId}`
      );
    } catch (error) {
      if (error instanceof DiscordApiError && isTargetUnavailable(error)) {
        throw new ArchiveTargetUnavailableError('source message cannot be read');
      }
      throw new ArchiveCreationFailedError('could not read the source message', {
        retryable: error instanceof DiscordApiError ? error.retryable : true,
        orphanedProvenanceMessageId: null,
      });
    }

    const source = parseSourceMessage(body);
    if (source === null) {
      throw new ArchiveCreationFailedError('source message was not in the expected shape', {
        retryable: false,
        orphanedProvenanceMessageId: null,
      });
    }
    return source;
  }

  return {
    async createArchiveMessage(input: CreateArchiveInput): Promise<ArchiveMessageIds> {
      const source = await readSourceMessage(input);

      if (!FORWARDABLE_MESSAGE_TYPES.has(source.type)) {
        throw new ArchiveTargetUnavailableError('source message type cannot be forwarded');
      }

      const archivePath = `/channels/${input.archiveChannelId}/messages`;

      let provenanceMessageId: string;
      try {
        const posted = await client.request('POST', archivePath, {
          content: provenanceContent(input, source.timestamp),
          // The provenance line names the author and the channel so a reader can
          // see them. It must not *notify* them: an archive entry is a record,
          // and pinging the author on every clip would make it an event.
          allowed_mentions: { parse: [] },
        });
        const id = messageIdOf(posted);
        if (id === null) {
          throw new DiscordApiError('provenance message returned no id', {
            status: 502,
            code: null,
          });
        }
        provenanceMessageId = id;
      } catch (error) {
        throw new ArchiveCreationFailedError('could not post the provenance message', {
          retryable: error instanceof DiscordApiError ? error.retryable : true,
          orphanedProvenanceMessageId: null,
        });
      }

      try {
        const posted = await client.request('POST', archivePath, {
          // No `content`, `embeds` or `components`: Discord rejects a forward
          // carrying any additional content with error 160011 (§6.3). This is
          // the whole reason an archive entry is two messages.
          message_reference: {
            type: REFERENCE_TYPE_FORWARD,
            message_id: input.sourceMessageId,
            channel_id: input.sourceChannelId,
            guild_id: input.guildId,
          },
        });
        const forwardMessageId = messageIdOf(posted);
        if (forwardMessageId === null) {
          throw new DiscordApiError('forward returned no id', { status: 502, code: null });
        }
        return { provenanceMessageId, forwardMessageId };
      } catch (error) {
        // An unavailable target is terminal, and the caller has no channel to
        // report an orphan through -- `ArchiveTargetUnavailableError` carries no
        // id -- so the provenance message is cleaned up here rather than leaked.
        if (error instanceof DiscordApiError && isTargetUnavailable(error)) {
          await deleteQuietly(input.archiveChannelId, provenanceMessageId);
          throw new ArchiveTargetUnavailableError('source message cannot be forwarded');
        }
        throw new ArchiveCreationFailedError('could not post the forward', {
          retryable: error instanceof DiscordApiError ? error.retryable : true,
          orphanedProvenanceMessageId: provenanceMessageId,
        });
      }
    },

    async deleteArchiveMessage(
      archiveChannelId: string,
      ids: ArchiveMessageIds
    ): Promise<void> {
      let failure: unknown = null;

      // Both are attempted even when the first fails. Stopping at the first
      // error would strand the other half of the pair in the archive channel
      // with the control plane about to forget its id.
      for (const messageId of [ids.provenanceMessageId, ids.forwardMessageId]) {
        try {
          await client.request('DELETE', `/channels/${archiveChannelId}/messages/${messageId}`);
        } catch (error) {
          // Already gone is the outcome this method wants.
          if (
            error instanceof DiscordApiError &&
            (error.code === DISCORD_ERROR.UNKNOWN_MESSAGE || error.status === 404)
          ) {
            continue;
          }
          failure ??= error;
        }
      }

      if (failure !== null) {
        throw failure;
      }
    },
  };
}
