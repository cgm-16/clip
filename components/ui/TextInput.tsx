import type { InputHTMLAttributes } from 'react';
import fieldStyles from './Field.module.css';
import styles from './TextInput.module.css';

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Visible label text — always supplied by the caller, never invented here. */
  label: string;
  id: string;
  /** When set, the input gets `aria-invalid` and the message renders below it. */
  errorMessage?: string;
  /** Machine values (channel/role/ID) render in the mono token per the handoff. */
  mono?: boolean;
}

export function TextInput({
  label,
  id,
  errorMessage,
  mono,
  className,
  ...props
}: TextInputProps) {
  const errorId = errorMessage ? `${id}-error` : undefined;
  return (
    <div className={fieldStyles.field}>
      <label htmlFor={id} className={fieldStyles.label}>
        {label}
      </label>
      <input
        id={id}
        className={[
          styles.input,
          mono ? styles.mono : '',
          errorMessage ? styles.inputError : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        aria-invalid={errorMessage ? true : undefined}
        aria-describedby={errorId}
        {...props}
      />
      {errorMessage && (
        <p id={errorId} className={fieldStyles.error}>
          {errorMessage}
        </p>
      )}
    </div>
  );
}
