# Clip Pitch Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A portfolio deck of 11 slides for Clip, in English, as a single static HTML page. It uses Clip's own design tokens, is keyboard-navigable, and is published as a private Artifact. A Korean version follows as a separate phase.

**Architecture:** Four files under `docs/deck/`:
- `index.html` holds the slide markup.
- `deck.css` holds the styles. It uses `tokens.css` variables only.
- `deck.js` handles slide navigation: keys, buttons, the counter and focus.
- `tests/deck/deck.test.ts` is a Vitest suite running in jsdom.

The page has no build step. In the repo, `index.html` references its assets by their *published* names: `tokens.css`, `deck.css`, `deck.js` and `img/<file>.png`. The Artifact publish maps those names to their repo sources, so neither `tokens.css` nor the screenshots are duplicated.

**Tech Stack:** Static HTML, CSS and JS. Vitest with jsdom, which the repo already uses for UI tests. The repo's `scripts/lint-design.ts` checker. The Artifact tool.

**Spec:** `docs/superpowers/specs/2026-10-14-pitch-deck-design.md`. Issue #101.

## Global Constraints

- Audience: a portfolio deck for hiring, read alone from a link. Every slide stands on its own, and there are no speaker notes.
- Voice: first person. The author is named only as `cgm-16`, linked to `https://github.com/cgm-16`. No legal name appears.
- Language: English first, with content locked before any Korean. Every Korean line goes to Ori for review. Both languages end up in one file behind a toggle (Phase 2).
- Look: `tokens.css` variables only, with no hex colours outside `tokens.css`. Dark theme. Monospace is for machine values only. No shadows, gradients, blur, or animation beyond a 120ms hover colour transition. Radius is 2px and borders are 1px. Spacing is on the 4px scale.
- `--faint` is for disabled controls only. All readable text uses `--muted` or stronger.
- Navigation: ArrowLeft/ArrowRight, ArrowUp/ArrowDown, PageUp/PageDown, Home and End. Real `<button>` previous/next controls. A slide counter.
- Every `<img>` has non-empty alt text.
- Phone width: no horizontal page scroll, with a 16px side gutter.
- Every number carries its date and commit. Every claim traces to a source listed in the spec.
- The invite link is labelled as a home-server demo for test servers, with no uptime promise.
- Out of scope: investor or market slides, speaker notes, a live demo embed, edits to `docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md`, and README line 103.
- Branch: `wave/7-pitch-deck` in worktree `/Users/ori/repos/clip-deck`. Never commit to `main`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017EfC24XwGaC7G4VNB63nB8
  ```
- Local DB, only if a DB test runs: `export DATABASE_URL=postgresql://clip:clip@localhost:5433/clip_dev`. Never use `.env`. The local container keeps its data in tmpfs, so run `pnpm prisma migrate deploy` after it restarts.

## Review Focus

1. **A wide element on a phone.** The positioning table, the three screenshots or the diagram could force horizontal scroll at 375px. Expect each to reflow or scroll inside its own box. This is checked in the browser step of Task 4.
2. **Focus lost on navigation.** After the reader presses a key or a button, keyboard focus should land on the new slide's heading, not stay on a now-hidden element. The Task 1 test "moves focus to the shown slide's heading" covers this.
3. **A number that moved since the spec.** The test count, sha or e2e result may have changed. Each figure should be re-measured and re-dated. Task 2, Step 1 re-measures them, and the fact-check review in Task 3 confirms them.
4. **Unreadable text.** Watch for `--faint` used for text, or a hex colour that bypasses tokens. Run the repo's design checker on `deck.css`, and keep inline styles out of `index.html`. The Task 1 tests "deck.css passes the design checker" and "index.html has no inline styles" cover this.
5. **A broken link or asset.** Each `img/<file>` must exist in `docs/evidence/wave-6/`, and the invite link must match the README's. The Task 2 tests "every image has alt text and a source in docs/evidence/wave-6" and "the invite link is the README's" cover this.

---

### Task 1: Deck skeleton and navigation

**Files:**
- Create: `docs/deck/index.html`
- Create: `docs/deck/deck.css`
- Create: `docs/deck/deck.js`
- Test: `tests/deck/deck.test.ts`

