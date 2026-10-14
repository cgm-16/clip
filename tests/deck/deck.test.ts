// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { findDesignViolations } from '../../scripts/lint-design';

const html = readFileSync('docs/deck/index.html', 'utf8');
const script = readFileSync('docs/deck/deck.js', 'utf8');

function slides(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('main > section'));
}
function visibleIndex(): number {
  return slides().findIndex((slide) => !slide.hidden);
}
function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
}

// deck.js registers a document-level keydown listener on every run; drop them
// so earlier runs do not respond to later tests' key presses.
const keydownListeners: EventListener[] = [];
afterEach(() => {
  for (const listener of keydownListeners.splice(0)) document.removeEventListener('keydown', listener);
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.mocked(window.scrollTo).mockClear();
  document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML;
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type: string, listener: any, options?: any) => {
    if (type === 'keydown') keydownListeners.push(listener);
    add(type, listener, options);
  });
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

test('left/right/home/end move between slides and stop at the ends', () => {
  press('ArrowRight');
  expect(visibleIndex()).toBe(1);
  press('ArrowRight');
  expect(visibleIndex()).toBe(2);
  press('ArrowLeft');
  expect(visibleIndex()).toBe(1);
  press('End');
  expect(visibleIndex()).toBe(10);
  press('ArrowRight');
  expect(visibleIndex()).toBe(10);
  expect((document.getElementById('next') as HTMLButtonElement).disabled).toBe(true);
  press('Home');
  expect(visibleIndex()).toBe(0);
  press('ArrowLeft');
  expect(visibleIndex()).toBe(0);
});

test('up/down/page keys are left to native scrolling', () => {
  press('ArrowRight');
  for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp']) {
    const event = press(key);
    expect(visibleIndex()).toBe(1);
    expect(event.defaultPrevented).toBe(false);
  }
});

