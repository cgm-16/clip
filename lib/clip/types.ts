import type { DiscordFailureFacts } from '@/lib/discord/rest-client';

/** Both Discord messages that make up one archive entry. See spec §6.3. */
export type ArchiveMessageIds = {
  provenanceMessageId: string;
  forwardMessageId: string;
};

export type ClipCommandResult =
  | { kind: 'CREATED'; archive: ArchiveMessageIds }
  | { kind: 'CLIPPER_ADDED'; archive: ArchiveMessageIds | null }
  | { kind: 'ALREADY_CLIPPED_BY_USER'; archive: ArchiveMessageIds | null }
  | { kind: 'NOT_AUTHORIZED' }
  | { kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' }
  | { kind: 'SOURCE_UNAVAILABLE' }
  | { kind: 'FAILED'; retryable: boolean };

export type UnclipResult =
  | { kind: 'UNCLIPPED'; remaining: number }
  | { kind: 'NOT_CLIPPED_BY_USER' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'FAILED'; retryable: boolean };

export type RemoveResult =
  | { kind: 'REMOVED' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'NOT_AUTHORIZED' }
  | { kind: 'FAILED'; retryable: boolean };

export type ClipInput = {
  guildId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  sourceAuthorUserId: string;
  clipperUserId: string;
  clipperRoleIds: readonly string[];
  clipperHasManageGuild: boolean;
};

export type UnclipInput = {
  guildId: string;
  sourceMessageId: string;
  clipperUserId: string;
};

export type RemoveInput = {
  guildId: string;
  sourceMessageId: string;
  invokerUserId: string;
  invokerHasManageGuild: boolean;
};

export type CreateArchiveInput = {
  guildId: string;
  archiveChannelId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  sourceAuthorUserId: string;
};

/**
 * The Discord side of the archive, as the domain needs it. Wave 2 exercises this
 * through a fake; `3.1` supplies the REST implementation.
 */
export interface DiscordArchiveGateway {
  /**
   * Posts the provenance message and the forward, in that order, and returns both
   * ids. An archive entry is two Discord messages because Discord rejects a forward
   * carrying additional content (error 160011, spec §6.3).
   *
   * Implementations MUST NOT return a partial archive. If the forward fails after the
   * provenance message posted, throw `ArchiveCreationFailedError` carrying the orphan's
   * id so the caller can clean it up (spec §17 case 19).
   */
  createArchiveMessage(input: CreateArchiveInput): Promise<ArchiveMessageIds>;

  /** Deletes both messages. Deleting an already-deleted message is not an error. */
  deleteArchiveMessage(archiveChannelId: string, ids: ArchiveMessageIds): Promise<void>;
}

/** The target message cannot be archived: deleted, invisible, or an unforwardable type. */
export class ArchiveTargetUnavailableError extends Error {}

/** The Discord call within archive creation that failed. */
export type ArchiveCreationStep = 'source_read' | 'provenance_post' | 'forward_post';

/**
 * The archive could not be created. `orphanedProvenanceMessageId` is set when the
 * provenance message posted but the forward did not, so the caller can delete it.
 * `step` and `failure` say which call failed and how, for the log line; `failure`
 * is null when the call succeeded but its response was not in the expected shape.
 */
export class ArchiveCreationFailedError extends Error {
  readonly retryable: boolean;
  readonly orphanedProvenanceMessageId: string | null;
  readonly step: ArchiveCreationStep;
  readonly failure: DiscordFailureFacts | null;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      orphanedProvenanceMessageId: string | null;
      step: ArchiveCreationStep;
      failure: DiscordFailureFacts | null;
    }
  ) {
    super(message);
    this.retryable = options.retryable;
    this.orphanedProvenanceMessageId = options.orphanedProvenanceMessageId;
    this.step = options.step;
    this.failure = options.failure;
  }
}
