'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import type { SetupRole } from '@/lib/discord/guild-lookup';
import { Fieldset } from './Fieldset';
import styles from './RoleMultiSelect.module.css';

export interface RoleMultiSelectProps {
  /** Legend text — supplied by the caller from the string table. */
  legend: string;
  /** The add control's text — supplied by the caller from the string table. */
  placeholder: string;
  roles: SetupRole[];
  /** Selected role ids. May include stale ids no longer in `roles`. */
  value: string[];
  onChange: (next: string[]) => void;
}

/**
 * The handoff's role multi-select ("Role multi-select") built on its
 * permitted fieldset/checkbox semantics: chips are pressed toggle buttons
 * named by the role (pressing removes it, so no extra label copy is needed),
 * the add control is a disclosure, and options are real checkboxes. Arrow
 * keys move between enabled options, Enter/Space toggle, Backspace on the add
 * control removes the last chip, Escape closes and returns focus.
 *
 * A selected id missing from `roles` (deleted in Discord) still renders, by
 * id, so it is never silently dropped from a save.
 */
export function RoleMultiSelect({ legend, placeholder, roles, value, onChange }: RoleMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  function nameOf(id: string): string {
    return roles.find((role) => role.id === id)?.name ?? id;
  }

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((selected) => selected !== id) : [...value, id]);
  }

  function enabledBoxes(): HTMLInputElement[] {
    return Array.from(listRef.current?.querySelectorAll<HTMLInputElement>('input:not(:disabled)') ?? []);
  }

  function handleAddKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Backspace' && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    } else if (event.key === 'ArrowDown' && open) {
      event.preventDefault();
      enabledBoxes()[0]?.focus();
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const boxes = enabledBoxes();
    const index = boxes.indexOf(document.activeElement as HTMLInputElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      boxes[(index + step + boxes.length) % boxes.length]?.focus();
    } else if (event.key === 'Enter' && index >= 0) {
      event.preventDefault();
      toggle(boxes[index].value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      toggleRef.current?.focus();
    }
  }

  return (
    <Fieldset legend={legend}>
      <div className={styles.field}>
        {value.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed="true"
            className={styles.chip}
            onClick={() => {
              toggle(id);
              // The chip unmounts once removed; keep keyboard users in the control.
              toggleRef.current?.focus();
            }}
          >
            {nameOf(id)}
            <span className={styles.remove} aria-hidden="true">
              ×
            </span>
          </button>
        ))}
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          className={styles.add}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={handleAddKeyDown}
        >
          {placeholder}
        </button>
      </div>
      {open && (
        <ul ref={listRef} className={styles.options} onKeyDown={handleListKeyDown}>
          {roles.map((role) => (
            <li key={role.id} className={styles.option}>
              <label className={styles.optionLabel}>
                <input
                  type="checkbox"
                  value={role.id}
                  checked={value.includes(role.id)}
                  disabled={!role.selectable}
                  onChange={() => toggle(role.id)}
                />
                {role.name}
              </label>
            </li>
          ))}
        </ul>
      )}
    </Fieldset>
  );
}
