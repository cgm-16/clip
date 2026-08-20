import styles from './TextTag.module.css';

export interface TextTagProps {
  /** The tag text itself — always one of `WEB_COPY.tags`, supplied by the caller. */
  children: string;
  /**
   * A CSS colour value, expected to be a `var(--token)` reference (e.g.
   * `var(--success-text)`). Omit to inherit the ambient colour from an
   * ancestor that already carries the right semantic colour (Callout does
   * this so its tag and body text share one colour, per the mockups).
   */
  color?: string;
  className?: string;
}

/**
 * The leading state tag (`NOTE` / `OK` / `확인` / `오류` / `누락` / `READY`, ...).
 * Every state announces itself through this text, never through colour alone.
 */
export function TextTag({ children, color, className }: TextTagProps) {
  return (
    <span
      className={[styles.tag, className].filter(Boolean).join(' ')}
      style={color ? { color } : undefined}
    >
      {children}
    </span>
  );
}