**Interfaces:**
- Produces:
  - Slides are `main > section` elements, in order, each with exactly one `h1` (slide 1) or `h2` heading carrying `tabindex="-1"`.
  - Controls are `button#prev`, `button#next` and `#counter`, whose text is `"<n> / <total>"`.
  - `deck.js` is a plain script with no exports. It wires up `document` when it runs, so it must load at the end of `body`.
  - Asset names as published: `tokens.css`, `deck.css`, `deck.js`, `img/<file>.png`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/deck/deck.test.ts
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm exec vitest run tests/deck/deck.test.ts`
Expected: FAIL with `ENOENT: no such file or directory, open 'docs/deck/index.html'`

- [ ] **Step 3: Write the skeleton**

`docs/deck/index.html` gets 11 sections. Each section's heading is a placeholder title for now; Task 2 replaces every one of them with final content. Write all 11 `<section>`s, each with the heading text given here (the slide titles from the spec):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clip Pitch Deck</title>
  <!--
    Asset names are the Artifact's published paths, not repo paths:
      tokens.css -> /tokens.css
      deck.css, deck.js -> docs/deck/
      img/<file>.png -> docs/evidence/wave-6/<file>.png
  -->
  <link rel="stylesheet" href="tokens.css">
  <link rel="stylesheet" href="deck.css">
</head>
<body>
  <main>
    <section aria-labelledby="s1"><h1 id="s1" tabindex="-1">Clip</h1></section>
    <section aria-labelledby="s2"><h2 id="s2" tabindex="-1">Pins were never meant to be memory</h2></section>
    <section aria-labelledby="s3"><h2 id="s3" tabindex="-1">What Clip is, and is not</h2></section>
    <section aria-labelledby="s4"><h2 id="s4" tabindex="-1">How it works</h2></section>
    <section aria-labelledby="s5"><h2 id="s5" tabindex="-1">Discord keeps the content</h2></section>
    <section aria-labelledby="s6"><h2 id="s6" tabindex="-1">Setup and the web archive</h2></section>
    <section aria-labelledby="s7"><h2 id="s7" tabindex="-1">The hard parts</h2></section>
    <section aria-labelledby="s8"><h2 id="s8" tabindex="-1">A cut was a decision</h2></section>
    <section aria-labelledby="s9"><h2 id="s9" tabindex="-1">How I built it</h2></section>
    <section aria-labelledby="s10"><h2 id="s10" tabindex="-1">Proof it ships</h2></section>
    <section aria-labelledby="s11"><h2 id="s11" tabindex="-1">Try it</h2></section>
  </main>
  <nav class="controls" aria-label="Slides">
    <button type="button" id="prev">Previous</button>
    <span id="counter" aria-live="polite"></span>
    <button type="button" id="next">Next</button>
  </nav>
  <script src="deck.js"></script>
</body>
</html>
```

`docs/deck/deck.js`:

```js
// Slide navigation: one slide visible at a time, moved by keys or buttons,
// with focus on the shown slide's heading so a keyboard or screen-reader user
// lands on the new content.
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('main > section'));
  var counter = document.getElementById('counter');
  var prev = document.getElementById('prev');
  var next = document.getElementById('next');
  var current = 0;

  function show(index, moveFocus) {
    current = Math.max(0, Math.min(slides.length - 1, index));
    slides.forEach(function (slide, i) { slide.hidden = i !== current; });
    counter.textContent = current + 1 + ' / ' + slides.length;
    prev.disabled = current === 0;
    next.disabled = current === slides.length - 1;
    if (moveFocus) slides[current].querySelector('h1, h2').focus();
  }

  var KEYS = {
    ArrowRight: 1, ArrowDown: 1, PageDown: 1,
    ArrowLeft: -1, ArrowUp: -1, PageUp: -1,
  };
  document.addEventListener('keydown', function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Home') show(0, true);
    else if (event.key === 'End') show(slides.length - 1, true);
    else if (KEYS[event.key]) show(current + KEYS[event.key], true);
    else return;
    event.preventDefault();
  });
  prev.addEventListener('click', function () { show(current - 1, true); });
  next.addEventListener('click', function () { show(current + 1, true); });
  show(0, false);
})();
```

