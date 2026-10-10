# Wave 6 — Verification Implementation Plan

> **For agentic workers:** the orchestrator dispatches one implementer subagent per task (superpowers:subagent-driven-development). Each task is TDD: record the RED, then GREEN, then the full gate. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Verify P0 end to end (F.6, 6.1–6.4, 7.1) and fold in #64, #60 and, last, #63.

**Architecture:** No new subsystems. #64 widens the safe-log allowlist and carries failure facts on `ArchiveCreationFailedError`. #60 reads Discord's `managed` flag. 6.2 adds service-level races on real Postgres with the existing fake gateway. F.6 is a grep-level script. #63 adds one confirmed-missing check on the duplicate-clip path and an ACTIVE→ACTIVE id swap under the existing locks.

**Tech Stack:** Next.js 16 App Router, TypeScript, Prisma 7, Postgres, Vitest, pnpm; Playwright for 6.4 only.

**Spec:** `docs/superpowers/specs/2026-10-05-p0-restoration-design.md`, plus the issue briefs #64, #60, #36, #43, #35, #37, #38, #39, #63.

**Branch:** `wave/6-verification`, worktree `../clip-wave6`, one PR.

## Global Constraints

- Never invent Korean strings. Reuse `lib/ui/copy.ts` / `lib/discord/copy.ts` entries or ask Ori.
- `tokens.css` is the only source of visual values. `--faint` is disabled controls only.
- Never persist or log message content, attachments, embeds, Discord error messages or response bodies.
- Invariants: one canonical Clip per `(guild_id, source_message_id)`; one Clipper per `(…, clipper_user_id)`; DB uniqueness/upsert, never check-then-insert; tombstone wins; never `ACTIVE` with a missing or partial archive (`clips_active_requires_archive`); never hold locks across Discord I/O.
- Gate: `pnpm lint`, `pnpm test`, `pnpm build` (plus `pnpm lint:design` after Task 4). Tests use `DATABASE_URL=postgresql://clip:clip@localhost:5433/clip_dev`.
- A flaky race test is a locking bug. Never add a retry to make it pass.

## Review Focus

1. A fetch timeout (`DOMException` named `TimeoutError`) versus a network `TypeError`: both must be classed and logged without the message.
2. A managed role that is *already* saved in a guild's allowed roles before #60 ships: the edit form must show it and let the admin remove it, not crash or silently keep it.
3. Unclip or author removal landing between #63's "copy missing" read and its id swap: the swap must lose, and the new pair must be deleted.
4. #63 on a Discord access error or 5xx for the forward read: no repost (only Unknown Message / Unknown Channel confirm a missing copy).
5. The design guard's own false positives: Korean in `lib/ui/copy.ts`, `lib/discord/copy.ts` and tests must pass.

---

### Task 1: #64 — log failure class, status and Discord code

**Files:**
- Modify: `lib/discord/rest-client.ts` (add `describeDiscordFailure`)
- Modify: `lib/discord/archive-message.ts` (`ArchiveCreationFailedError` gains `step` and `failure`)
- Modify: `lib/logging/safe-log.ts` (allowlist `step`, `failure`, `httpStatus`, `discordCode`)
- Modify: `lib/clip/service.ts` (`clip.archive_failed` and `clip.revival_failed` lines carry them)
- Modify: `lib/archive/content.ts` (one `archive.content_read_failed` line per failed read)
- Test: `tests/discord/rest-client.test.ts`, `tests/discord/archive-message.test.ts`, `tests/logging/*.test.ts`, `tests/clip/service.test.ts`, `tests/archive/content.test.ts`

**Interfaces:**
- Produces: `describeDiscordFailure(error: unknown): DiscordFailureFacts` where
  `type DiscordFailureFacts = { failure: 'http' | 'timeout' | 'network'; httpStatus?: string; discordCode?: string }`.
  `DiscordApiError` → `http` with `httpStatus` and (when non-null) `discordCode` as decimal strings. A `DOMException`/`Error` whose `name` is `TimeoutError` or `AbortError` → `timeout`. Anything else → `network`. Never reads `error.message`.
- Produces: `ArchiveCreationFailedError` options gain `step: 'source_read' | 'provenance_post' | 'forward_post'` and `failure: DiscordFailureFacts | null` (null for the "unexpected shape" case). Existing `retryable` / `orphanedProvenanceMessageId` unchanged.
- Produces: `SafeClipLog` gains `step?`, `failure?`, `httpStatus?`, `discordCode?` (all strings) and they join `SAFE_KEYS`.

