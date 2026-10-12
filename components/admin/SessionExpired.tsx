'use client';

import { useEffect, useRef } from 'react';
import { Wordmark } from '@/app/setup/[token]/Wordmark';
import styles from '@/app/setup/[token]/SetupStatusCard.module.css';
import { Callout } from '@/components/ui/Callout';
import { MonoChip } from '@/components/ui/MonoChip';
import { WEB_COPY, WEB_COPY_AUTHORED } from '@/lib/ui/copy';

const RECOVERY_COMMAND = '/setup';

/**
 * The admin pages' recovery screen for a missing, expired, revoked or
 * other-guild session. Screen A's layout and its `/setup` recovery copy;
 * only the title differs, since the one-time setup token is not what
 * expired here.
 */
export function SessionExpired() {
  const copy = WEB_COPY.expiredSetupLink;
  const [beforeCommand, afterCommand] = copy.recovery.split(RECOVERY_COMMAND);
  // A 401 swaps this in for the screen whose control held focus (the deletion
  // flow, the settings edit, the archive); focusing the title keeps focus off
  // `body` and announces it, as Screen C does after a save.
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <Wordmark />
        <div className={styles.body}>
          <h1 ref={title} tabIndex={-1} className={styles.title}>
            {WEB_COPY_AUTHORED.adminSessionExpiredTitle}
          </h1>
        </div>
        <Callout variant="note">
          {beforeCommand}
          <MonoChip>{RECOVERY_COMMAND}</MonoChip>
          {afterCommand}
        </Callout>
        <p className={styles.footnote}>{copy.archiveStillWorks}</p>
      </div>
    </div>
  );
}
