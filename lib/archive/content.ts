import { findGuildArchiveConfig } from '@/lib/clip/repository';
import { getPrismaClient } from '@/lib/db';
import {
  describeDiscordFailure,
  DiscordApiError,
  DISCORD_ERROR,
  isUnknownTarget,
  type DiscordRestClient,
} from '@/lib/discord/rest-client';
import { logClipEvent } from '@/lib/logging/safe-log';

export type BodySegment = { kind: 'text'; text: string } | { kind: 'code'; text: string };
export type SafeAttachment = { filename: string; url: string; isImage: boolean };
export type SafeEmbed = { title: string | null; description: string | null; url: string | null };
export type OriginalStatus = 'available' | 'unavailable' | 'unknown';
type RowBase = {
  sourceMessageId: string;
  authorName: string | null;
  originalAt: string | null;
  original: OriginalStatus;
};
export type ArchiveRowContent =
  | (RowBase & {
      state: 'ready';
      body: BodySegment[];
      attachments: SafeAttachment[];
      embeds: SafeEmbed[];
      replyToAuthorName: string | null;
    })
  | (RowBase & { state: 'missing' })
  | (RowBase & { state: 'error'; reason: 'access' | 'transient' });

export const MAX_CONTENT_BATCH = 20;
export const CONTENT_FETCH_CONCURRENCY = 4;
const DISCORD_EPOCH_MS = 1420070400000n;
const SNOWFLAKE = /^\d{1,20}$/;

