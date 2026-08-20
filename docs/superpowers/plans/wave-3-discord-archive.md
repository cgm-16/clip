# Wave 3 + retained P0 scope — Discord archive and minimum setup UI

Branch: `wave/3-discord-archive`. Worktree: `/Users/ori/repos/clip-wave3`.

## Scope

Ori made a deliberate scope cut at 2026-08-20 01:05 KST with 23 hours to the deadline
(recorded in `docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md`). **Cut, do not build:** Wave 5
entirely (`5.1`–`5.4`), `4.3` role configuration UI, `6.4` Playwright e2e, `7.1` exhaustive
a11y sweep. What remains is below.

Already complete on this branch:

- `3.1` — REST client and two-message archive builder (`0492fda`).
- `F.1`/`F.2` — tokens, global styles, fonts, Korean string table (dispatched separately).

## Context

Clip is a Korean-language Discord app: an authorized member preserves ("clips") a message
into a server-owned archive. One Next.js App Router deployable (TypeScript, React 19,
Next 16) serves both the Discord interaction endpoint and the admin web UI. Postgres via
Prisma 7 with the `@prisma/adapter-pg` driver adapter. Tests are Vitest in `tests/`,
mirroring the `lib/` path they cover. Repo layout is root-level: `app/`, `lib/`, `tests/`,
`scripts/`. There is no `src/`.

The domain layer is done and must not be redesigned. `lib/clip/service.ts` exposes
`createClipService(gateway)` with `clip`, `unclip` and `remove`; `lib/clip/types.ts` holds
the result unions every command handler maps to copy. `lib/discord/archive-message.ts`
implements the gateway against the real API.

## Global Constraints

- **TDD is mandatory.** Write the failing test first, watch it fail, then implement.
- `pnpm lint` (eslint + `tsc --noEmit`), `pnpm test`, and `pnpm build` must all pass.
- Postgres-backed tests need the local container: `docker start clip-pg`, and
  `DATABASE_URL=postgresql://clip:clip@localhost:5433/clip_dev`. The repo `.env` is
  correct in this worktree. Export it with `set -a && . ./.env && set +a` before running
  Prisma CLI commands — Prisma 7 reads the URL from `prisma.config.ts` via `process.env`
  and does not load `.env` itself.
- **Never persist or log raw Discord message bodies, attachments, or embed payloads.**
  Not in Postgres, not in logs, not in error messages. `DiscordApiError` deliberately
  drops response bodies for this reason; keep it that way.
- Environment access goes through `parseEnv` in `lib/env.ts`. Never read `process.env`
  directly in feature code.
- Korean copy in `docs/06_DESIGN_HANDOFF.md` is **final**. Reuse an existing string or
  ask. **Never invent new Korean prose.** Discord-side strings live in
  `lib/discord/copy.ts`; web strings in the F.2 string table.
- Match the surrounding code's style: single quotes, semicolons, 2-space indent. Comments
  explain *why*, never temporal context ("new", "moved", "recently").
- Conventional Commits, one commit per task.
- Never weaken a product invariant to make a test pass.

## Task 1 — `3.3` First-clip author DM

### Files
- `lib/discord/notifications.ts` (new)
- `tests/discord/notifications.test.ts` (new)

### Requirements

- [ ] Exactly **one** DM per first canonical archival. Record delivery status so retries
      and process restarts never re-send. The Clip row is the natural place; check
      `prisma/schema.prisma` for an existing column before adding one, and if you add one,
      write the migration.
- [ ] Additional clippers on the same message do **not** trigger another DM — test this.
- [ ] Opening a DM channel is `POST /users/@me/channels` with `{ recipient_id }`, then
      posting to `/channels/{id}/messages`. Both go through the existing REST client.
- [ ] DM failure, in particular error **`50007`** (cannot send to this user), maps to an
      `UNDELIVERABLE` outcome and is **never fatal** — it must not roll back the clip.
