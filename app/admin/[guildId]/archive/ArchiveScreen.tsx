'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ClipCard, type ClipCardContent } from '@/components/archive/ClipCard';
import { AdminHeader } from '@/components/admin/AdminHeader';
import { SessionExpired } from '@/components/admin/SessionExpired';
import { archiveHref } from '@/lib/admin/archive-href';
import type { ArchiveRowContent } from '@/lib/archive/content';
import type { ArchiveItem } from '@/lib/archive/reader';
import { WEB_COPY, WEB_COPY_AUTHORED, WEB_COPY_TEMPLATES } from '@/lib/ui/copy';
import styles from './ArchiveScreen.module.css';

export type ArchiveScreenProps = {
  guildId: string;
  guildLabel: string;
  items: ArchiveItem[];
  total: number;
  range: { start: number; end: number } | null;
  newerHref: string | null;
  olderHref: string | null;
  channelOptions: { id: string; label: string }[];
  selectedChannel: string | null;
};

type FetchResult = { kind: 'ok'; items: ArchiveRowContent[] } | { kind: 'expired' } | { kind: 'failed' };

async function fetchContent(guildId: string, ids: string[], signal: AbortSignal): Promise<FetchResult> {
  try {
    const response = await fetch(`/api/admin/guilds/${guildId}/archive/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceMessageIds: ids }),
      signal,
    });
    if (response.status === 401) {
      return { kind: 'expired' };
    }
    if (!response.ok) {
      return { kind: 'failed' };
    }
    const body = (await response.json()) as { items?: unknown };
    return Array.isArray(body.items) ? { kind: 'ok', items: body.items as ArchiveRowContent[] } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

/** A row the read could not settle: retryable, never a stuck skeleton. */
function transientError(sourceMessageId: string): ArchiveRowContent {
  return { sourceMessageId, state: 'error', reason: 'transient', authorName: null, originalAt: null, original: 'unknown' };
}

/**
 * Screen D. The shell and metadata are server-rendered; row bodies are then
 * fetched from Discord for this page's ids only (handoff "Archive list").
 * The page remounts on every URL change (`key` in page.tsx) and unmounting
 * aborts the in-flight read, so a stale page's content can never overwrite
 * a newer one.
 */
export function ArchiveScreen(props: ArchiveScreenProps) {
  const { guildId, items } = props;
  const router = useRouter();
  const [contents, setContents] = useState<Record<string, ClipCardContent>>(() =>
    Object.fromEntries(items.map((item) => [item.sourceMessageId, { state: 'loading' } as const])),
  );
  const [expired, setExpired] = useState(false);

  // Applies a settled read to its rows. Called only from promise callbacks.
  const applyResult = useCallback((ids: string[], result: FetchResult) => {
    if (result.kind === 'expired') {
      setExpired(true);
      return;
    }
    setContents((previous) => {
      const next = { ...previous };
      for (const id of ids) {
        const found = result.kind === 'ok' ? result.items.find((item) => item.sourceMessageId === id) : undefined;
        next[id] = found ?? transientError(id);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (items.length === 0) {
      return;
    }
    const controller = new AbortController();
    const ids = items.map((item) => item.sourceMessageId);
    fetchContent(guildId, ids, controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        applyResult(ids, result);
      }
    });
    return () => controller.abort();
  }, [guildId, items, applyResult]);

  function retry(sourceMessageId: string) {
    setContents((previous) => ({ ...previous, [sourceMessageId]: { state: 'loading' } }));
    void fetchContent(guildId, [sourceMessageId], new AbortController().signal).then((result) =>
      applyResult([sourceMessageId], result),
    );
  }

  if (expired) {
    return <SessionExpired />;
  }

  const busy = Object.values(contents).some((content) => content.state === 'loading');
  const channelLabel = (id: string) => props.channelOptions.find((option) => option.id === id)?.label ?? id;

  return (
    <div className={styles.page}>
      <AdminHeader guildId={guildId} guildLabel={props.guildLabel} active="archive" />
      <section className={styles.panel}>
        <div className={styles.filterBar}>
          <label className={styles.filterLabel} htmlFor="archive-channel">
            {WEB_COPY.archive.channelFilterLabel}
          </label>
          <select
            id="archive-channel"
            className={styles.select}
            value={props.selectedChannel ?? ''}
            onChange={(event) =>
              router.push(archiveHref(guildId, event.target.value ? { channel: event.target.value } : {}))
            }
          >
            <option value="">{WEB_COPY.archive.channelFilterAll}</option>
            {props.channelOptions.map((option) => (
              <option key={option.id} value={option.id}>{`#${option.label}`}</option>
            ))}
          </select>
          <span className={styles.count}>{WEB_COPY_TEMPLATES.clipCount.replace('{count}', String(props.total))}</span>
          <span className={styles.sort}>{WEB_COPY.archive.sortNewestFirst}</span>
        </div>

        <div className={styles.list} aria-live="polite" aria-busy={busy}>
          {items.length === 0 ? (
            <p className={styles.empty}>
              {props.selectedChannel ? WEB_COPY_AUTHORED.archiveFilterEmpty : WEB_COPY_AUTHORED.archiveEmpty}
            </p>
          ) : (
            items.map((item) => (
              <ClipCard
                key={item.sourceMessageId}
                authorUserId={item.authorUserId}
                sourceChannelLabel={channelLabel(item.sourceChannelId)}
                clippedAt={item.clippedAt}
                originalUrl={`https://discord.com/channels/${guildId}/${item.sourceChannelId}/${item.sourceMessageId}`}
                content={contents[item.sourceMessageId] ?? { state: 'loading' }}
                onRetry={() => retry(item.sourceMessageId)}
              />
            ))
          )}
        </div>

        {props.range && (
          <div className={styles.pager}>
            <span className={styles.range}>
              {WEB_COPY_TEMPLATES.pageRange
                .replace('{start}', String(props.range.start))
                .replace('{end}', String(props.range.end))
                .replace('{total}', String(props.total))}
            </span>
            <PagerLink href={props.newerHref} label={WEB_COPY.archive.previousPage} />
            <PagerLink href={props.olderHref} label={WEB_COPY.archive.nextPage} />
          </div>
        )}
      </section>
    </div>
  );
}

function PagerLink({ href, label }: { href: string | null; label: string }) {
  return href ? (
    <Link className={styles.pagerButton} href={href}>
      {label}
    </Link>
  ) : (
    <span className={styles.pagerButton} aria-disabled="true">
      {label}
    </span>
  );
}
