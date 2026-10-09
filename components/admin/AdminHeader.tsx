import Link from 'next/link';
import { Wordmark } from '@/app/setup/[token]/Wordmark';
import { WEB_COPY } from '@/lib/ui/copy';
import styles from './AdminHeader.module.css';

export interface AdminHeaderProps {
  guildId: string;
  /** Guild name, or the id when Discord cannot supply it. */
  guildLabel: string;
  active: 'archive' | 'settings';
}

/**
 * Screens D/E header: wordmark, divider, guild name, and the only two
 * navigation targets (handoff "Navigation"). The `<nav>` is unlabelled: its
 * two links carry their names, and any label would be new Korean.
 */
export function AdminHeader({ guildId, guildLabel, active }: AdminHeaderProps) {
  const tabs = [
    { key: 'archive', href: `/admin/${guildId}/archive`, label: WEB_COPY.archive.archiveTab },
    { key: 'settings', href: `/admin/${guildId}/settings`, label: WEB_COPY.archive.settingsTab },
  ] as const;
  return (
    <header className={styles.bar}>
      <div className={styles.identity}>
        <Wordmark />
        <span className={styles.divider} aria-hidden="true" />
        <span className={styles.guild}>{guildLabel}</span>
      </div>
      <nav className={styles.tabs}>
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            className={styles.tab}
            aria-current={tab.key === active ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
