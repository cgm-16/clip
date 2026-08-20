import type { ReactNode } from 'react';
import { TextTag } from './TextTag';
import styles from './Callout.module.css';
import { WEB_COPY } from '@/lib/ui/copy';

export type CalloutVariant = 'note' | 'ok' | 'confirm' | 'error';

const TAG_TEXT: Record<CalloutVariant, string> = {
  note: WEB_COPY.tags.note,
  ok: WEB_COPY.tags.ok,
  confirm: WEB_COPY.tags.confirm,
  error: WEB_COPY.tags.error,
};

export interface CalloutProps {
  variant: CalloutVariant;
  /** The message body — the caller supplies it; this primitive never invents copy. */
  children: ReactNode;
  className?: string;
}

/**
 * A status callout: a leading text tag plus a message, never colour alone.
 * `error` has no screen using it yet in P0, but is built anyway so
 * `WEB_COPY.tags.error` has a home — a future caller supplies the message.
 */
export function Callout({ variant, children, className }: CalloutProps) {
  return (
    <div className={[styles.callout, styles[variant], className].filter(Boolean).join(' ')}>
      <TextTag className={styles.tag}>{TAG_TEXT[variant]}</TextTag>
      <p className={styles.copy}>{children}</p>
    </div>
  );
}