test('changing slides scrolls the page back to the top', () => {
  press('ArrowRight');
  expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
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

test('index.html is page content only, with the title near the top', () => {
  expect(html).not.toMatch(/<!doctype|<html|<head|<body/i);
  expect(html.slice(0, 8192)).toContain('<title>Clip Pitch Deck</title>');
});

test('deck.js sets the document language', () => {
  expect(document.documentElement.lang).toBe('en');
});

test('every font url in deck.css names a published path whose source exists', () => {
  const css = readFileSync('docs/deck/deck.css', 'utf8');
  const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(url.startsWith('fonts/')).toBe(true);
    expect(existsSync(`app/fonts/${url.slice('fonts/'.length)}`)).toBe(true);
  }
});

test('deck.css styles links with the accent token', () => {
  const css = readFileSync('docs/deck/deck.css', 'utf8');
  expect(css).toMatch(/(^|\n)a \{[^}]*color:\s*var\(--accent-text\)/);
});

test('pressing a key or button at either end does not scroll or move focus', () => {
  const focused = document.activeElement;
  const prevEvent = press('ArrowLeft');
  (document.getElementById('prev') as HTMLButtonElement).click();
  expect(window.scrollTo).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(focused);
  expect(prevEvent.defaultPrevented).toBe(true);
  press('End');
  vi.mocked(window.scrollTo).mockClear();
  press('ArrowRight');
  (document.getElementById('next') as HTMLButtonElement).click();
  expect(window.scrollTo).not.toHaveBeenCalled();
});

test('left/right inside the positioning table stay native', () => {
  const table = document.querySelector('.positioning')!;
  expect(table.getAttribute('tabindex')).toBe('0');
  expect(table.getAttribute('role')).toBe('region');
  expect(table.getAttribute('aria-label')).toBe('Positioning table');
  const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  table.querySelector('table')!.dispatchEvent(event);
  expect(visibleIndex()).toBe(0);
  expect(event.defaultPrevented).toBe(false);
});

// A language element counts as shown when nothing between it and its slide is hidden.
function isShownInSlide(element: Element): boolean {
  for (let node: Element | null = element; node && node.tagName !== 'SECTION'; node = node.parentElement) {
    if ((node as HTMLElement).hidden) return false;
  }
  return true;
}
function shownIn(code: string): Element[] {
  return Array.from(document.querySelectorAll(`main [lang="${code}"]`)).filter(isShownInSlide);
}
function toggle(): HTMLButtonElement {
  return document.getElementById('lang') as HTMLButtonElement;
}

test('the language toggle shows only Korean, and again only English', () => {
  expect(shownIn('ko')).toHaveLength(0);
  expect(shownIn('en').length).toBeGreaterThan(0);
  toggle().click();
  expect(shownIn('en')).toHaveLength(0);
  expect(shownIn('ko').length).toBeGreaterThan(0);
  toggle().click();
  expect(shownIn('ko')).toHaveLength(0);
  expect(shownIn('en').length).toBeGreaterThan(0);
});

test('the toggle button names the other language and the controls switch with it', () => {
  const shown = () =>
    Array.from(document.querySelectorAll('.controls [lang]'))
      .filter((el) => !(el as HTMLElement).hidden)
      .map((el) => el.textContent);
  expect(shown()).toEqual(['Previous', 'Next', '한국어']);
  toggle().click();
  expect(shown()).toEqual(['이전', '다음', 'English']);
});

test('the document language follows the toggle', () => {
  toggle().click();
  expect(document.documentElement.lang).toBe('ko');
  toggle().click();
  expect(document.documentElement.lang).toBe('en');
});

test('image alt text switches with the language', () => {
  const images = Array.from(document.querySelectorAll<HTMLImageElement>('img'));
  toggle().click();
  for (const image of images) expect(image.alt).toBe(image.dataset.altKo);
  toggle().click();
  for (const image of images) expect(image.alt).toBe(image.dataset.altEn);
});

test('the nav and positioning table labels switch with the language', () => {
  const nav = document.querySelector('nav.controls')!;
  const tables = Array.from(document.querySelectorAll('.positioning'));
  expect(tables).toHaveLength(2);
  toggle().click();
  expect(nav.getAttribute('aria-label')).toBe('슬라이드');
  for (const table of tables) expect(table.getAttribute('aria-label')).toBe('포지셔닝 표');
  toggle().click();
  expect(nav.getAttribute('aria-label')).toBe('Slides');
  for (const table of tables) expect(table.getAttribute('aria-label')).toBe('Positioning table');
});

test('toggling the language keeps the current slide and arrow keys still work from the button', () => {
  press('ArrowRight');
  press('ArrowRight');
  expect(visibleIndex()).toBe(2);
  toggle().click();
  expect(slides()).toHaveLength(11);
  expect(visibleIndex()).toBe(2);
  expect(document.getElementById('counter')!.textContent).toBe('3 / 11');
  toggle().focus();
  toggle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  expect(visibleIndex()).toBe(3);
});

test('every slide carries both languages in its heading and body', () => {
  slides().forEach((slide, index) => {
    const heading = slide.querySelector('h1, h2')!;
    if (index > 0) {
      expect(heading.querySelector('[lang="en"]')).not.toBeNull();
      expect(heading.querySelector('[lang="ko"]')).not.toBeNull();
    }
    const body = Array.from(slide.querySelectorAll<HTMLElement>('[lang]')).filter((el) => !heading.contains(el));
    expect(body.some((el) => el.lang === 'en')).toBe(true);
    expect(body.some((el) => el.lang === 'ko')).toBe(true);
  });
});

test('every image has both alt texts', () => {
  for (const image of Array.from(document.querySelectorAll<HTMLImageElement>('img'))) {
    expect(image.dataset.altEn?.trim()).toBeTruthy();
    expect(image.dataset.altKo?.trim()).toBeTruthy();
  }
});

test('the source markup hides Korean content, and the toggle button shows Korean as its label', () => {
  const source = new DOMParser().parseFromString(html, 'text/html');
  const korean = Array.from(source.querySelectorAll('[lang="ko"]')).filter((el) => !el.closest('#lang'));
  expect(korean.length).toBeGreaterThan(0);
  for (const element of korean) expect(element.hasAttribute('hidden')).toBe(true);
  expect(source.querySelector('#lang [lang="en"]')!.hasAttribute('hidden')).toBe(true);
  expect(source.querySelector('#lang [lang="ko"]')!.hasAttribute('hidden')).toBe(false);
});

test('deck.js contains no Hangul', () => {
  expect(script).not.toMatch(/[가-힯]/);
});

test('the slide 2 Korean heading is the approved copy', () => {
  expect(document.querySelector('#s2 [lang="ko"]')!.textContent).toBe('핀은 영원한 기억을 위해 만든 것이 아닙니다');
});
