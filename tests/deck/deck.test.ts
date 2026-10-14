// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, expect, test } from 'vitest';
import { findDesignViolations } from '../../scripts/lint-design';

const html = readFileSync('docs/deck/index.html', 'utf8');
const script = readFileSync('docs/deck/deck.js', 'utf8');

function slides(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('main > section'));
}
function visibleIndex(): number {
  return slides().findIndex((slide) => !slide.hidden);
}
function press(key: string) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

beforeEach(() => {
  document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML;
  new Function(script)();
});

test('has eleven slides, each with one heading', () => {
  expect(slides()).toHaveLength(11);
  for (const slide of slides()) {
    expect(slide.querySelectorAll('h1, h2')).toHaveLength(1);
  }
});

test('shows only the first slide and counts it', () => {
  expect(slides().filter((slide) => !slide.hidden)).toHaveLength(1);
  expect(visibleIndex()).toBe(0);
  expect(document.getElementById('counter')!.textContent).toBe('1 / 11');
  expect((document.getElementById('prev') as HTMLButtonElement).disabled).toBe(true);
});

test('arrow, page and home/end keys move between slides and stop at the ends', () => {
  press('ArrowRight');
  expect(visibleIndex()).toBe(1);
  press('PageDown');
  expect(visibleIndex()).toBe(2);
  press('ArrowUp');
  expect(visibleIndex()).toBe(1);
  press('End');
  expect(visibleIndex()).toBe(10);
  press('ArrowDown');
  expect(visibleIndex()).toBe(10);
  expect((document.getElementById('next') as HTMLButtonElement).disabled).toBe(true);
  press('Home');
  expect(visibleIndex()).toBe(0);
  press('ArrowLeft');
  expect(visibleIndex()).toBe(0);
  press('PageUp');
  expect(visibleIndex()).toBe(0);
});

test('the buttons move between slides', () => {
  (document.getElementById('next') as HTMLButtonElement).click();
  expect(visibleIndex()).toBe(1);
  expect(document.getElementById('counter')!.textContent).toBe('2 / 11');
  (document.getElementById('prev') as HTMLButtonElement).click();
  expect(visibleIndex()).toBe(0);
});

test("moves focus to the shown slide's heading", () => {
  press('ArrowRight');
  expect(document.activeElement).toBe(slides()[1].querySelector('h2'));
});

test('deck.css passes the design checker', () => {
  const css = readFileSync('docs/deck/deck.css', 'utf8');
  expect(findDesignViolations('docs/deck/deck.css', css)).toEqual([]);
});

test('index.html has no inline styles and loads only the published asset names', () => {
  expect(html).not.toMatch(/\sstyle=/);
  const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    expect(['tokens.css', 'deck.css', 'deck.js'].includes(ref) || ref.startsWith('img/')).toBe(true);
  }
  expect(existsSync('tokens.css')).toBe(true);
});
