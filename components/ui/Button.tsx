import type { ButtonHTMLAttributes } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

/**
 * A real `<button>` — never a styled `<span>`, unlike the mockups' shortcut.
 * `type="button"` by default so it never submits an ancestor form by
 * accident; pass `type="submit"` explicitly where that is wanted.
 *
 * One primary per screen is a design rule enforced by convention, not by
 * this component: nothing here stops a caller from rendering two.
 */
export function Button({ variant = 'secondary', className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={[styles.button, styles[variant], className].filter(Boolean).join(' ')}
      {...props}
    />
  );
}
