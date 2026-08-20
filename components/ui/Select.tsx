import type { SelectHTMLAttributes } from 'react';
import fieldStyles from './Field.module.css';
import styles from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  /** Visible label text — always supplied by the caller, never invented here. */
  label: string;
  id: string;
  options: SelectOption[];
  errorMessage?: string;
  /** Machine values (channel/role) render in the mono token per the handoff. */
  mono?: boolean;
}

export function Select({ label, id, options, errorMessage, mono, className, ...props }: SelectProps) {
  const errorId = errorMessage ? `${id}-error` : undefined;
  return (
    <div className={fieldStyles.field}>
      <label htmlFor={id} className={fieldStyles.label}>
        {label}
      </label>
      <select
        id={id}
        className={[styles.select, mono ? styles.mono : '', className].filter(Boolean).join(' ')}
        aria-invalid={errorMessage ? true : undefined}
        aria-describedby={errorId}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {errorMessage && (
        <p id={errorId} className={fieldStyles.error}>
          {errorMessage}
        </p>
      )}
    </div>
  );
}