- [ ] Copy is final, from `docs/06_DESIGN_HANDOFF.md`:
      `회원님이 **{guild} / #{channel}** 에 남긴 메시지가 이 서버의 Clip 아카이브에 보관되었습니다.`
      with actions `원본 보기` and `아카이브에서 제거`. Add these to `lib/discord/copy.ts`.
- [ ] `원본 보기` is a link button to the source message jump link. `아카이브에서 제거` is a
      button whose `custom_id` encodes the guild and source message id.
- [ ] **The remove button re-verifies the interacting user against `author_user_id`
      server-side.** Custom ids travel in the client; without a server-side author check
      anyone who can see the button could remove someone else's entry. Test this directly.

### Spec
`docs/01_CLIP_PRODUCT_SPEC.md` §11.1, §11.3, §17 case 9.

## Task 2 — `3.2` Bot-owned 📎 marker reaction

### Files
- `lib/discord/marker.ts` (new)
- `tests/discord/marker.test.ts` (new)

### Requirements

- [ ] Bot marker present = an archive exists. Add on active archive, remove on canonical
      removal where possible.
- [ ] **User-added reactions with the same emoji carry no Clip meaning and are never
      counted.** Never treat a user reaction as a clipper signal — test this.
- [ ] Marker failure is **non-fatal**: the Clip stays valid. Log safely on failure.
- [ ] Known limitation, leave alone and document in the README: when an archive is
      removed, user-added copies of the emoji may remain visible. Working around it needs
      Gateway events, which are P1.

### Cuttable
Explicitly auxiliary in the spec. If time runs short this is the first thing to drop.

## Task 3 — `3.4` GATE — wire Clip, Unclip and Remove context commands

### Files
- `app/api/discord/interactions/route.ts` (extend)
- `lib/discord/interaction-responses.ts` (new, suggested)
- `tests/discord/context-commands.test.ts` (new)

### Requirements

- [ ] `Clip` checks role/admin authorization via the existing `lib/clip/authorization.ts`.
- [ ] `Unclip` affects **only the invoking user's signal**.
- [ ] `Remove from Clip Archive` authorizes the source author **or** a guild admin.
- [ ] Every response **ephemeral, one line, one fact**. Never expose state-machine
      vocabulary (canonical clip, clipper row, PENDING, tombstone).
- [ ] **Watch the 3-second limit.** Archive creation is two REST calls plus a DM. Defer
      the interaction (`type: 5`, `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE`, ephemeral flag)
      and follow up via `PATCH /webhooks/{app_id}/{token}/messages/@original`, rather than
      racing the timeout.
- [ ] Copy is final. Add each to `lib/discord/copy.ts`, keyed by condition:

| Condition | Copy |
|---|---|
| success | `✓ 보관했습니다` |
| duplicate | `이미 보관된 메시지입니다` |
| unclipped | `✓ 보관을 해제했습니다` |
| nothing to unclip | `이 메시지를 보관한 기록이 없습니다` |
| no permission | `이 서버에서 메시지를 보관할 권한이 없습니다` |
| invalid target | `이 메시지는 보관할 수 없습니다` |
| transient failure | `보관하지 못했습니다. 다시 시도해 주세요` |

- [ ] Duplicate clipping is **not** styled as an error.
- [ ] Map every variant of `ClipCommandResult`, `UnclipResult` and `RemoveResult` to
      exactly one of those strings. A result variant with no mapping is a defect.

### Done check
Unit tests green. The real-guild verification is a separate manual step — it depends on
gate `0.3b`, which is outside this plan.

### Spec
`docs/01_CLIP_PRODUCT_SPEC.md` §10, §17.

## Task 4 — `F.3` UI primitives

### Files
- `components/ui/*.tsx` (new)
- `tests/ui/primitives.test.tsx` (new)

### Requirements

- [ ] Build the primitives `docs/06_DESIGN_HANDOFF.md` specifies: button (primary,
      secondary, danger), text input, select, radio group, fieldset with legend, callout
      (NOTE / OK / 오류), text tag, and the bordered mono chip.
