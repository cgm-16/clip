import { WEB_COPY, WEB_COPY_TEMPLATES } from '@/lib/ui/copy';
import styles from './ConfigTable.module.css';

export interface ConfigTableProps {
  /** Channel name without `#`, or the id when Discord has no such channel. */
  archiveChannelLabel: string;
  allowedRoles: { id: string; name: string }[];
  clipCount: number;
}

/**
 * The setup summary key/value table (handoff Screen C, reused by Screen E as
 * "the same key/value table"). Channel and role values are machine values,
 * so they render in mono.
 */
export function ConfigTable({ archiveChannelLabel, allowedRoles, clipCount }: ConfigTableProps) {
  const copy = WEB_COPY.setupComplete;
  return (
    <div className={styles.summary}>
      <div className={styles.row}>
        <span className={styles.key}>{copy.archiveChannelKey}</span>
        <span className={`${styles.value} ${styles.mono}`}>{`#${archiveChannelLabel}`}</span>
      </div>
      {allowedRoles.length > 0 && (
        <div className={styles.row}>
          <span className={styles.key}>{copy.allowedRolesKey}</span>
          <span className={`${styles.value} ${styles.mono}`}>
            {allowedRoles.map((role) => `@${role.name}`).join(' · ')}
          </span>
        </div>
      )}
      <div className={styles.row}>
        <span className={styles.key}>{copy.adminsKey}</span>
        <span className={styles.value}>{copy.adminsValue}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.key}>{copy.clipCountKey}</span>
        <span className={`${styles.value} ${styles.mono}`}>
          {WEB_COPY_TEMPLATES.clipCount.replace('{count}', String(clipCount))}
        </span>
      </div>
    </div>
  );
}
