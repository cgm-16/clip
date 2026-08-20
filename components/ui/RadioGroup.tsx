import styles from './RadioGroup.module.css';
import { Fieldset } from './Fieldset';

export interface RadioOption {
  value: string;
  label: string;
  description?: string;
}

export interface RadioGroupProps {
  /** Legend text — always supplied by the caller, never invented here. */
  legend: string;
  name: string;
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/**
 * Real `<input type="radio">` controls sharing one `name`, each wrapped in
 * its own `<label>` — the mockup draws a ring-and-dot `<span>`; here the
 * native control drives it via `:checked`, so arrow-key roving focus,
 * Space-to-select and screen-reader announcement all come from the browser
 * for free rather than being reimplemented.
 */
export function RadioGroup({ legend, name, options, value, onChange, className }: RadioGroupProps) {
  return (
    <Fieldset legend={legend} className={className}>
      <div className={styles.options}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <label key={option.value} className={selected ? styles.optionSelected : styles.option}>
              <input
                type="radio"
                className={styles.radio}
                name={name}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
              />
              <span className={styles.optionBody}>
                <span className={styles.optionLabel}>{option.label}</span>
                {option.description && (
                  <span className={styles.optionDescription}>{option.description}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </Fieldset>
  );
}