- [ ] **Step 1: RED.** Tests:
  - `describeDiscordFailure` for a 429 `DiscordApiError` (code 0 → `discordCode: '0'`), a 503 with null code (no `discordCode` key), a `TimeoutError` DOMException, and a `TypeError('fetch failed')`.
  - `createArchiveMessage` failing at each of the three steps yields an `ArchiveCreationFailedError` with the matching `step` and facts.
  - `clip()` with a gateway that throws a 429-class `ArchiveCreationFailedError` logs one `clip.archive_failed` line containing `step`, `failure: 'http'`, `httpStatus: '429'`, `discordCode`, and the line contains neither the error message nor any body text (spy on `console.log`, assert the parsed JSON keys exactly).
  - `loadArchiveContent` with the forward read throwing a 5xx and a timeout logs `archive.content_read_failed` with `guildId`, `sourceMessageId`, `step: 'forward_read'` (or `'source_read'` for the source GET), and the facts; a successful read logs nothing. Add `'forward_read'` to the `step` union in `SafeClipLog`'s doc comment only — it is a string field.
  Record the RED reason (missing export / missing keys).
- [ ] **Step 2: GREEN.** Implement as above. `errorCodeOf` in `service.ts` stays; the log call spreads `step` and the facts when the error is an `ArchiveCreationFailedError`.
- [ ] **Step 3:** `pnpm test tests/discord tests/logging tests/clip tests/archive` → PASS; then full gate.
- [ ] **Step 4: Commit** `fix(logging): name the failure class, status and Discord code when an archive write or read fails` with `Closes #64` in the body.

### Task 2: #60 — managed roles are shown but not selectable

**Files:**
- Modify: `lib/discord/guild-lookup.ts` (`GuildRole` gains `managed: boolean`; `parseRoles` reads it, defaulting to `false` when absent)
- Modify: `app/setup/data/route.ts:53` (`selectable: id !== guildId && !managed`)
- Modify: `app/setup/save/route.ts:164` (refuse a managed id with `INVALID_ROLE`)
- Test: `tests/discord/guild-lookup.test.ts`, `tests/setup/data-route.test.ts`, `tests/setup/save-route.test.ts`, and the setup form test if the form needs a case for an already-saved unselectable role (Review Focus 2).

- [ ] **Step 1: RED.** `parseRoles` keeps `managed: true`; `/setup/data` marks a managed role `selectable: false`; `/setup/save` with a managed role id → 422 `INVALID_ROLE` before any write. If an already-saved managed role renders on the edit form, assert the admin can deselect it (check how stale roles render today and reuse that path; no new Korean).
- [ ] **Step 2: GREEN.**
- [ ] **Step 3:** full gate.
- [ ] **Step 4: Commit** `fix(setup): show the bot's managed role but do not offer it as a clipping role` with `Closes #60`.

### Task 3: 6.2 (#36) — integrated race and idempotency tests

**Files:**
- Create: `tests/integration/clip-concurrency.test.ts` (real Postgres, `tests/clip/fake-gateway.ts`, `createClipService`)

The repository-level races already exist (`tests/clip/repository.test.ts:128,166,223`). These go through the service so the archive side effect is counted.

- [ ] **Step 1:** Tests (each with N ≥ 5 concurrent calls via `Promise.all`):
  - Parallel clips of one source by different users → gateway `createArchiveMessage` called exactly once, one ACTIVE Clip, N clippers.
  - Parallel same-user clips → one Clipper row, one archive.
  - Parallel final Unclips by every clipper → exactly one archive delete call, Clip gone.
  - Author removal racing a normal clip → tombstone exists, no ACTIVE Clip, and a later clip is refused.
  - Gateway create throws (retryable) → Clip is `FAILED` or absent, never `ACTIVE`; a following clip succeeds. Gateway delete throws on final Unclip → control plane is consistent and the attempt is retryable.
  These test existing behaviour, so they may pass at once. For each, record the production change that would make it fail (e.g. "dropping the row lock in `unclip`") and prove one by temporarily breaking it locally, then restoring. Note the result in the commit body.
- [ ] **Step 2:** Run each test 20× (`pnpm vitest run tests/integration --repeat 20` or a loop). Any failure is a locking bug → systematic-debugging, never a retry.
- [ ] **Step 3: Commit** `test(clip): race the service end to end against real Postgres` with `Closes #36`.

### Task 4: F.6 (#43) — `pnpm lint:design` guard in CI

**Rulings against the brief (it predates the CSS-modules switch):** Tailwind is gone (`postcss.config.mjs` deleted), so the Tailwind arbitrary-value checks are dropped. The string tables are `lib/ui/copy.ts` and `lib/discord/copy.ts`, not `lib/i18n/`.

