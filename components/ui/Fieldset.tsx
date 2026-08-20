import type { ReactNode } from 'react';
import styles from './Fieldset.module.css';

export interface FieldsetProps {
  /** Legend text — always supplied by the caller, never invented here. */
  legend: string;
  children: ReactNode;
  className?: string;
}

/**
 * A real `<fieldset>`/`<legend>` pair — the mockups draw group headings as
 * plain `<span>`s, but a group of related controls needs the semantics a
 * `<fieldset>` gives for free (exposed to assistive tech as a named group,
 * `role="group"`).
 */
export function Fieldset({ legend, children, className }: FieldsetProps) {
  return (
    <fieldset className={[styles.fieldset, className].filter(Boolean).join(' ')}>
      <legend className={styles.legend}>{legend}</legend>
      {children}
    </fieldset>
  );
}
