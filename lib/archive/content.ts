import { findGuildArchiveConfig } from '@/lib/clip/repository';
import { getPrismaClient } from '@/lib/db';
import { DiscordApiError, DISCORD_ERROR, type DiscordRestClient } from '@/lib/discord/rest-client';

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

/** Only Discord's own "unknown message/channel" codes confirm a copy is gone. */
function isUnknownTarget(error: unknown): boolean {
  return (
    error instanceof DiscordApiError &&
    (error.code === DISCORD_ERROR.UNKNOWN_MESSAGE || error.code === DISCORD_ERROR.UNKNOWN_CHANNEL)
  );
}

function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof DiscordApiError &&
    (error.code === DISCORD_ERROR.MISSING_ACCESS ||
      error.code === DISCORD_ERROR.MISSING_PERMISSIONS ||
      error.status === 403)
  );
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
 * Nothing read here is stored or logged.
 *
 * Each row costs two reads, run in sequence inside one of at most four
 * concurrent slots: the forward (content) and the source message (reply
 * author and whether the original still exists).
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
      select: { sourceMessageId: true, sourceChannelId: true, authorUserId: true, archiveForwardMessageId: true },
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

  const items = await mapWithConcurrency(activeIds, CONTENT_FETCH_CONCURRENCY, async (sourceMessageId): Promise<ArchiveRowContent> => {
    const row = byId.get(sourceMessageId)!;
    let forward: unknown = null;
    let forwardError: unknown = null;
    try {
      // `archiveForwardMessageId` is non-null on every ACTIVE row
      // (`clips_active_requires_archive`).
      forward = await input.client.request(
        'GET',
        `/channels/${config.archiveChannelId}/messages/${row.archiveForwardMessageId}`,
      );
    } catch (error) {
      forwardError = error;
    }

    let original: OriginalStatus = 'unknown';
    let replyToAuthorName: string | null = null;
    try {
      const source = record(
        await input.client.request('GET', `/channels/${row.sourceChannelId}/messages/${sourceMessageId}`),
      );
      original = 'available';
      // Only the parent's author is read; its body is never touched.
      if (record(source?.message_reference)?.message_id) {
        replyToAuthorName = text(record(record(source?.referenced_message)?.author)?.username);
      }
    } catch (error) {
      original = isUnknownTarget(error) ? 'unavailable' : 'unknown';
    }

    const base: RowBase = {
      sourceMessageId,
      authorName: await authorName(row.authorUserId),
      originalAt: snowflakeTime(sourceMessageId),
      original,
    };
    if (forwardError !== null) {
      if (isUnknownTarget(forwardError)) {
        return { ...base, state: 'missing' };
      }
      return { ...base, state: 'error', reason: isAccessDenied(forwardError) ? 'access' : 'transient' };
    }
    const parsed = parseSnapshot(forward);
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
      replyToAuthorName,
    };
  });
  return { kind: 'OK', items };
}