**Files:**
- Create: `scripts/lint-design.ts` (run with the repo's existing TS runner; check `package.json`)
- Modify: `package.json` (`"lint:design"`), `.github/workflows/ci.yml` (step after `pnpm lint`)
- Test: `tests/scripts/lint-design.test.ts`

Checks over `app/`, `lib/`, `components/` (never `scripts/`, `tests/`, `design/`):
1. Hex colour literal outside `tokens.css`.
2. Hangul in a `.ts`/`.tsx` outside `lib/ui/copy.ts` and `lib/discord/copy.ts`. Comments count too unless the existing code has Korean in comments. Check first and rule.
3. In `.css`, a `px` value that is not a multiple of 4, except `1px`, `2px` (radius per CLAUDE.md rule 5), and the type sizes `13.5 / 12.5 / 11.5 / 11 / 10px`.
4. `var(--faint)` in a rule whose selector lacks `:disabled` or `[aria-disabled`.

- [ ] **Step 1: RED.** Fixture strings per check (one violating, one clean) through an exported `findDesignViolations(path, text)`; then run the script on the real tree. If the real tree has violations, each one is either a real defect (fix it in its own commit, TDD where it is behaviour) or a documented exception added to the allowlist with a comment saying why. Report the list to the orchestrator before deciding any exception.
- [ ] **Step 2: GREEN**, CI step, full gate plus `pnpm lint:design`.
- [ ] **Step 3: Commit** `ci(design): fail the build on token and string-table violations` with `Closes #43`.

### Release checkpoint (orchestrator)

Push, CI green, Ori deploys the branch image (or merges a partial PR. Ori decides). The manual suites run against code that includes #64 logging.

### Task 5: 6.1 (#35) and 6.3 (#37) checklists for Ori

**Files:** Create `docs/tasks/wave-6-manual-checklist.md`.

Prep (fresh guild for 6.1, three accounts: admin, role member, plain member), then the 8 permission-matrix checks from #35 and the 17 scenarios plus the poll case from #37, each with: steps, expected result (quoting existing Korean strings verbatim from the string tables, by key), and an evidence slot. Include a burst-clip repeat (5 clips within ~10 s) and the `kubectl logs` command to read the #64 fields. Orchestrator writes this; no code.

After Ori runs it: replace the README permission table with the measured set and append the snapshot (§0 template).

### Task 6: 7.1 (#39) accessibility and responsive sweep

Implementer audits every screen (A–E) against the #39 checklist using Playwright MCP on a local `pnpm dev` with seeded data, at 1280, 960 and 375 px. Output: a findings list with file:line. Each real defect is fixed TDD (component test where possible) in its own commit `fix(a11y): …`. Contrast is computed from `tokens.css` values, not eyeballed.

### Task 7: 6.4 (#38) Playwright against the deployment (cut first)

Add `@playwright/test` (sanctioned by the design) and `e2e/` with the four flows from #38, configured by `E2E_BASE_URL`. Session seeding needs a production DB write. Ori runs a provided script; the agent never touches production. Not in the merge gate.

### Task 8: #63 — repost a confirmed-missing archive copy on re-clip (last)

Runs only after Tasks 1–7 and the manual suite are green.

**Design (orchestrator's decision):**
- Trigger: `clip()` returns `CLIPPER_ADDED` or `ALREADY_CLIPPED_BY_USER` for an `ACTIVE` Clip. After that commit (no locks held), call a new gateway method `isArchiveCopyMissing(archiveChannelId, ids): Promise<boolean>`: true only when the forward GET fails with Unknown Message or Unknown Channel; false on success; any other error → false (logged with Task 1's facts).
- If missing: `createArchiveMessage` into the current archive channel (no locks). Then, under the guild advisory lock and the Clip row lock, swap both ids in one `UPDATE … WHERE status='ACTIVE' AND archive ids = old ids AND configurationId = captured`. Zero rows updated → delete the new pair quietly. The row never passes through an ACTIVE state without both ids.
- Reply stays the existing success copy (both kinds already read as success). No new Korean.
- A failed repost leaves the Clip as it was (still `누락`) and logs `clip.repost_failed`.

**Tests (real Postgres, fake gateway):** missing → swapped ids, clippers kept; access error or 5xx → no repost; Unclip-to-zero racing the swap → no ACTIVE row, new pair deleted; author removal racing → tombstone, new pair deleted; configuration deleted/re-setup between read and swap → discarded; create fails → row unchanged.

Commit `feat(clip): repost an archive copy that Discord confirms is gone when it is clipped again` with `Closes #63`.

### Finish

Journal entry, one snapshot append for the wave, one independent review of the whole branch, PR to `main` (Ori merges).
