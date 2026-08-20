import styles from './Wordmark.module.css';

/**
 * The "Clip" lockup shared by Screen A's card and Screen B's identity bar.
 * Decorative only — the square mark carries no meaning of its own, so it is
 * hidden from assistive tech.
 */
export function Wordmark() {
  return (
    <span className={styles.wordmark}>
      <span className={styles.mark} aria-hidden="true" />
      <span className={styles.name}>Clip</span>
    </span>
  );
}