- [ ] **Mockups use `<span>` where a real control belongs.** Build semantic `<button>`,
      `<input>`, `<select>`, `<fieldset>` with labels and keyboard support.
- [ ] All visual values from `tokens.css`. No ad-hoc hex codes, no spacing outside the 4px
      scale. Radius 2px (1px chips, 50% radios), borders 1px.
- [ ] `--faint` is for **disabled controls only**; readable text uses `--muted`.
- [ ] No shadows, gradients, blur, or animation beyond a 120ms hover color transition.
- [ ] Every state gets a **text tag** (`NOTE` / `OK` / `확인` / `오류` / `누락`). Never signal
      state with color alone.
- [ ] Visible focus on everything: accent, 2px, offset 2px.
- [ ] One primary button per screen — enforce by convention and document it.

## Task 5 — `4.1` Guild, channel and role lookup for setup

### Files
- `lib/discord/guild-lookup.ts` (new)
- `tests/discord/guild-lookup.test.ts` (new)

### Requirements

- [ ] Fetch guild channels (`GET /guilds/{id}/channels`) and roles
      (`GET /guilds/{id}/roles`) through the existing REST client.
- [ ] Return only what the setup form needs: channel id, name, type; role id, name.
      Filter to text channels the bot can post in.
- [ ] Never return or log message content — these endpoints do not carry it, so the risk
      is incidental logging of whole payloads. Log ids only.
- [ ] Map a missing/forbidden guild to a typed outcome rather than throwing raw.

## Task 6 — `4.2` Screen B — archive destination configuration

### Files
- `app/setup/[token]/page.tsx` and supporting components (new)
- `tests/ui/setup-form.test.tsx` (new)

### Requirements

- [ ] Build Screen B exactly per `docs/06_DESIGN_HANDOFF.md` lines 147–154: the
      **보관 위치** radio group with `비공개 아카이브 채널 새로 만들기 — 권장` and
      `기존 채널 사용`, the revealed channel select, and the warning line.
- [ ] The consent copy block (`설정된 역할의 멤버가 …`, `보존된 메시지 본문은 …`,
      `작성자는 자신의 메시지를 …`) is required — it is the consent surface, not polish.
- [ ] Client-side validation on submit and on blur for the channel select; disable submit
      while pending.
- [ ] **`4.3` allowed-role configuration is CUT.** Persist admin-only clipping, which the
      spec already permits. Do not build the role multi-select.
- [ ] Session comes from the admin session cookie established in Wave 1
      (`lib/admin-session/`). An expired or used token renders Screen A.
- [ ] Keyboard-usable throughout; semantic labels on every control.

## Task 7 — `4.4` Screen C — setup complete

### Files
- `app/setup/[token]/complete/page.tsx` or equivalent (new)
- extend `tests/ui/setup-form.test.tsx`

### Requirements

- [ ] Per handoff lines 161–162: the key/value summary
      (`아카이브 채널 · #clip-archive` / `관리자 · 설정과 무관하게 항상 허용` /
      `보관된 메시지 · 47개`), then **사용법** as a stepped row
      `메시지 우클릭 → 앱 → Clip` with the Clip token in a bordered mono chip.
- [ ] The OK callout `채널을 자동 생성했으므로 …` shows **only when the channel was
      auto-created**.
- [ ] Actions `아카이브 열기` (primary) and `설정 다시 보기`. Since Wave 5 is cut, decide
      where `아카이브 열기` points and record the decision — do not invent a new screen.
- [ ] The 허용 역할 row reflects the cut: admin-only. Do not invent Korean copy for this;
      reuse `관리자 · 설정과 무관하게 항상 허용`.

## Out of scope for this plan

`0.3b` (Discord portal gate), `6.1`/`6.2`/`6.3` (QA wave), `7.2`/`7.3` (submission) are
tracked separately and depend on the deployment, not on this branch's code.
