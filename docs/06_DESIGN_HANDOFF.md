# Handoff: Clip — P0 web UI (design system + screens A–E)

## Overview

Clip is a Discord app that lets authorized community members preserve a message into a server-owned archive with roughly the effort of pinning. Discord stays authoritative for archived content; Clip's own database holds only control-plane state (IDs, roles, decisions, tombstones).

This bundle covers the **P0 web UI**: an admin setup flow, a read-only archive list, a config/data-deletion page, and the copy for Discord-side interaction responses. Product semantics are already settled — see `docs/01_CLIP_PRODUCT_SPEC.md`. Do not reopen them.

**Locale: the P0 UI is Korean only.** All copy in this document is final Korean copy. i18n is P1 — but do not hardcode strings in a way that blocks it; use a string table from the start.

## About the design files

`design/*.dc.html` are **design references written in HTML**. They are prototypes that show intended look, structure, hierarchy and states — they are not production code and should not be copied into the app. Open them in a browser to see the design; then **recreate the UI in the target codebase** using its own framework and conventions.

No app codebase existed at design time. If one now exists, follow its established patterns. If not, React + TypeScript + Vite with plain CSS (or CSS Modules) using `tokens.css` is the lowest-friction path — this design has no component-library dependency and deliberately avoids shadows, gradients and animation, so a headless approach works well. If you use shadcn/ui, normalize its defaults to the tokens below rather than shipping them unmodified (radius 2px, no shadows, hairline borders).

Files:
- `design/Clip Design System.dc.html` — tokens, type scale, spacing, buttons, inputs, feedback, card anatomy, blank states, light theme
- `design/Clip P0 Screens.dc.html` — screens A–E + Discord response copy
- `design/Clip Design Directions.dc.html` — rejected explorations, kept for provenance only. Do not implement.
- `design/support.js` — runtime needed for the HTML files to render. Not part of the app.
- `tokens.css` — the design tokens, ready to drop in
- `docs/` — the full product package plus `DESIGN_RATIONALE_APPEND.md` (Korean; append to `04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md`)

## Fidelity

**High-fidelity.** Colors, type, spacing and states are final. Recreate faithfully. Where the HTML uses a `<span>` to depict a button or input, that is a mockup shortcut — build real semantic `<button>`, `<input>`, `<select>`, `<fieldset>`/`<legend>` elements.

---

## Visual direction

Name: **계기판 (instrument panel).** A quiet archival utility, not a social feed.

- Near-monochrome graphite surfaces; a single slate-blue accent used **only** for state (selection, focus, primary affordance) — never as decoration
- 1px hairline borders; **no shadows**; depth comes from one border step plus one surface step
- 2px radii everywhere (1px on chips, 50% on radios)
- Monospace means "machine value": channel names, role names, timestamps, permission constants, slash commands. Never for human sentences.
- Dark is canonical; light theme is the same tokens with swapped values

Explicitly avoided: popularity/ranking cues, surveillance framing, AI-magic framing, enterprise-admin density, glassmorphism, illustration, animation.

---

## Design tokens

Use `tokens.css` verbatim. Summary:

**Surfaces** page `#08090b` · surface `#0e0f11` · raised `#121417` · sunken `#0a0b0d`
**Borders** divider `#1c1f23` · border `#26292e` · strong `#2f3339` · focus `#8f9fd6`
**Text** text `#e6e8ea` · text-2 `#c9ced4` · muted `#83888f` · faint `#5f646a`
**Semantic** accent `#4A5A8C` · success `#86c1a1` · warning `#d6bb8f` · error `#e9a3a3`
**Light theme** page `#ececeb` · surface `#f7f7f6` · text `#17181a` · muted `#6a6e74` · accent `#3F5185`