`docs/deck/deck.css` (tokens only; px values on the 4px scale or the checker's allowed exceptions):

```css
/* Clip pitch deck. Visual values come from tokens.css only. */
body {
  margin: 0;
  background: var(--surface);
  color: var(--text);
  font-family: var(--font-ui);
  line-height: 1.5;
}
main {
  box-sizing: border-box;
  max-width: 960px;
  margin: 0 auto;
  padding: 48px 16px 96px;
}
section h1,
section h2 {
  margin: 0 0 24px;
  color: var(--text);
  outline: none;
}
section p,
section li {
  color: var(--text-2);
  max-width: 68ch;
}
.muted { color: var(--muted); }
code { font-family: var(--font-mono); }
.controls {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  background: var(--raised);
  border-top: 1px solid var(--border);
}
.controls button {
  font: inherit;
  color: var(--text);
  background: var(--sunken);
  border: 1px solid var(--control-border);
  border-radius: 2px;
  padding: 8px 16px;
  cursor: pointer;
  transition: background-color 120ms;
}
.controls button:disabled {
  color: var(--faint);
  cursor: default;
}
.controls button:focus-visible,
section h1:focus-visible,
section h2:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
#counter { font-family: var(--font-mono); color: var(--muted); }
```

Every variable used here is defined in `tokens.css`; this was checked on 2026-10-14.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm exec vitest run tests/deck/deck.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add docs/deck tests/deck
git commit -m "feat(deck): slide skeleton with keyboard and button navigation

Refs #101

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017EfC24XwGaC7G4VNB63nB8"
```

---

### Task 2: English content for all eleven slides

**Files:**
- Modify: `docs/deck/index.html`, replacing the content of each `<section>`.
- Modify: `docs/deck/deck.css`, adding only the classes the content needs: `.positioning`, `.diagram`, `.shots`, `.facts`.
- Test: `tests/deck/deck.test.ts`, adding the content tests.

**Interfaces:**
- Consumes: Task 1's section structure. Every heading keeps its `id` and `tabindex="-1"`. `deck.js` is unchanged.
- Produces: final English copy. Phase 2 translates this text.

- [ ] **Step 1: Re-measure the figures**

Run each command and note its output. The copy below uses the values measured on 2026-10-14. If a value differs now, use the new one together with the new date and commit.

```bash
git -C /Users/ori/repos/clip-deck log -1 --format=%h origin/main          # expect 3ed1d60
export DATABASE_URL=postgresql://clip:clip@localhost:5433/clip_dev
pnpm prisma migrate deploy && pnpm test 2>&1 | grep -E "Test Files|Tests "  # expect 49 files, 718 tests
grep -n "8 of 8\|8/8" docs/journal/journal-2026-10.md | tail -2             # e2e 8/8 on sha-3ed1d60
```

The test count in the spec (706) came before #98, which added 12 tests. 718 is the current figure on `main` at `3ed1d60`, and CI on #98 recorded 718/718.

- [ ] **Step 2: Write the failing content tests (append to `tests/deck/deck.test.ts`)**

```ts
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

test('names the author only as cgm-16', () => {
  expect(document.querySelector('main > section')!.textContent).toContain('cgm-16');
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm exec vitest run tests/deck/deck.test.ts`
Expected: FAIL, because the skeleton has no images, links or author yet. The first failure is `expected 0 to be greater than or equal to 3`.

- [ ] **Step 4: Write the content**

Replace each section's contents with the copy below. Keep each heading's `id` and `tabindex="-1"`. Use `<code>` for machine values only: codes, shas, commands and ids. External links use `target="_blank" rel="noopener noreferrer"`.

**Slide 1 (`s1`):**
- `h1`: Clip
- `p.lead`: Deliberate community memory for Discord.
- `p.muted`: A Discord bot and admin web app, scoped, built, deployed and verified by <a href="https://github.com/cgm-16">cgm-16</a>. October 2026.

**Slide 2 (`s2`, "Pins were never meant to be memory"):**
- p: Discord pins are a short list, locked to one channel and managed by moderators. The current limit is 250 per channel.
- p: The starting point was concrete: a community had to delete old pins to make room for new ones.
- p: Pin count is the symptom. The gap is that a community has no low-friction way to say *"this is worth keeping for us."*

**Slide 3 (`s3`, "What Clip is, and is not"):** a `table.positioning` with two columns, Primitive and What it means:
- Discord pin: a moderator says this matters **in this channel**
- Personal bookmark: **I** want to see this later
- Starboard: **enough people** liked it
- Pin archiver: it **was already pinned**, and overflowed
- Bulk logger: keep **everything**, filter later
- **Clip**: **a member with permission says this is worth preserving for the community**

Then p: Clip is deliberate memory: one visible message, preserved on purpose, with no pin first, no popularity threshold and no transcript.

Wrap the table in `div.positioning` with `overflow-x: auto` so it scrolls inside its box on a phone.

**Slide 4 (`s4`, "How it works"):**
- ol:
  1. A member right-clicks a message and picks Apps → **Clip**.
  2. The archive channel gets two messages: a provenance line (author, source channel, time), then a forward of the message.
  3. The original gets a 📎 marker, and its author gets a DM with a remove button.
- p.muted: Why two messages: Discord rejects a forward that carries any content of its own (error <code>160011</code>), and a forward's snapshot omits its author. So provenance has to come from Clip's own records, posted alongside.
- img `img/p2-archive.png`, alt: "The #clip-archive channel showing a provenance line from Clip (author, channel, time) followed by the forwarded message."

**Slide 5 (`s5`, "Discord keeps the content"):**
- p: The central architecture decision is an ownership boundary.
- `div.diagram`: two side-by-side boxes. They stack vertically below 640px. Build them with HTML and CSS; do not use an image.
  - Left box, titled **Discord**: message bodies · embeds, attachments, media · rendered snapshots · user and channel display names
  - Right box, titled **PostgreSQL**: guild configuration and allowed roles · Clip identity and state machine · per-member preservation signals · removal tombstones · setup tokens and admin sessions
- p: Clip stores no message bodies, attachments, embed payloads, avatars, search index or embeddings. Deleting a server's Clip data erases only Clip's control state. The archive channel and every message in it stay in Discord.

**Slide 6 (`s6`, "Setup and the web archive"):**
- p: An admin runs <code>/setup</code> in Discord and gets a one-time link valid for 15 minutes. On the web, they choose the archive channel and the roles allowed to clip. Admins also get a read-only web archive of the server's clips.
- `div.shots` with two figures:
  - img `img/p6-form.png`, alt: "Clip's setup screen with the recommended option selected: create a new private archive channel." figcaption: Setup (Screen B)
  - img `img/burst-screen-d.png`, alt: "Clip's web archive listing clipped messages with author, source channel, time and a link to the original." figcaption: Web archive (Screen D)

**Slide 7 (`s7`, "The hard parts"):**
- ul:
  - **One canonical Clip per message, under concurrency.** Uniqueness is enforced by the database, and anything that depends on the clipper count takes a row lock. There is no check-then-insert. Tested against real PostgreSQL.
  - **Removal wins.** When the author or an admin removes a clip, that overrides every clipper and leaves a tombstone that blocks the message from being clipped again.
  - **Never half-archived.** A Clip never becomes active with a missing or partial archive.
  - **Platform facts checked before they were built on**, including <code>160011</code> (a forward cannot carry content), snapshots without <code>author</code>, and the four forwardable message types.

**Slide 8 (`s8`, "A cut was a decision"):**
- p: On 2026-08-20, 23 hours before the assignment deadline, I measured the remaining work against the project's own velocity (Wave 1 ≈ 6 h, Wave 2 ≈ 10 h). That wasn't going to fit, so I cut the web archive and kept the Discord path and minimal setup.
- p: I recorded the cut as a real reduction of approved scope, not as drift.
- p: Afterwards, I restored it with evidence. The web archive shipped on 2026-10-09 (PR #61). On 2026-10-14 the restoration's browser end-to-end gate passed 8/8 against production.

**Slide 9 (`s9`, "How I built it"):**
- p: Claude Code was the implementer. I held the product and architecture decisions. Every PR got an independent review, and every change started with a test I watched fail.
- p: The failures I recorded share one shape: **rigorous checking aimed one step to the side of the claim it was meant to support.** Each time, someone who hadn't written the work caught it.
- Two `article`s, each with a short heading and the parts What happened / Caught by / What changed:
  - **The forward that couldn't carry its own label.**
    - What happened: an AI-written plan put provenance and the forward into one archive post.
    - Caught by: a documentation check before any code. Discord returns <code>160011</code> for a forward with content, and snapshots have no author.
    - What changed: every archive entry is two messages, and provenance comes from Clip's own records.
  - **A reviewed fix that failed its first real run.**
    - What happened: <code>deploy.sh</code> pinned its rollout check to a revision number. Under the <code>Recreate</code> strategy, Kubernetes bumps that number only after the rollout starts, so the script read the old one and failed with <code>desired revision (12) is different from the running revision (13)</code>. The deploy itself was healthy.
    - Caught by: the script's own verification gate, on production.
    - What changed: the script now verifies by generation, and a regression test reproduces the exact error (PR #97).

**Slide 10 (`s10`, "Proof it ships"):** a `dl.facts` (term → detail), with each date in `span.muted`:
- Running: self-hosted on k3s behind Traefik, image <code>sha-3ed1d60</code> (2026-10-14)
- Tests: 718 tests in 49 files against real PostgreSQL, <code>main</code> (2026-10-14)
- End to end: Playwright 8/8 against production, <code>sha-3ed1d60</code> (2026-10-14)
- Permissions: measured one at a time on a fresh test server. The refusal codes <code>50001</code> and <code>160014</code> were confirmed from logs (2026-10-13, 2026-10-14)
- Footprint: idle at 3m CPU and 88 MiB (2026-10-14)
- Cost: USD 8 a year for the domain. The existing home cluster absorbs electricity, hardware and operator time, and those are real costs.

**Slide 11 (`s11`, "Try it"):**
- p: <a href="(the README invite link, exactly)">Add Clip to a test server</a>. It's a demo hosted on my home server: use a test server, and expect no uptime guarantee.
- p: Source code: <a href="https://github.com/cgm-16/clip">github.com/cgm-16/clip</a>. MIT licence.

Add to `deck.css` only these rules, all using tokens:

```css
.lead { font-size: 1.25rem; color: var(--text); }
.positioning { overflow-x: auto; }
.positioning table { border-collapse: collapse; }
.positioning th,
.positioning td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; vertical-align: top; }
.diagram { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.diagram > div { border: 1px solid var(--border); border-radius: 2px; padding: 16px; }
.shots { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.shots img,
section > img { max-width: 100%; height: auto; border: 1px solid var(--border); border-radius: 2px; }
figure { margin: 0; }
figcaption { color: var(--muted); }
.facts dt { color: var(--text); font-weight: 600; }
.facts dd { margin: 0 0 12px; color: var(--text-2); }
@media (max-width: 640px) {
  .diagram,
  .shots { grid-template-columns: 1fr; }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm exec vitest run tests/deck/deck.test.ts && pnpm lint`
Expected: PASS, 10 tests. `pnpm lint` is clean.

- [ ] **Step 6: Commit**

```bash
git add docs/deck tests/deck
git commit -m "feat(deck): English content for the eleven slides

Refs #101

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017EfC24XwGaC7G4VNB63nB8"
```

---

### Task 3: Independent fact-check and design review

This is a review gate. It is done by a fresh reviewer, not the implementer.

- [ ] **Step 1: Dispatch a read-only reviewer** with the spec, this plan, and `git diff origin/main..HEAD`. Ask it to check:
  - Every claim on every slide against its listed source: the README, `CLAUDE.md`, `docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md` (around line 567), the 2026-10-14 entries in `docs/journal/journal-2026-10.md`, `docs/evidence/wave-6/RESULTS.md`, and PRs #61 and #97.
  - Every number and its date.
  - The design rules: tokens only, `--faint` only on the disabled button, monospace only on machine values, no animation beyond the 120ms transition.
  - Whether anything overstates what was measured.

- [ ] **Step 2: Apply the findings.** Fix each Critical and Important finding with a test where one can apply, then commit. Record each Minor finding in the PR body.

---

### Task 4: Publish and verify in a browser

- [ ] **Step 1: Load the `artifact-design` skill**, then publish. The spec's look (Clip's dark tokens) is the deck's design. Where the skill's defaults differ, for example its light/dark redefinitions, the spec wins: record that as a ruling in the PR body.

Publish with `file_path: docs/deck/index.html`, `icon: "slides"`, and this `files` map:

```json
{
  "tokens.css": "tokens.css",
  "deck.css": "docs/deck/deck.css",
  "deck.js": "docs/deck/deck.js",
  "img/p2-archive.png": "docs/evidence/wave-6/p2-archive.png",
  "img/p6-form.png": "docs/evidence/wave-6/p6-form.png",
  "img/burst-screen-d.png": "docs/evidence/wave-6/burst-screen-d.png"
}
```

- [ ] **Step 2: Verify in the browser** at 1280×800 and at 375×812:
  - every slide renders, and every image loads;
  - there is no horizontal page scroll at 375px, and the positioning table scrolls inside its box;
  - keyboard only: Tab reaches Previous and Next, the arrows, PageUp/PageDown and Home/End all work, and focus lands on each slide's heading;
  - the disabled button is the only element that uses `--faint`.

  Record the viewports checked and anything that failed. Fix every failure, then re-run the tests.

- [ ] **Step 3: Open the PR.** Use the template, with `Refs #101`. #101 closes after the Korean phase. Give Ori the Artifact link.

---

### Phase 2 (after the English is locked and the PR is merged): Korean and the language toggle

These are separate tasks with their own PR. They are written out here so the shape is fixed, but they do not start until Ori has approved the English deck.

- **Task 5:** I draft Korean for every slide and send all of it to Ori in one message. Nothing is committed until Ori approves it line by line.
- **Task 6:** TDD a language toggle, `button#lang`.
  - Each slide holds `[lang="en"]` and `[lang="ko"]` blocks.
  - The toggle hides one set, sets `document.documentElement.lang`, and switches every `img`'s `alt` (stored as `data-alt-en` and `data-alt-ko`).
  - Tests: the toggle shows only the Korean blocks; `<html lang>` becomes `ko`; the alt text switches; navigation still counts 11 slides.
  - Then re-publish to the same Artifact URL, and close #101.