/** A Discord snowflake's creation instant, ISO 8601; null for a non-snowflake. */
export function snowflakeTime(id: string): string | null {
  if (!SNOWFLAKE.test(id)) {
    return null;
  }
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS)).toISOString();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Only `https:` URLs ever reach an `href` or `src`. */
function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** Splits Discord's ``` fences into text and code; an unclosed fence stays text. */
function splitCodeBlocks(content: string): BodySegment[] {
  const segments: BodySegment[] = [];
  const fence = /```(?:[^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  for (let match = fence.exec(content); match; match = fence.exec(content)) {
    if (match.index > cursor) {
      segments.push({ kind: 'text', text: content.slice(cursor, match.index) });
    }
    segments.push({ kind: 'code', text: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) {
    segments.push({ kind: 'text', text: content.slice(cursor) });
  }
  return segments;
}

type Snapshot = {
  body: BodySegment[];
  attachments: SafeAttachment[];
  embeds: SafeEmbed[];
  timestamp: string | null;
};

/** The forward's snapshot, or null when the payload is not one -- an invalid payload, not a missing copy. */
function parseSnapshot(body: unknown): Snapshot | null {
  const snapshots = record(body)?.message_snapshots;
  const message = Array.isArray(snapshots) ? record(record(snapshots[0])?.message) : null;
  if (!message) {
    return null;
  }
  const content = typeof message.content === 'string' ? message.content : '';
  const attachments: SafeAttachment[] = [];
  for (const item of Array.isArray(message.attachments) ? message.attachments : []) {
    const attachment = record(item);
    const url = safeHttpsUrl(attachment?.url);
    const filename = text(attachment?.filename);
    if (url && filename) {
      attachments.push({ filename, url, isImage: /^image\//.test(String(attachment?.content_type ?? '')) });
    }
  }
  const embeds: SafeEmbed[] = [];
  for (const item of Array.isArray(message.embeds) ? message.embeds : []) {
    const embed = record(item);
    const title = text(embed?.title);
    const description = text(embed?.description);
    if (title || description) {
      embeds.push({ title, description, url: safeHttpsUrl(embed?.url) });
    }
  }
  return {
    body: content ? splitCodeBlocks(content) : [],
    attachments,
    embeds,
    timestamp: text(message.timestamp),
  };
}

function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof DiscordApiError &&
    (error.code === DISCORD_ERROR.MISSING_ACCESS ||
      error.code === DISCORD_ERROR.MISSING_PERMISSIONS ||
      error.status === 403)
  );
}

/** One line per failed Discord read: which read, and its failure class -- never the error's message. */
function logReadFailure(
  guildId: string,
  sourceMessageId: string | undefined,
  step: 'forward_history_read' | 'forward_read',
  error: unknown,
): void {
  logClipEvent({
    event: 'archive.content_read_failed',
    guildId,
    sourceMessageId,
    step,
    ...describeDiscordFailure(error),
  });
}

/**
 * The wanted forwards found in one read of the archive channel's history, keyed
 * by forward id. Anything else the channel holds -- provenance lines, other
 * forwards, unrelated chatter -- is dropped here. A forward absent from the
 * result is not proof it is gone: Discord answers an empty list when the bot
 * lacks Read Message History, and one page holds at most 100 messages.
 * `rateLimited` is the history read's error when Discord still throttled it
 * after the client's retries: the archive channel is being throttled, and a
 * per-row read for every row would add to that load rather than relieve it.
 */
async function readForwardHistory(
  client: DiscordRestClient,
  guildId: string,
  archiveChannelId: string,
  forwardIds: readonly string[],
): Promise<{ found: Map<string, Snapshot | null>; rateLimited: DiscordApiError | null }> {
  const found = new Map<string, Snapshot | null>();
  const wanted = new Set(forwardIds.filter((id) => SNOWFLAKE.test(id)));
  if (wanted.size === 0) {
    return { found, rateLimited: null };
  }
  const lowest = [...wanted].map((id) => BigInt(id)).reduce((a, b) => (a < b ? a : b));
  let history: unknown;
  try {
    history = await client.request('GET', `/channels/${archiveChannelId}/messages?after=${lowest - 1n}&limit=100`);
  } catch (error) {
    logReadFailure(guildId, undefined, 'forward_history_read', error);
    return { found, rateLimited: error instanceof DiscordApiError && error.status === 429 ? error : null };
  }
  for (const message of Array.isArray(history) ? history : []) {
    const id = record(message)?.id;
    if (typeof id === 'string' && wanted.has(id)) {
      found.set(id, parseSnapshot(message));
    }
  }
  return { found, rateLimited: null };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Live content for the displayed page's rows (spec "Content contract").
 * Every id is resolved against this guild's ACTIVE rows before any Discord
 * call, and the Discord channel/message ids come from Postgres -- never from
 * the caller -- so this cannot be used as a general bot-authenticated proxy.
 * INVALID means a structurally bad batch (empty, over 20, duplicated) or an
 * unconfigured guild; an id that simply is not ACTIVE here is left out.
 * Nothing read here is stored or logged; a failed read logs only which read
 * failed and its failure class.
 *
 * Every forward lives in the one archive channel, so all rows share one
 * Discord rate-limit bucket. One history read of that channel, starting just
 * before the lowest wanted forward, serves every forward it lists. Each row
 * then costs at most one read, inside one of at most four concurrent slots:
 * the forward (content), only when the history did not list it. Only a
 * per-row forward read can prove a copy is missing. There is no read of the
 * source message, so `original` is always `unknown` and `replyToAuthorName`
 * always null: those reads share one source channel's rate-limit bucket
 * (spec amendment 2026-10-14, #95). A history read still rate-limited after
 * retries skips every per-row forward read: each unlisted row fails with
 * that error instead, logged once.
 */
export async function loadArchiveContent(input: {
  guildId: string;
  sourceMessageIds: readonly string[];
  client: DiscordRestClient;
  lookupUserName: (userId: string) => Promise<string | null>;
}): Promise<{ kind: 'OK'; items: ArchiveRowContent[] } | { kind: 'INVALID' }> {
  const ids = input.sourceMessageIds;
  if (ids.length === 0 || ids.length > MAX_CONTENT_BATCH || new Set(ids).size !== ids.length) {
    return { kind: 'INVALID' };
  }
  const [config, rows] = await Promise.all([
    findGuildArchiveConfig(input.guildId),
    getPrismaClient().clip.findMany({
      where: { guildId: input.guildId, status: 'ACTIVE', sourceMessageId: { in: [...ids] } },
      select: { sourceMessageId: true, authorUserId: true, archiveForwardMessageId: true },
    }),
  ]);
  if (config === null) {
    return { kind: 'INVALID' };
  }
  // An id that is not one of this guild's ACTIVE rows -- another guild's, or
  // one unclipped or removed since the page rendered -- gets no Discord call
  // and no item; the client shows it as unreadable while the rest still load.
  const byId = new Map(rows.map((row) => [row.sourceMessageId, row]));
  const activeIds = ids.filter((id) => byId.has(id));

  // Deduplicated only within this request; there is no cache (spec).
  const names = new Map<string, Promise<string | null>>();
  function authorName(userId: string): Promise<string | null> {
    let name = names.get(userId);
    if (!name) {
      name = input.lookupUserName(userId).catch(() => null);
      names.set(userId, name);
    }
    return name;
  }

  // `archiveForwardMessageId` is non-null on every ACTIVE row
  // (`clips_active_requires_archive`).
  const { found: listed, rateLimited } = await readForwardHistory(
    input.client,
    input.guildId,
    config.archiveChannelId,
    activeIds.map((id) => byId.get(id)!.archiveForwardMessageId!),
  );

  const items = await mapWithConcurrency(activeIds, CONTENT_FETCH_CONCURRENCY, async (sourceMessageId): Promise<ArchiveRowContent> => {
    const row = byId.get(sourceMessageId)!;
    const forwardId = row.archiveForwardMessageId!;
    let parsed: Snapshot | null = null;
    let forwardError: unknown = null;
    if (listed.has(forwardId)) {
      parsed = listed.get(forwardId) ?? null;
    } else if (rateLimited) {
      forwardError = rateLimited;
    } else {
      try {
        parsed = parseSnapshot(
          await input.client.request('GET', `/channels/${config.archiveChannelId}/messages/${forwardId}`),
        );
      } catch (error) {
        forwardError = error;
        logReadFailure(input.guildId, sourceMessageId, 'forward_read', error);
      }
    }

    const base: RowBase = {
      sourceMessageId,
      authorName: await authorName(row.authorUserId),
      originalAt: snowflakeTime(sourceMessageId),
      original: 'unknown',
    };
    if (forwardError !== null) {
      if (isUnknownTarget(forwardError)) {
        return { ...base, state: 'missing' };
      }
      return { ...base, state: 'error', reason: isAccessDenied(forwardError) ? 'access' : 'transient' };
    }
    if (!parsed) {
      return { ...base, state: 'error', reason: 'transient' };
    }
    return {
      ...base,
      originalAt: parsed.timestamp ?? base.originalAt,
      state: 'ready',
      body: parsed.body,
      attachments: parsed.attachments,
      embeds: parsed.embeds,
      replyToAuthorName: null,
    };
  });
  return { kind: 'OK', items };
}
