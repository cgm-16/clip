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

test('every image has alt text and a source in docs/evidence/wave-6', () => {
  const images = Array.from(document.querySelectorAll('img'));
  expect(images.length).toBeGreaterThanOrEqual(3);
  for (const image of images) {
    expect(image.getAttribute('alt')?.trim()).toBeTruthy();
    const src = image.getAttribute('src')!;
    expect(src.startsWith('img/')).toBe(true);
    expect(existsSync(`docs/evidence/wave-6/${src.slice('img/'.length)}`)).toBe(true);
  }
});

test("the invite link is the README's", () => {
  const readme = readFileSync('README.md', 'utf8');
  const invite = /<(https:\/\/discord\.com\/oauth2\/authorize\?[^>]+)>/.exec(readme)![1];
  const links = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
  expect(links).toContain(invite);
  expect(links).toContain('https://github.com/cgm-16/clip');
  expect(links).toContain('https://github.com/cgm-16');
});

test('slide 1 names the author as cgm-16', () => {
  expect(document.querySelector('main > section')!.textContent).toContain('cgm-16');
});

test('slides 4 and 6 note the tester consented to appear in the screenshots', () => {
  const caption = 'Screenshots from a dedicated test server; the tester shown consented to appear.';
  for (const id of ['s4', 's6']) {
    expect(document.getElementById(id)!.closest('section')!.textContent).toContain(caption);
  }
});

test('slide 10 attributes its figures to the shas they were measured on', () => {
  const text = document.getElementById('s10')!.closest('section')!.textContent;
  expect(text).toContain('sha-b845a59');
  const testsTerm = Array.from(document.querySelectorAll('dl.facts dt')).find(
    (dt) => dt.textContent === 'Tests',
  )!;
  expect(testsTerm.nextElementSibling!.textContent).toContain('3ed1d60');
});