**Contrast rule — enforce this.** `--faint` (#5f646a) is for **disabled controls only**; it measures 3.2:1 and fails AA. Any text a user must read — placeholders in enabled inputs, condition labels, annotations, secondary metadata — uses `--muted` (5.37:1 on surface). This was a real defect caught in review; don't reintroduce it.

**Type** Pretendard (Korean UI) + JetBrains Mono (machine values).
| Role | Size / weight / line-height |
|---|---|
| display | 26 / 600 / 1.2, -0.02em |
| title | 20 / 600 / 1.3, -0.015em |
| subtitle | 17 / 600 / 1.35 |
| body | 13.5 / 400 / 1.65 (Korean minimum) |
| label | 12.5 / 500 / 1.4 |
| small | 11.5 / 400 / 1.55 |
| meta (mono) | 11 / 400 |
| micro (mono) | 10 / 400–500, letter-spacing .07–.09em, uppercase |

Body never below 13.5px, labels never below 11px, Korean body line-height never below 1.65.

**Spacing** 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 (4px multiples only).
**Radii** 2px default, 1px chips, 50% radios. **Borders** 1px only.
**Containers** archive 720 · form 560 · recovery 420 · page max 1120.

Pretendard: `https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.css` (self-host for production). JetBrains Mono: Google Fonts, weights 400/500.

---

## Components

### Buttons
Four variants; `padding: 10px 16px` (md) or `7px 12px` (sm); `font: 500 12.5px` UI; radius 2px.

| Variant | Rest | Hover | Disabled |
|---|---|---|---|
| primary | bg `#dfe3e7`, fg `#0e0f11` | bg `#fff` | bg `#1b1e22`, fg `#5f646a` |
| secondary | transparent, border `#2f3339`, fg `#c9ced4` | bg `#1b1e22`, border `#3a3f46`, fg `#e6e8ea` | border `#23262b`, fg `#4a4e54` |
| ghost | transparent, no border, fg `#c9ced4` | bg `#17191d` | fg `#5f646a` |
| danger | bg `#1a1111`, border `#5e3636`, fg `#e9a3a3` | — | — |
| danger (confirm step) | bg `#7d3a3a`, fg `#fff` | — | — |

**One primary per screen.** Focus (all interactive elements, no exceptions): `outline: 2px solid #8f9fd6; outline-offset: 2px`.

### Inputs
`padding: 10px 11px`, bg `#0a0b0d`, border `#2f3339`, radius 2px. Value text 12.5px (mono if it's a channel/role/ID). Placeholder `--muted`.
- focus: border `#4A5A8C` + focus ring, offset 1px
- error: border `#7d3a3a`, message below in 11px `#e9a3a3`
- disabled: bg `#0d0e10`, border `#23262b`, text `#4a4e54`

### Role multi-select
A bordered field containing chips + an inline "역할 추가…" placeholder, with a dropdown list below.
Chip: bg `#1b1e22`, border `#2f3339`, radius 1px, `padding: 5px 7px`, `400 11.5px` mono, trailing `×` in `--muted`. Options list: rows `padding: 8px 10px`, divider between, highlighted row bg `#16191d`. `@everyone` is present but unselectable (`#4a4e54`).
Must be keyboard-operable: arrow keys to move, Enter/Space to toggle, Backspace to remove the last chip, Escape to close. Real `<fieldset>`/checkbox semantics or a proper ARIA listbox — not a div soup.

### Radio group (archive destination)
Selected row: border `#4A5A8C`, bg `#131721`, 12px dot ring `#8f9fd6` with 5px fill. Unselected: border `#26292e`, ring `#4a4e54`. Each option carries a description paragraph in 11.5px `#a9aeb5`; the "existing channel" option reveals its channel `<select>` indented 34px when chosen.

### Status callouts
`padding: 11px 12px`, 1px border, radius 2px, and a **leading text tag** in 10px mono uppercase. Never color-only.
| Tag | fg | bg | border |
|---|---|---|---|
| NOTE | `#aeb9dc` | `#131721` | `#3b4560` |
| OK | `#9ccdb3` | `#111a15` | `#2f4d3d` |
| 확인 | `#d6bb8f` | `#1a1610` | `#5c4a2a` |
| 오류 | `#e9a3a3` | `#1a1111` | `#5e3636` |

### Badges
10.5px mono, 1px border, radius 1px, `padding: 4px 6px`. Neutral / accent / success / muted variants.

### Toast
Bottom-right, 4s, bg `#16191d`, border `#2f3339`, radius 2px, `padding: 11px 13px`: a 10px mono status tag plus a 12px sentence. Announce via `aria-live="polite"`.

### Clip card
`padding: 16px 18px`, `gap: 10px` vertical, bottom divider `#1c1f23`. Fixed hierarchy — do not reorder:

1. **Source line** — 22px square avatar (radius 2px, bg `#2a2e34`, initial 11px), author `600 13px`, channel `11px mono #8b9096`, original timestamp `11px mono --muted`
2. **Reply provenance** (if present) — `11px --muted`, left border 2px `#2f3339`, `padding-left: 8px`, prefix `답장 → `
3. **Body** — `13.5px/1.65 --text-2`, `white-space: pre-wrap`, `text-wrap: pretty`
4. **Code block** (if present) — `<pre>`, bg `#08090b`, border `#23262b`, `11.5px/1.6` mono `#a8b4c0`, `overflow-x: auto` so it never widens the card
5. **Attachment** (if present) — 104px placeholder, diagonal 6px stripe pattern, border `#23262b`
6. **Footer** — `클립 {date}` in 10px mono uppercase `--muted` on the left; a single secondary action on the right

No reaction counts, no vote counts, no rank. The bot's 📎 reaction on the source message means "an archive exists" — never surface its count in the web UI.

---

## Screens

### Screen A — expired setup link (`/setup/:token` invalid)
Purpose: recover, never dead-end. Container 420px, centered, card on `--surface`.
Content: wordmark; title `설정 링크가 만료되었습니다`; body `관리자 설정 링크는 한 번만 사용할 수 있고, 발급 후 15분이 지나면 만료됩니다. 이미 사용된 링크일 수도 있습니다.`; NOTE callout `Discord 서버에서 /setup 을 다시 실행하면 새 링크를 받을 수 있습니다.`; footnote above a top divider: `이미 설정을 마친 서버라면 이 링크 없이도 아카이브는 정상 동작합니다.`
Reachable without a session. No navigation.

### Screen B — setup (first run)
Container 560px. A guild identity bar (wordmark · divider · guild name; right side `관리자 · @handle`), then the form card, `gap: 22px` between groups.

1. **보관 위치** radio group
   - `비공개 아카이브 채널 새로 만들기 — 권장` + description: `Clip이 #clip-archive 를 만들고, 설정된 역할만 볼 수 있도록 권한을 지정합니다. 생성이 끝나면 채널 관리 권한은 회수해도 됩니다.`
   - `기존 채널 사용` + revealed channel select + warning line: `기존 채널을 쓰면 해당 채널을 볼 수 있는 모든 멤버가 아카이브를 볼 수 있습니다.`
2. **클립 허용 역할** multi-select + NOTE: `서버 관리자는 이 목록과 무관하게 항상 클립할 수 있습니다. 역할을 비워 두면 관리자만 클립합니다.`
3. **이 설정으로 일어나는 일** — three em-dash bullets, 12px `--text-2`:
   - `설정된 역할의 멤버가 이 서버의 메시지를 아카이브에 보존할 수 있습니다.`
   - `보존된 메시지 본문은 Discord 아카이브 채널에 남고, Clip은 식별자와 운영 정보만 저장합니다.`
   - `작성자는 자신의 메시지를 아카이브에서 직접 제거할 수 있습니다.`
4. Actions: `설정 저장` (primary) · `취소` (secondary)

Validation: choosing 기존 채널 with no channel selected → field border `#7d3a3a` + 확인 callout `채널을 선택해야 저장할 수 있습니다.`; save disabled until resolved. Empty role list is valid (admins only).

### Screen C — setup complete
Container 520px. `READY` tag in 10px mono `#86c1a1`, title `설정을 마쳤습니다`, then a bordered key/value table (rows `padding: 12px 14px`, divider between; key = 11px mono uppercase `--muted` left, value right-aligned, mono when it's a channel/role):
`아카이브 채널 · #clip-archive` / `허용 역할 · @moderator · @기록관리` / `관리자 · 설정과 무관하게 항상 허용` / `보관된 메시지 · 47개`
Then **사용법** as a stepped row: `메시지 우클릭 → 앱 → Clip` (the Clip token in a bordered mono chip). Then an OK callout, shown **only when the channel was auto-created**: `채널을 자동 생성했으므로 일상 운영에는 채널 관리 권한이 더 이상 필요하지 않습니다.` Actions: `아카이브 열기` (primary) · `설정 다시 보기`.

### Screen D — archive list (read-only)
Container 720px, single panel, newest first.
- Header bar: wordmark · divider · guild name; right: `아카이브` (active) / `설정` tabs
- Filter bar on `--raised`: `채널` micro label, channel select (default `전체`), count `47개`, right-aligned `최신순`
- Clip rows per the card spec
- **Loading row**: skeleton bars (`#23262b` / `#1c1f23`, 9px tall, radius 1px) plus the literal line `Discord에서 내용을 불러오는 중…` in 10px mono — the list shell renders before content arrives, since bodies are fetched from Discord
- **Missing-copy row**: bg `#0d0e10`, leading `누락` tag, title `보관된 사본을 Discord에서 찾을 수 없습니다`, body `아카이브 채널의 메시지가 삭제된 것 같습니다. 보관 기록(작성자·채널·시각)은 남아 있습니다.`, then the surviving metadata. Note the distinction: the archive **record** survives even when the Discord copy is gone.
- Footer: `1–5 / 47` + `이전` (disabled → `#4a4e54` on border `#23262b`) / `다음`

No infinite scroll — explicit pagination. Filter and page state belong in the URL.

### Screen E — current config + destructive action
Kept **separate** from Screen B by design: first-run configuration and repeat-visit config/deletion have different purposes. Two columns (460px + 400px), stacking below 960px.
Left: `현재 설정` label, guild name as title, the same key/value table, `설정 변경` secondary, then a **위험 구역** block: explanation `Clip이 저장한 설정·권한·보관 기록을 이 서버에서 모두 지웁니다. Discord 아카이브 채널과 그 안의 메시지는 삭제되지 않습니다.` + `Clip 데이터 삭제` danger button.
Right: the confirm panel (border `#5e3636`), title `Clip 데이터를 삭제하면`, then a 삭제/유지 list — `삭제` marks in `#e9a3a3`, `유지` marks in `#86c1a1`:
- 삭제 · `아카이브 위치·허용 역할 설정`
- 삭제 · `보관 기록과 누가 언제 클립했는지에 대한 정보`
- 유지 · `Discord의 #clip-archive 채널과 그 안의 모든 메시지`
- 유지 · `원본 채널의 메시지 (영향 없음)`
Then a required checkbox `위 내용을 이해했으며 되돌릴 수 없다는 것을 알고 있습니다.`, then `삭제 실행` (danger solid, enabled only when checked) · `취소`.

### Discord-side copy
All command/context-menu responses are **ephemeral, one line, one fact**. Never expose state-machine vocabulary (canonical clip, clipper row, PENDING, tombstone).

| Condition | Copy |
|---|---|
| success | `✓ 보관했습니다` |
| duplicate | `이미 보관된 메시지입니다` |
| unclipped | `✓ 보관을 해제했습니다` |
| nothing to unclip | `이 메시지를 보관한 기록이 없습니다` |
| no permission | `이 서버에서 메시지를 보관할 권한이 없습니다` |
| invalid target | `이 메시지는 보관할 수 없습니다` |
| transient failure | `보관하지 못했습니다. 다시 시도해 주세요` |

Author DM (informational, not alarming): `회원님이 **{guild} / #{channel}** 에 남긴 메시지가 이 서버의 Clip 아카이브에 보관되었습니다.` with actions `원본 보기` and `아카이브에서 제거`. Do not make "who clipped you" the focus.

---

## Interactions & behavior

- **Navigation**: `아카이브` ↔ `설정` only. No sidebar, no breadcrumbs.
- **Archive list**: filter by source channel and paginate; both in the URL so a view is linkable. Content bodies load per-row from Discord — render the shell first, then swap skeletons for content. A failed row becomes the missing-copy state, not an error page.
- **Setup form**: client-side validation on submit and on blur for the channel select; disable submit while pending; success → Screen C (first run) or toast `설정을 저장했습니다.` (edit).
- **Deletion**: two steps, always. Step 1 opens the confirm panel; step 2 requires the checkbox. Never a bare "정말 삭제하시겠습니까?".
- **Transitions**: none. No animation is specified for P0; a 120ms color transition on hover is acceptable, nothing else.
- **Responsive**: ≤640px — filter and pagination stack vertically, card padding 16→12, long code/URLs stay inside `overflow-x: auto`, attachment previews never exceed the card. ≤960px — Screen E collapses to one column. No mobile-native navigation patterns in P0.

## State

- `session` — admin setup token: valid / used / expired (drives Screen A)
- `config` — `{ archiveChannelId, archiveChannelName, autoCreated, allowedRoleIds[], clipCount }`
- `form` — destination mode (`create` | `existing`), selected channel, selected roles, dirty flag, validation errors, submitting
- `list` — `{ page, channelFilter, items[], totalCount }`; each item `{ id, author, channel, originalAt, clippedAt, contentState: loading | ready | missing, body?, code?, attachments?, replyTo?, originalUrl? }`
- `deleteFlow` — `idle | confirming | acknowledged | deleting`

Fetching: config on mount for admin pages; archive page + filter drive the list request; per-row Discord content fetch may be batched. Show the shell before content resolves.

## Accessibility (from the brief — all required)

Visible focus on everything (accent 2px, offset 2px) · semantic labels on all form controls · keyboard-usable setup form including the multi-select · status conveyed by text tags, not color alone · destructive confirmation with explicit consequence copy · `aria-live` for toasts and load/error transitions · AA contrast, with the `--faint` rule above enforced.

## Assets

None. No icon set, no illustration, no imagery. The wordmark is type-only: a 9px accent-neutral square (radius 1px) plus "Clip" in Pretendard 600 at -0.01em. Attachment previews are striped placeholders — real Discord attachments render in their place. The 📎 marker is a Discord reaction emoji, not an asset.
