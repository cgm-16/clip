import type { ArchiveRowContent } from '@/lib/archive/content';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { TextTag } from '@/components/ui/TextTag';
import { formatDate, formatTimestamp } from '@/lib/ui/format';
import { WEB_COPY, WEB_COPY_AUTHORED, WEB_COPY_TEMPLATES } from '@/lib/ui/copy';
import styles from './ClipCard.module.css';

export type ClipCardContent = ArchiveRowContent | { state: 'loading' };

export interface ClipCardProps {
  authorUserId: string;
  /** Channel name without `#`, or the id when the name is unknown. */
  sourceChannelLabel: string;
  clippedAt: string;
  /** https://discord.com/channels/{guild}/{channel}/{message} */
  originalUrl: string;
  content: ClipCardContent;
  onRetry?: () => void;
}

/**
 * One archive row (F.5; handoff "Clip card"). The hierarchy is fixed: source
 * line, reply, body, code, attachment, footer. Text renders as React text,
 * never markup, and URLs come from `lib/archive/content.ts`, which allows
 * only `https:`. No reaction, vote or rank counts anywhere.
 */
export function ClipCard({ authorUserId, sourceChannelLabel, clippedAt, originalUrl, content, onRetry }: ClipCardProps) {
  if (content.state === 'loading') {
    return (
      <article className={styles.card} aria-busy="true">
        <div className={styles.skeleton} aria-hidden="true">
          <span className={styles.barStrong} />
          <span className={styles.barWeak} />
        </div>
        <p className={styles.loading}>{WEB_COPY.archive.loadingFromDiscord}</p>
      </article>
    );
  }

  const { authorName } = content;
  const sourceLine = (
    <div className={styles.source}>
      <span className={styles.avatar} aria-hidden="true">
        {authorName ? Array.from(authorName)[0]!.toUpperCase() : ''}
      </span>
      {authorName ? (
        <span className={styles.author}>{authorName}</span>
      ) : (
        <span className={`${styles.author} ${styles.mono}`}>{authorUserId}</span>
      )}
      <span className={styles.channel}>{`#${sourceChannelLabel}`}</span>
      {content.originalAt && <span className={styles.time}>{formatTimestamp(content.originalAt)}</span>}
    </div>
  );
  const footer = (
    <div className={styles.footer}>
      <span className={styles.clipped}>{WEB_COPY_TEMPLATES.clippedOn.replace('{date}', formatDate(clippedAt))}</span>
      {content.original === 'unavailable' ? (
        <span className={styles.unavailable}>{WEB_COPY_AUTHORED.originalUnavailable}</span>
      ) : (
        <a className={styles.action} href={originalUrl} target="_blank" rel="noopener noreferrer">
          {WEB_COPY.clipCard.viewOriginal}
        </a>
      )}
    </div>
  );

  if (content.state === 'missing') {
    return (
      <article className={`${styles.card} ${styles.missing}`}>
        <div className={styles.missingHeading}>
          <TextTag>{WEB_COPY.tags.missing}</TextTag>
          <span className={styles.missingTitle}>{WEB_COPY.archive.missingCopyTitle}</span>
        </div>
        <p className={styles.body}>{WEB_COPY.archive.missingCopyExplanation}</p>
        {sourceLine}
        {footer}
      </article>
    );
  }

  if (content.state === 'error') {
    return (
      <article className={styles.card}>
        {sourceLine}
        <Callout variant="error">
          {content.reason === 'access' ? WEB_COPY_AUTHORED.archiveAccessDenied : WEB_COPY_AUTHORED.archiveFetchFailed}
        </Callout>
        <div>
          <Button variant="secondary" onClick={onRetry}>
            {WEB_COPY_AUTHORED.retry}
          </Button>
        </div>
        {footer}
      </article>
    );
  }

  return (
    <article className={styles.card}>
      {sourceLine}
      {content.replyToAuthorName && (
        <p className={styles.reply}>{`${WEB_COPY.clipCard.replyPrefix}@${content.replyToAuthorName}`}</p>
      )}
      {content.body.map((segment, index) =>
        segment.kind === 'code' ? (
          <pre key={index} className={styles.code}>
            <code>{segment.text}</code>
          </pre>
        ) : (
          <p key={index} className={styles.body}>
            {segment.text}
          </p>
        ),
      )}
      {content.embeds.map((embed, index) => (
        <div key={`embed-${index}`} className={styles.embed}>
          {embed.title &&
            (embed.url ? (
              <a href={embed.url} target="_blank" rel="noopener noreferrer">
                {embed.title}
              </a>
            ) : (
              <span>{embed.title}</span>
            ))}
          {embed.description && <p className={styles.body}>{embed.description}</p>}
        </div>
      ))}
      {content.attachments.map((attachment) =>
        attachment.isImage ? (
          <div key={attachment.url} className={styles.attachment}>
            {/* Plain <img>: the fresh Discord URL, no optimizer and no cache (ruling D6). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={attachment.url} alt={attachment.filename} loading="lazy" referrerPolicy="no-referrer" />
          </div>
        ) : (
          <a key={attachment.url} className={styles.file} href={attachment.url} target="_blank" rel="noopener noreferrer">
            {attachment.filename}
          </a>
        ),
      )}
      {footer}
    </article>
  );
}
