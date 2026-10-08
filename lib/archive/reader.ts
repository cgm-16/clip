import { Prisma } from '@/generated/prisma/client';
import { getPrismaClient } from '@/lib/db';

export const ARCHIVE_PAGE_SIZE = 20;

export type ArchiveItem = {
  sourceMessageId: string;
  sourceChannelId: string;
  authorUserId: string;
  /** ISO 8601, UTC. */
  clippedAt: string;
};

export type ClipPage = {
  items: ArchiveItem[];
  total: number;
  range: { start: number; end: number } | null;
  newerCursor: string | null;
  olderCursor: string | null;
  channelIds: string[];
};

export type ClipPageQuery = {
  guildId: string;
  sourceChannelId?: string;
  before?: string;
  after?: string;
};

type Cursor = { clippedAt: string; sourceMessageId: string };

// Snowflakes are decimal and the test suites use hex: accept both, nothing else.
const ID = /^[0-9A-Za-z]{1,32}$/;
const CURSOR = /^(\d{1,15})\.([0-9A-Za-z]{1,32})$/;

/**
 * A cursor is the boundary row's `(clippedAt ms, sourceMessageId)` -- the
 * same pair the ordering uses. It is a value, not a row reference, so it
 * stays valid after its row is removed.
 */
export function encodeCursor(item: Pick<ArchiveItem, 'clippedAt' | 'sourceMessageId'>): string {
  return `${Date.parse(item.clippedAt)}.${item.sourceMessageId}`;
}

function decodeCursor(value: string): Cursor | null {
  const match = CURSOR.exec(value);
  if (!match) {
    return null;
  }
  const date = new Date(Number(match[1]));
  return Number.isNaN(date.getTime()) ? null : { clippedAt: date.toISOString(), sourceMessageId: match[2] };
}

type Row = {
  source_message_id: string;
  source_channel_id: string;
  author_user_id: string;
  created_at_iso: string;
};

function itemOf(row: Row): ArchiveItem {
  return {
    sourceMessageId: row.source_message_id,
    sourceChannelId: row.source_channel_id,
    authorUserId: row.author_user_id,
    clippedAt: row.created_at_iso,
  };
}

// `created_at` is `timestamp(3)` holding UTC. Comparisons cast the ISO string
// to `timestamp` (which ignores the zone suffix) and reads format it back as
// ISO, so no session time zone ever touches a cursor.
function newerThan(cursor: Cursor) {
  return Prisma.sql`(created_at, source_message_id) > (${cursor.clippedAt}::timestamp, ${cursor.sourceMessageId})`;
}
function olderThan(cursor: Cursor) {
  return Prisma.sql`(created_at, source_message_id) < (${cursor.clippedAt}::timestamp, ${cursor.sourceMessageId})`;
}

/**
 * One page of the guild's ACTIVE Clips, newest first (spec "Listing
 * contract"). Items, total, range and cursors come from one REPEATABLE READ
 * snapshot, so the counts always describe the rows shown. Only ACTIVE rows
 * are browseable; one whose Discord copy vanished is still ACTIVE and still
 * listed.
 */
export async function getClipPage(
  query: ClipPageQuery,
): Promise<{ kind: 'OK'; page: ClipPage } | { kind: 'INVALID' }> {
  if (query.before !== undefined && query.after !== undefined) {
    return { kind: 'INVALID' };
  }
  if (query.sourceChannelId !== undefined && !ID.test(query.sourceChannelId)) {
    return { kind: 'INVALID' };
  }
  const beforeCursor = query.before === undefined ? null : decodeCursor(query.before);
  const afterCursor = query.after === undefined ? null : decodeCursor(query.after);
  if ((query.before !== undefined && !beforeCursor) || (query.after !== undefined && !afterCursor)) {
    return { kind: 'INVALID' };
  }

  const scope = Prisma.sql`guild_id = ${query.guildId} AND status = 'ACTIVE'`;
  const filter =
    query.sourceChannelId === undefined
      ? Prisma.empty
      : Prisma.sql`AND source_channel_id = ${query.sourceChannelId}`;
  const columns = Prisma.sql`source_message_id, source_channel_id, author_user_id,
    to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso`;

  const page = await getPrismaClient().$transaction(
    async (tx) => {
      const [{ total }] = await tx.$queryRaw<Array<{ total: number }>>`
        SELECT count(*)::int AS total FROM clips WHERE ${scope} ${filter}`;

      let rows: Row[];
      if (afterCursor) {
        rows = await tx.$queryRaw<Row[]>`
          SELECT ${columns} FROM clips WHERE ${scope} ${filter} AND ${newerThan(afterCursor)}
          ORDER BY created_at ASC, source_message_id ASC LIMIT ${ARCHIVE_PAGE_SIZE}`;
        rows.reverse();
      } else {
        const boundary = beforeCursor ? Prisma.sql`AND ${olderThan(beforeCursor)}` : Prisma.empty;
        rows = await tx.$queryRaw<Row[]>`
          SELECT ${columns} FROM clips WHERE ${scope} ${filter} ${boundary}
          ORDER BY created_at DESC, source_message_id DESC LIMIT ${ARCHIVE_PAGE_SIZE}`;
      }
      const items = rows.map(itemOf);

      const channelRows = await tx.$queryRaw<Array<{ source_channel_id: string }>>`
        SELECT DISTINCT source_channel_id FROM clips WHERE ${scope} ORDER BY source_channel_id`;
      const channelIds = channelRows.map((row) => row.source_channel_id);

      if (items.length === 0) {
        return { items, total, range: null, newerCursor: null, olderCursor: null, channelIds };
      }
      const first = decodeCursor(encodeCursor(items[0]))!;
      const [{ newer }] = await tx.$queryRaw<Array<{ newer: number }>>`
        SELECT count(*)::int AS newer FROM clips WHERE ${scope} ${filter} AND ${newerThan(first)}`;
      const start = newer + 1;
      const end = newer + items.length;
      return {
        items,
        total,
        range: { start, end },
        newerCursor: start > 1 ? encodeCursor(items[0]) : null,
        olderCursor: end < total ? encodeCursor(items[items.length - 1]) : null,
        channelIds,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return { kind: 'OK', page };
}
