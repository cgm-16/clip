// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { RoleMultiSelect } from '@/components/ui/RoleMultiSelect';

// See tests/ui/primitives.test.tsx: no `test.globals`, so cleanup is manual.
afterEach(cleanup);

const ROLES = [
  { id: 'g', name: '@everyone', selectable: false },
  { id: 'm', name: 'moderator', selectable: true },
  { id: 'a', name: '기록관리', selectable: true },
];

function renderSelect(value: string[] = []) {
  const onChange = vi.fn();
  render(
    <RoleMultiSelect legend="클립 허용 역할" placeholder="역할 추가…" roles={ROLES} value={value} onChange={onChange} />,
  );
  return { onChange, user: userEvent.setup() };
}

test('is a named group', () => {
  renderSelect();
  expect(screen.getByRole('group', { name: '클립 허용 역할' })).toBeInTheDocument();
});

test('opens with Enter, moves with arrows, toggles with Space, closes with Escape', async () => {
  const { onChange, user } = renderSelect();
  screen.getByRole('button', { name: '역할 추가…' }).focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('checkbox', { name: '@everyone' })).toBeDisabled();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('checkbox', { name: 'moderator' })).toHaveFocus();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('checkbox', { name: '기록관리' })).toHaveFocus();
  await user.keyboard('{ArrowUp}');
  expect(screen.getByRole('checkbox', { name: 'moderator' })).toHaveFocus();
  await user.keyboard(' ');
  expect(onChange).toHaveBeenLastCalledWith(['m']);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('checkbox', { name: 'moderator' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '역할 추가…' })).toHaveFocus();
});

test('Enter on an option toggles it', async () => {
  const { onChange, user } = renderSelect(['m']);
  await user.click(screen.getByRole('button', { name: '역할 추가…' }));
  screen.getByRole('checkbox', { name: 'moderator' }).focus();
  await user.keyboard('{Enter}');
  expect(onChange).toHaveBeenLastCalledWith([]);
});

test('the disclosure reports whether the list is open', async () => {
  const { user } = renderSelect();
  const add = screen.getByRole('button', { name: '역할 추가…' });
  expect(add).toHaveAttribute('aria-expanded', 'false');
  await user.click(add);
  expect(add).toHaveAttribute('aria-expanded', 'true');
});

test('Backspace on the add button removes the last chip', async () => {
  const { onChange, user } = renderSelect(['m', 'a']);
  screen.getByRole('button', { name: '역할 추가…' }).focus();
  await user.keyboard('{Backspace}');
  expect(onChange).toHaveBeenLastCalledWith(['m']);
});

test('a chip is a pressed toggle that removes its role', async () => {
  const { onChange, user } = renderSelect(['m']);
  await user.click(screen.getByRole('button', { name: 'moderator', pressed: true }));
  expect(onChange).toHaveBeenLastCalledWith([]);
});

test('a stale selected id stays visible by id', () => {
  renderSelect(['999']);
  expect(screen.getByRole('button', { name: '999', pressed: true })).toBeInTheDocument();
});

test('removing a chip from the keyboard keeps focus in the control', async () => {
  const { user } = renderSelect(['m', 'a']);
  screen.getByRole('button', { name: 'moderator', pressed: true }).focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: '역할 추가…' })).toHaveFocus();
});
