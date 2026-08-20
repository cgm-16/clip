import type { ReactNode } from 'react';
import styles from './MonoChip.module.css';

export interface MonoChipProps {
  children: ReactNode;
  className?: string;
}

/**
 * A bordered mono chip for a machine value shown inline in a sentence — the
 * setup-complete usage step's `Clip` token. Display-only: the mockup shows
 * no remove affordance here (unlike the role multi-select's chips), so none
 * is built.
 */
export function MonoChip({ children, className }: MonoChipProps) {
  return <span className={[styles.chip, className].filter(Boolean).join(' ')}>{children}</span>;
}
