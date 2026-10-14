# October 2026

## 2026-10-05 — ponytail audit simplifications (#53)

- Replaced platform wrappers and removed Tailwind without changing product behavior. Database initialization stays lazy and globally cached; transaction locks and query predicates are unchanged.
- Local Postgres was initially unavailable. Started Docker and an isolated, disposable Postgres 17 container on port 5433; the complete baseline passed 345 tests. After the refactor, 346 tests pass, including an exchange-cookie round trip through real session authentication.
- Compared actual Screen A/B/C components and the input primitive at 1280px and 390px in a temporary browser fixture. Measured geometry, typography, colors, spacing, and primary-link hover matched before/after. Removed the fixture before final verification. Its initial missing TextInput label/id caused a temporary type-check failure, not a shipping-code failure.
- Out of scope: Screen B's existing fixed-width card overflows at 390px. The overflow is identical before/after; recorded for a separate responsive-layout fix.
- Production browser smoke checks passed for the expired-link screen and setup authentication/origin guards against real Next routes and Postgres. Live Discord setup and deployment e2e were not run.
- Removing dependencies refreshed pnpm peer-resolution metadata and exposed an existing ESLint 9 deprecation notice; no unrelated dependency versions were upgraded.

## 2026-10-07 — Wave 4: clipping roles and setup completion

- Restored `4.3` and `F.4` and added the existing-channel permission check. Admins pick clipping roles on Screen B; roles replace the configured set in the same transaction as the destination; `/setup/save` refuses `@everyone`, unknown and foreign role ids (422 `INVALID_ROLE`) and existing channels where the bot's effective permissions lack `VIEW_CHANNEL`, `SEND_MESSAGES` or `READ_MESSAGE_HISTORY` (422 `MISSING_PERMISSIONS`, constants shown). Auto-created channels now grant the bot history reads. Suite: 404 passed against local Postgres 17.
- Local Postgres had to be recreated (`clip-pg` container did not exist); Docker Desktop was not running at session start.
- Correction to the Wave 4 plan's interim-behaviour note: it says a channel auto-created before this wave "has no bot `READ_MESSAGE_HISTORY` overwrite, so roles cannot be edited". The overwrite does not deny history; it only re-allows `VIEW_CHANNEL` past the `@everyone` deny, so history is inherited from the bot's guild-level role permissions. A roles-only edit is refused only if the bot's guild role lacks `READ_MESSAGE_HISTORY`. Live check 1 settles which.
- Two execution slips, both caught before review: commit `3ee9a15` landed with three red save-route tests because only `tests/clip` was run before committing; and a keyboard test passed a bare `vi.fn()` to a submit handler that now expects an outcome object, which surfaced only as a Vitest "unhandled error" line under an all-green test count. Read the `Errors` line, not just `Tests`.
- Final review (fresh reviewer) found one Important defect, fixed test-first: after first setup auto-created the channel, "설정 다시 보기" prefilled a channel id missing from the stale channel list, so the select showed its placeholder and invited repointing the archive to a public channel. A keyboard focus loss on chip removal was also fixed.
- Deferred (not fixed): a deleted-in-Discord role or archive channel surfaces only as the generic save failure; the role option list stays open on blur and lacks `aria-controls`; `parseOverwrites` skips malformed overwrites rather than refusing; a redundant `key` on Screen B.
- PR review (Codex, CodeRabbit) re-graded the `parseOverwrites` item to Important: skipping unreadable overwrites fails the permission check open, since a dropped entry could be a deny on the bot. Now fixed: a missing `permission_overwrites` or any malformed entry throws `GuildLookupFailedError`, and the save is refused with 502. Cost: a future Discord overwrite type beyond 0/1 would block saves to that channel until the parser learns it.


## 2026-10-08 — production Postgres is 18; manifest realigned

- The live `clip-db` CloudNativePG cluster was moved from 16 to `ghcr.io/cloudnative-pg/postgresql:18.6-standard-bullseye` on 2026-10-05 03:37 UTC by a direct `kubectl patch` from another session that needed Postgres 18. Nothing in the repo recorded it, so `k8s/postgres.yaml` still said 16.
- The Wave 4 deploy (`sha-c97cb21`) then failed at `kubectl apply -f k8s/postgres.yaml` with `spec.imageName: Invalid value: "16": can't downgrade from major 18 to 16`. The deploy script stops at the first error, so the app Deployment was never touched and production stayed on `sha-7109e3d`.
- Fix: the manifest pins the exact running image (not `:18`) — CloudNativePG rolls the instance on any `imageName` change, so only the identical string makes the apply a no-op. CI, the README dev commands and the restoration design's verification bar move from 17 to 18 so tests run on production's major version. Historical records (snapshot, assignment answers, earlier journal entries) keep saying 17; they describe what was true then.
- Same deploy also found the local `~/.kube/config` admin client certificate expired on 2026-10-02 (one-year k3s cert, issued 2025-10-02). k3s had already renewed its own certs; Ori copied a fresh `/etc/rancher/k3s/k3s.yaml`. Expect this again around the next anniversary.
- Lesson: an out-of-band cluster change must land in the manifest the same day, or the next routine deploy trips on it.

## 2026-10-08 — Wave 4 deployed and verified live

Deployed `ghcr.io/cgm-16/clip:sha-f4dea92` (Wave 4 from PR #55 plus the PR #56 manifest realignment) with the documented render/apply/verify procedure, run by Ori because the session's permission mode blocks production deploys. Both containers on the image, migrate `No pending migrations`, one fresh app pod, ingress health `{"ok":true}`. `clip-db` reported `configured`, but the CNPG pod had not restarted (last restart days earlier) and `status.image` stayed 18.6: client-side apply only rewrote `last-applied-configuration`, which still held the old 16 manifest.

Live checks, test guild `testa`, two human accounts (A admin and message author, B member without admin rights), each confirmed against production rows, not only the screen:

1. Configured guild opens prefilled (existing channel, `#clip-archive` selected, saved role chips); a roles-only edit saved `manage servers` + `clip-test` and Screen C listed them. **Pass.**
2. B, holding only `clip-test`, clipped a message: row `ACTIVE`, both archive ids, B as clipper; two archive messages posted. **Pass.** This is `6.3` scenario 4 (allowed-role Clip), recorded as a scope cut on 2026-08-20 because `4.3` had not shipped; `6.3` now stands at 15 passed and 2 cuts, both Wave 5 web-archive scenarios.
3. With `clip-test` taken from B: Clip refused and no row created; Unclip succeeded, both archive messages deleted, Clip and Clipper rows gone (last clipper, so no tombstone). **Pass.**
4. Existing `#clip-denied` with the bot role's `READ_MESSAGE_HISTORY` denied: save refused under `오류` with a `READ_MESSAGE_HISTORY` chip; config unchanged. The channel was deleted before its overwrites were re-read, so "overwrites unchanged" rests on the save-route tests (refusal path issues only GETs), not a live reading. The chip-removal announcement was heard with VoiceOver. **Partial live pass.**

Found along the way, none caused by Wave 4 code:

- **Kicking the bot deletes its guild-scoped commands.** Re-inviting does not restore them; `scripts/register-discord-commands.ts --register` (with `.env` loaded) does. The bot's managed role also gets a new id on re-invite.
- **A deleted archive channel is a dead end in setup.** Ori had deleted the old `#clip-archive` while one Aug-20 clip was still `ACTIVE`. The fresh link prefilled the dead channel id, so the select showed only its placeholder with no `누락` explanation, and every destination change hit the `LIVE_CLIPS` refusal, which does not say which messages are live. Recovery needed a database query to find the message, then `Remove from Clip Archive` on it (deleting archive messages in a missing channel 404s, which the deleter already treats as gone). Fixing it needs new Korean copy; candidate issue for Wave 5 planning. Extends the deferred minor "deleted archive channel surfaces only as the generic save failure".
- **The bot's own managed role is selectable** in the role picker. No member can hold it, so selecting it is a no-op. Minor; could mark managed roles non-selectable like `@everyone`.
- My check-4 instructions said the refusal would carry `누락`; the design reserves `누락` for a missing archive copy, and `오류` is correct.

## 2026-10-09 — Wave 5: web archive, settings and guild-data deletion

Shipped on `wave/5-web-archive` (plan `docs/superpowers/plans/2026-10-09-wave-5-web-archive.md`, inline execution):

- **Lifecycle boundary.** `GuildConfig.configurationId` (DB-generated UUID, never updated) and a per-guild transaction-scoped advisory lock (`lib/guild-lock.ts`) taken first by every guild control-plane writer: setup-token issuance and exchange, `finalizeGuildArchiveConfig` (which now also covers first setup and rechecks the admin session under the lock), guild-data deletion, and every `lockClip`/`lockGuildConfig` transaction. Clip operations capture `configurationId` at claim and recheck it under the lock before each later write; a completion straddling delete-and-re-setup is discarded and its Discord pair deleted. The RED for that test was the stale request reporting `CLIPPER_ADDED` against the new configuration's Clip.
- **Deletion (5.4).** `POST /api/admin/guilds/:guildId/delete-data`: same-origin JSON, session for this guild, explicit `acknowledged: true`; one transaction deletes config, roles, Clips (tombstones and notification state), clippers, setup tokens and sessions; no Discord calls; clears the cookie.
- **Archive (5.1–5.3, F.5).** Cursor-paginated ACTIVE reader in one REPEATABLE READ snapshot over the new `clips_guild_status_created_idx`; a bounded content route (≤20 ids, all resolved against this guild's ACTIVE rows before any fetch, ≤4 concurrent, two reads per row for content and reply/original availability); the clip card; Screen D.
- **Screen E and routing.** Settings page with two-step deletion; a configured guild's `/setup` link opens Screen E; 설정 변경 opens a session-based edit (`/admin/:guildId/setup`) that returns with the saved toast; Screen C links to the web archive and settings; #59 (refusal links to the archive) and #58 (deleted archive channel flagged with 누락, Ori's copy) closed. `k8s/deployment.yaml` now rolls out with `Recreate`.

Rulings made during execution (all in the plan ledger; decisions D1–D9 are in the plan):

- The Prisma CLI here has no `--shadow-database-url` for `migrate diff`; the migration was checked with `--from-config-datasource` against the migrated local DB ("No difference detected").
- An existing race test's `pg_stat_activity` probe was widened to accept a `pg_advisory_xact_lock` waiter, as the plan anticipated.
- The React compiler lint (`set-state-in-effect`) rejected the plan's archive-loading `useCallback`; restructured to apply results only from promise callbacks.
- `/setup/data` now projects config to `{archiveChannelId, allowedRoleIds}`: adding `configurationId` to `GuildArchiveConfig` had started sending it to the browser.
- A deleted archive channel is not prefilled, so a save cannot resubmit an id Discord no longer has.
- Removed SetupFlow's ScreenB `key` and its comment and ScreenC's "web archive is cut" comment — both provably false after D1. Updated one existing assertion that pinned Screen C's old Discord-channel link.

Responsive pass (local dev, real Postgres, seeded session; Discord deliberately unreachable): `/admin/:g/archive`, `/admin/:g/settings`, `/admin/:g/setup` and an other-guild session at 1280/960/640/390 px — `scrollWidth === clientWidth` at every width (the probe was checked against an injected 900px element, which it reported). Screen E stacks to one column, the confirm panel and 4 consequence rows render, 삭제 실행 is disabled until acknowledged; an other-guild session renders the session-expired screen. **Not checked locally**: Screen B's edit form (its data load needs Discord, so it showed the load-error screen) and a ready card with real long code/URLs — both move to the live checks.

Deferred minors: the Callout primitive's tag column wraps `오류` onto two lines at 390px (pre-existing, visible in Wave 4's screenshots too); a per-row retry is not aborted on unmount (its result is applied to an unmounted component's discarded state, harmless).

### 2026-10-09 — Wave 5 review fixes and the #58 exception

The whole-branch review found no Critical issues. Fixed test-first: a cursor past year 9999 made Postgres reject the cast and the page 500 instead of recovering; one clip leaving ACTIVE after render turned the whole page's content batch INVALID (now such ids are skipped, no Discord call, per-row 오류); a captured "no configuration" was not rechecked under the lock (now compared as nullable). Ori chose to allow moving off an archive channel Discord confirms gone even with live Clips (#58 otherwise dead-ended at the live-Clips refusal) — recorded in the restoration design's 2026-10-09 decision. The cross-guild cookie landing found by the same review is #62. Review minors are listed in the PR #61 body.


Known limitation, accepted by Ori 2026-10-09: after moving off a deleted archive channel, Clips archived there stay ACTIVE and show `누락`; clipping one of those source messages again only adds a clipper (no new copy is posted). Recovery today: every clipper unclips (record cleared, then a fresh clip reposts), or guild-data deletion. Remove from Clip Archive tombstones the message instead. Reposting a confirmed-missing copy on re-clip is "ambient reconciliation", deferred to P1 as #63.

### 2026-10-09 — #62 fixed in PR #61

A fresh `/setup` link now exchanges its own token even when a live admin session already exists, so a guild-A session can no longer hijack (or, with the 15-min token vs 30-min session, block) a guild-B link. The session alone is trusted only on a reload of a link this tab already exchanged (a `sessionStorage` marker) or on a retry after an exchange whose response was lost. Exchange-first was tried first and reverted: it reordered every call in SetupFlow's 14 race tests. The landed version changes only the "session found" branch; three tests that encoded the old "live session ⇒ don't exchange" behaviour were updated to the new guarantee (exchange exactly once), and seven save-path tests gained an exchange stub. Cost: a used link opened in a new tab (no marker) shows Screen A instead of reusing the session. Mutation-checked: disabling the marker fails the reload test.

## 2026-10-09 — Wave 5 live checks, and the launch fixes they surfaced

Live checks for PR #61 ran on `sha-1c78a43`, test guild `testa`. Checks 1–9 pass. Checks 10 (#62 across two servers) and 11 (guild-data deletion) are pending. Findings:

- **Burst clipping fails some clips.** Clipping about 20 messages within two minutes logged 10 `clip.archive_failed` lines, all `ARCHIVE_CREATE_RETRYABLE`, covering 8 messages; production shows 21 ACTIVE and 7 FAILED rows.
  - Every failure ended in a clean FAILED row, no orphan provenance message was left in the archive (checked by Ori), and a retry recovered.
  - The cause is unconfirmed, because the log keeps only the code: a 429 still rate-limited after 3 attempts, a 5xx, or a 10 s timeout. Filed #64 to log the status and Discord code. One Screen D card showed a transient `오류` in the same session; `다시 시도` loaded it.
- **The access-error check needs the bot's member override.** Denying `READ_MESSAGE_HISTORY` on every role changed nothing, because Clip creates its archive channel with a member override for the bot that allows `VIEW_CHANNEL`, `SEND_MESSAGES` and `READ_MESSAGE_HISTORY` (`app/setup/save/route.ts`). Discord applies member overrides after role overrides.
  - The corrected Wave 6 step: deny `READ_MESSAGE_HISTORY` on the Clip bot member's entry, or remove that entry, then restore it.
  - Ori removed the entry, Discord answered Missing Access, and Screen D showed the access `오류`.
- **The commands existed only in the test server (#67).** Plan Task 1.3 registered to the test guild "first", and no later task registered the commands for every server, so any other server that installs Clip had no `/setup`.
  - Fixed with `--register --global`, which registers the commands application-wide and then clears the test guild's own copies.
  - Discord's current docs give no propagation time for global commands. The script's "up to an hour" comment is unverified.
  - #67 stays open until the command has run against production and a second server shows `/setup`.
- **Screen B overflowed below about 608px (#65).** Its page is a flex column, so the form's fixed 560px width is a cross-axis size that never shrinks. Screens A and C are flex rows, where the card shrinks, so the widths that looked suspicious in the code were not a problem there.
  - Probe (local dev, Discord responses stubbed in the browser): every element is checked against both viewport edges, because content that spills past the left edge never counts toward `scrollWidth`. The probe reports an injected 900px element.
- **Korean callout tags wrapped one syllable per line (#66).** The tag was a shrinkable flex item, and Hangul may break between any two syllables. It reproduced only once Screen B was narrow: the `누락` tag measured 29px before the fix and 15px after.

## 2026-10-09 — deploy image selection scripted; full CD deferred

- **The problem:** every deploy so far meant manually finding the merge commit's `release` run and copying its `sha-<7>` tag into `CLIP_IMAGE`. `scripts/release-image.sh` now does that selection. It refuses if the newest push-to-`main` release run is still running or failed, rather than falling back to an older image.
- **Full CD was considered and deferred (Ori, 2026-10-09).** With Wave 6 and Wave 7 left, maybe 3–5 deploys remain, and the setup would cost too much for that:
  - a Tailscale OAuth client and ACL so GitHub's runners can reach the cluster;
  - a ServiceAccount token limited to the `clip` namespace, stored as a GitHub secret;
  - a new path into the cluster for anything that reaches `main`.
- **If deploys become frequent:** Ori's preferred shape is tag-based, with `main` deploying only when a prod tag is pushed. That keeps an explicit release step separate from merging.
- **Command registration is not part of a deploy.** It only reruns when `lib/discord/commands.ts` changes (#67).

## 2026-10-10 — live check 10, and setup links decided by the server (#72)

The Wave 5 live checks finished on `sha-51d55eb`. Checks 1–9 and 11 pass, as do #67 and the 390px recheck. Check 11's database half: zero `testa` rows in clips, clippers, configs, roles and sessions. Check 10 (#62) passed its stated criterion, a fresh link opens its own server, but Ori found two related bugs.

1. **Re-opening a used link failed.** Re-clicking a link after closing its tab showed Screen A, despite a live login for that server. This was the trade-off #62 had accepted, and it turned out to be common in real use.
2. **A reload could show another server.** Reloading A's tab after B's link replaced the browser's single session showed B's form under A's link.

**Root cause:** the tab decided whether to trust a found session, using a per-tab sessionStorage note, but a tab can't tell which server a link belongs to. Ori also reported a "case 1" (making B's link expires A's). It was a false alarm: no code path revokes tokens on issue, and it didn't reproduce.

**Fix (approved by Ori, 2026-10-10):**
- The exchange answers 204, minting nothing, when a used token is inside its lifetime and the request carries a live session for the token's own server and user.
- The tab drops its note and always asks the exchange, unless this mount already spent the token.

**Verification:**
- Server tests cover the reopen and its five refusals: another server's login, another user's login, no login, an expired login, and an expired link. They were mutation-checked: dropping the server/user match fails the cross-server and cross-user tests.
- The UI reload test rendered "Guild B" before the fix.
- A browser run against a local dev server with real exchanges confirmed the re-click, the reload and #62.

**Ruling:** a re-open also requires the link itself to be inside its 15-minute lifetime, so a used link stops working when its expiry passes, even with a live session. That matches the setup copy, which promises a 15-minute link.

**Instrument note:** the first local reproduction showed Screen A for every fresh link. The cause was the probe, not the app. A Playwright `response` handler recorded the cookie-to-server map after an `await`, so the flow's next `/setup/data` call arrived before the mapping existed. Intercepting the exchange with `route.fetch()` removed the race.

## 2026-10-10 — #72 deployed and verified live; the reload guard moved to the guild

PR #73 merged as `b380be6` and is deployed as `sha-b380be6`, with no pending migrations.

**A review-round change after the entry above:** the exchange no longer answers a re-open with 204. Both successes, minting and re-opening, answer 200 `{ guildId }`, and only a mint sets the cookie. The tab shows setup data only when `/setup/data` names that same guild; otherwise it shows Screen A. This closed a race the per-mount rule left open: if another tab's link replaced the session after this tab's exchange, this tab's next load would have shown the other guild's form.

**Live checks, run by Ori on production within 15 minutes of `/setup`:**
1. Re-clicking a used link after closing its tab opens the setup form.
2. Reloading A's tab after B's link opened in another tab shows Screen A (관리자 세션이 만료되었습니다), not B's data.

**Issues:** #72 closed by the merge. #58 was closed against `2b8dfc0` and `be727aa`, and #59 against `2b8dfc0`. #62, #65, #66 and #67 were already closed.

**Not fixed here (#74):** `/setup/save` still takes the guild from whichever session the cookie holds. A save from a form loaded before another tab replaced the session would write to the other guild. The setup form and the settings edit page are both affected.

## 2026-10-10 — #74 fixed and verified live: a save names the guild its form shows

PR #76 merged as `fee7cff` and is deployed as `sha-fee7cff`, with no pending migrations.

**Fix:** the `/setup/save` body requires `guildId`, the guild the form was loaded for. The session's guild stays authoritative: a body guild that differs from it answers 401, the same as an expired session, before any Discord call or database write. A missing `guildId` answers 400. Client and server ship in one image under a Recreate rollout, so no backward compatibility was kept for bodies without it.
- The setup form (Screen B) shows Screen A on a 401 save instead of the save-failed callout, since a retry would be refused again.
- The settings edit page shows the expired screen when loaded data names another guild than its URL.

**Review round (CodeRabbit):** the edit page sent its URL's guild, so a form still showing the previous guild after an in-place guild change would have saved the old values to the new guild. It sends the guild of the data it renders instead (`2d9f765`). CodeRabbit's suggested loading reset was not added; the server's refusal covers it.

**Verification:** 6 tests failed with `main`'s app code before the fix, and the review-round test failed with `g2` in the body before its change. Lint, 554 tests and the build pass.

**Live check, run by Ori on production:** with A's settings edit page open in one tab and B's fresh `/setup` link opened in another, saving in A shows the expired screen. B's settings are unchanged and no channel was created in B.

**Issues:** #74 closed by the merge.

## 2026-10-11 — Wave 6 part 1: verification found a P0 gap, and the fix for it had two of its own

Branch `wave/6-verification`. Ori approved splitting the wave. Release images build only from `main`, so this part ships first and the manual runs test it. 7.1, 6.4, the 6.1/6.3 results and #63 follow on a second branch.

**Shipped on the branch:** #64 failure-class logging, #60 managed roles, 6.2 service-level races (#36), the F.6 design guard (#43) with the token refactor it forced, and #78.

**6.2 found #78.** A Clip left DELETING after a failed final delete, or PENDING after a dead creator, had no member action that converged it. Clip and unclip both answered success forever. The August entry carried both to "reconciliation", which was never built. Spec §9.10 requires recovery, so Ori chose to fix it in the wave.

**The fix:** a 5-minute wall-clock lease on `Clip.updatedAt`. A later clip or unclip claims a stale PENDING/DELETING row with one conditional update under `lockClip`, then finishes the creation or deletion.
- The implementer found my first design missed DELETING with zero clippers. The member retrying their unclip landed on `NOT_CLIPPED` before any takeover could run. Ruling: take over there too, still replying `NOT_CLIPPED_BY_USER`, and never for PENDING.
- The independent review found two Important defects in the lease. A stalled finalizer could clear and delete a pair written by a later lifecycle (I1). `markActive` from DELETING could overwrite ids that still addressed an undeleted pair (I2). Both orphan a live pair in Discord. Fixed in `5df94c5`: the finalizer touches nothing when the row holds a pair it was not sent, and `markActive` applies only over null ids.
- The lease assumes every status write refreshes `updatedAt`. Prisma applies `@updatedAt` on `updateMany`, and a test now pins this.

**F.6 rulings:** Tailwind is gone, so the brief's Tailwind checks were dropped. The string tables are `lib/ui/copy.ts` and `lib/discord/copy.ts`. Comments are exempt from the Hangul check.
- The guard found 17 measured px values. Under DESIGN_RATIONALE §10.7 they became cited tokens, pixel-identical.
- It found two Korean literals. The `채널 관리` label moved to `WEB_COPY`, since it is a substring of the handoff. The site description moved to `WEB_COPY_AUTHORED`: Claude wrote it in the scaffold, and Ori approved it verbatim today.

**Not fixed, deliberately:**
- Screen D logs one `source_read` line, code 10008, per deleted original on every page load. That is noise, not a failure.
- A stale or managed role in a save shows the generic save-failed callout. A specific message needs new Korean copy.
- Review minors:
  - `lint-design.ts`'s `tokens.css` path check is dead, since the file is outside the scanned roots.
  - The `--faint` rule accepts `:not(:disabled)`.
  - A stranded row recovers only when someone next clips or unclips that message.
- After an I2 loss, the reply carries the pair pending deletion. Only `kind` is read.

**What the corrections say about the method:** the lease was designed by the same agent that wrote the plan. Its three defects were found by the two parties who had not designed it: the implementer (the zero-clipper DELETING branch) and the independent reviewer (I1, I2). Mutation-proven tests written with a design prove the windows the designer pictured. They say nothing about the rest. A Wave 6 snapshot entry recording this was appended and then reverted in the review round: `docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md` is the frozen 2026-08-20 record (CLAUDE.md), and the orchestrator had worked from a stale reading of that rule.

## 2026-10-12 — Wave 6 part 2: the 7.1 sweep and the Playwright suite

Branch `wave/6-verification-2`. It opens before Ori's 6.1/6.3 runs, so those runs and the e2e run measure the final UI. #63 and the run results follow in a last PR.

**7.1 (#39) sweep:** a static audit, a WCAG contrast computation from `tokens.css`, and a live Playwright pass at 1280/960/375 against a seeded local dev server. Discord calls failed locally, so Screens B, C and the edit page ran on browser-stubbed client data.
- Passed as built: visible focus, labels, keyboard use including the role multi-select, text tags, consequence copy, `--faint` only on disabled controls, no horizontal page scroll, the ≤640/≤960 rules, and long code staying inside `overflow-x: auto`.
- Fixed:
  - Focus is kept through the deletion flow (open, cancel, failure).
  - Screen B's channel error and the load-error screen are alerts.
  - Save stays disabled while the channel error shows (handoff line 158).
  - Screen C's heading takes focus after setup.
  - A refused save focuses the channel select.
  - `삭제 실행` is the handoff's solid danger button.
- **Contrast:** every text pair passes AA. Control boundaries measured 1.26–1.55:1 against the 3:1 that WCAG 1.4.11 requires. Ori chose to change the visuals, recorded in DESIGN_RATIONALE §17: `--control-border`, a `--focus` focus border, and `--error-control-border`.
- **Instrument note:** the before and after screenshots of Screen B looked identical to the eye at review scale. Sampling the border pixels (47,51,57 → 98,103,109) confirmed the change; the screenshots alone did not.

**6.4 (#38):** `@playwright/test`, with four flows against `E2E_BASE_URL`. It is not in the merge gate.
- Sign-in spends real setup tokens issued by `scripts/e2e-seed.ts` through the app's own service.
- The configured-guild setup flow re-saves the current values. The seed refuses a `--user` other than the configurer, so `configuredByUserId` is never rewritten.
- The deletion spec aborts `/delete-data` in the browser, an interlock Ori approved, and never clicks `삭제 실행`.
- Locally 7 of 8 pass. The setup spec needs a real bot token for `/setup/data`.

**Deferred:**
- Safari does not make scrollable `<pre>` focusable.
- At 375px the identity bar wraps a long guild name into a narrow column.
- The light theme has no `--focus` override (§17).
- The seed header's local recipe assumes `.env` points at the dev database.

## 2026-10-12 — #63: repost a confirmed-missing archive copy on re-clip

Branch `feat/63-repost-missing-copy`. Built before Ori's 6.1/6.3 run on `sha-cdcabaf`. It merges only after those results are recorded, so the checklist evidence describes one build.

**Why the trigger is sound:** a Clip row stores no archive channel, so the forward is read in the current `GuildConfig.archiveChannelId`. That is safe only because the setup save refuses to repoint while live Clips exist unless Discord confirms the old channel is gone (`app/setup/save/route.ts`, #58). Only 10008/10003 count as missing, through the same `isUnknownTarget` predicate Screen D's `누락` uses.

**Ordering ruling:** the plan's Task 8 text put "delete the old pair" both after and before the swap. The orchestrator ruled: create the new pair, swap under the guild and row locks (ACTIVE and both old ids), then delete the old pair only if the swap applied. If the swap is lost, delete only the new pair. Swap-first is the only order in which a false "missing" can never destroy a real copy.

**Reply ruling:** when the swap is lost, the reply reuses the publish path's `lostPublishReply` instead of always returning the usual success reply. Read literally, the plan would have sent success copy after an author removal had dropped every clipper.

**Known limits:**
- A repost does not re-add the 📎 marker or re-notify the author.
- A missing provenance line whose forward survives is not detected.
- A repost whose source is now unreadable still replies success and logs `clip.repost_failed`.
- Every re-clip of an ACTIVE Clip costs one Discord GET.

**Deferred minors (review):**
- No test pins the ACTIVE-only trigger for a DELETING Clip inside its lease that still holds ids. The swap predicate still refuses it; only wasted calls are at stake.
- `clip.archive_check_failed` carries no guild or source key.

## 2026-10-13 — Wave 6 live run (6.1 matrix, 6.3 scenarios) on `sha-cdcabaf`

Ori ran `docs/tasks/wave-6-manual-checklist.md` in a fresh guild (`test2`), with the orchestrator walking it row by row. The full row table and 68 screenshots are in `docs/evidence/wave-6/` (`RESULTS.md`).

**Permission matrix, measured:**

| Permission | Where | Measured without it |
|---|---|---|
| `MANAGE_CHANNELS` | server | Clip and Unclip work (P4). "Create new" setup fails with only the generic save error (P6, #85). |
| `VIEW_CHANNEL` | source | Clip refused (`invalidTarget`), row `FAILED` (R1). |
| `READ_MESSAGE_HISTORY` | source | The same (R2). Steady-state, not bootstrap. |
| `VIEW_CHANNEL` | archive | `transientFailure`, `provenance_post 403/50001` (R3). |
| `SEND_MESSAGES` | archive | `transientFailure`, `provenance_post 403/50013` (R4). |
| `ADD_REACTIONS` | source | Clip succeeds; only the 📎 is missing (R5). |
| Message Content Intent | application | Clip refused (`invalidTarget`) (R6). `160014` is not provable from the log (#86). |

**Scenarios:**
- Every scenario passed except 17b (poll, #84).
- Scenario 2 passed only after a workaround: five `FAILED` rows from the R rows blocked the repoint (#83). Unclipping each failed message cleared them.
- The DM remove button was run as its own row (10b), since scenario 10 used the context command.
- Scenario 15 passed on 21 clips. Screen D then failed rows with Discord `429` during ordinary paging and filtering (#82), which is the most visible defect the run found.
- The burst showed no archive failures, but two people clicking is not concurrency evidence. That stays with the real-Postgres integration tests.

**Instrument notes:**
- `#clip-archive` carries a **member** overwrite for the bot, created by setup. Denying the Clip *role* there changes nothing, so R3 and R4 had to edit the member entry. A role-level deny would have produced a false pass.
- The P3 "no DM" scare was the wrong DM thread on screen. The log line `clip.author_notified` (written only after Discord accepts the DM) settled it before any code was suspected.
- Two orchestrator predictions were wrong and are recorded as such:
  - "no second DM for the same author": §11.1 is per canonical archival, not per author;
  - "DMs-off gives `50007`": the measured code is `50278`.
- The poll finding came from reading `FORWARDABLE_MESSAGE_TYPES` before the row was run. A poll is type `0` with a `poll` field, so the type check cannot catch it.

**Fix order agreed with Ori:** #82, #83 and #84 before 10-31. #86 can ride along. #85 waits on Korean copy. #87 is polish.

**6.4 e2e on `sha-cdcabaf` (guild `test2`, 21 clips), first runs:**
- Run 1 never seeded: `pnpm install` does not generate the Prisma client, and `eval "$(seed)"` swallows the seed's failure. The suite then ran with no tokens; only "unknown token opens Screen A" passed. Nothing reached the database.
- Run 2 (seeded): 5 passed. "the archive list renders" failed with 6 of 20 cards showing `다시 시도` on one cold page load. That is #82, reproduced by the suite. Pagination and channel filter were skipped by serial mode.
- So the production recipe moved into `scripts/e2e-prod.sh`, run by Ori. It does one process: port-forward, secrets in its own environment only, generate if missing, a seed whose failure stops the run (`seed="$(...)"`, not `eval "$(...)"`; checked: the eval form continues past a failed substitution under `set -e`), suite, and teardown. It refuses a checkout whose `app/`, `lib/` or `prisma/` differ from the deployed sha.
- Run 3, the script's first production run (`bash scripts/e2e-prod.sh 1559501336641404960 -g "pagination|channel filter"`): 2 passed. Pagination keeps `before=`/`after=` in the URL, and the channel filter keeps `channel=`. Net on `sha-cdcabaf`: 7 of 8 pass. The one failure is #82.

## 2026-10-13 — #63 verified live on `sha-4d28e3d`

Ori re-clipped the scenario-17 C (20:57, `1559535512715534398`) at 22:22 in `test2`. Its forward was gone, leaving its provenance line alone in the archive. The reply was `이미 보관된 메시지입니다`. A new provenance-plus-forward pair was posted at the bottom of `#archive-existing`, the old lone provenance line was deleted (the top now reads A, B, D), and Screen D's C row shows `C` instead of `누락`. Evidence: `docs/evidence/wave-6/63-*.png`.

A successful repost writes no log line; only `clip.repost_failed` and `clip.archive_check_failed` exist. Added to #87.

A first attempt clipped the burst "C" (21:06) instead, which has a live forward, so nothing was reposted. That was the right behaviour for the wrong message.

## 2026-10-13 — Wave 6 findings: #84, #86, #83, #82 on `wave/6-findings`

**#84 (poll):** Discord's gateway docs exempt "content of the message a message context menu command is used on" from the Message Content intent. So `data.resolved.messages[target]` carries `poll` even with the intent off, and checking the payload before `service.clip` is sufficient. Mapping `forward_post` `50035` to "target unavailable" was rejected: `50035` also fires on bad payloads we build ourselves. Side effect: the forwardability check runs before authorization, so a member without the role who clips a poll is told it can't be archived rather than told they lack permission.

**#83 (repoint guard), a plan that would have been wrong:** the first plan was to stop counting `FAILED` rows with no archive ids. The implementer traced the re-clip path and stopped, as briefed: a `FAILED` re-clip reads the archive channel in one transaction, posts with no lock held, and goes `FAILED → ACTIVE` (there is no `FAILED → PENDING`). `publishArchive` rechecked only `configurationId`, which a repoint does not change. Narrowing the guard alone would therefore have let a repoint commit during the post and publish `ACTIVE` ids that live in the old channel, which is C3 again. A probe on real Postgres confirmed that the row stays `FAILED`, with no ids, for the whole post window. The fix Ori chose (option 1 of 3): `lockClip` also rechecks `archiveChannelId` under the guild lock, and a mismatch takes the lost-publish path (delete the pair from the channel it was posted into, retryable failure). A `PENDING` row still triggers the "messages are archived" refusal, and that copy stays wrong for it. Changing the copy needs Ori's Korean.

**#82 (Screen D 429):**
- Get Channel Messages returns full message objects, `message_snapshots` included. Per-route limits are keyed on `channel_id`, so every forward read on a page shared one bucket.
- A page is ordered by `created_at`, not by forward id. A channel filter, chatter in an existing channel, or a #63 repost can spread a page's forwards across the channel, so the fix is bounded rather than "one request": one history read (`after` = lowest forward − 1, `limit=100`), with a per-row fallback for anything it does not list.
- Absence never means missing. Without Read Message History, Discord returns an empty list.
- Source reads are unchanged (Ori's option A): 20 per page, mostly in one source channel. A failed source read degrades to `original: 'unknown'`, not `오류`, so the page should render clean. Whether those 429s still slow it is unmeasured until the deploy and the e2e re-run.

## 2026-10-14 — 6.4 e2e on `sha-9bce61c`: #82 holds, the suite does not go green

Ori ran `bash scripts/e2e-prod.sh 1559501336641404960` (guild `test2`, 21 clips) after deploying #89.

- **Run 1:** 7 of 8 passed. "the archive list renders" passed in 8.5s with no retry buttons, so #82 is fixed on production. "a valid setup link opens setup" stayed on `/setup/<token>` past the 5s window, and its snapshot was an empty page, still loading. Run on its own straight afterwards (`-g "valid setup link"`), it passed in 4.7s.
- **Run 2:** 7 of 8 passed. The archive list passed again (8.9s) and setup passed. "the channel filter narrows the list" did not reach `?channel=` within 5s: the snapshot still showed `전체` with every card loading. Deletion took 16.0s, against 1.0s in run 1.
- Nothing on the setup or settings paths changed between `cdcabaf` (setup green) and `9bce61c`.

**Reading:** two different failures in two runs, both a server-rendered navigation outlasting 5s. #38 stays open, and the gate is not moved by re-running until one run happens to pass. The hypothesis is that unlogged 429 retries happen in the server-side Discord calls each render makes. Screen D makes `/guilds/{id}` and `/guilds/{id}/channels` on every navigation. The REST client sleeps up to 5s per retry and logs nothing. Since it could be neither confirmed nor refuted from the logs, #90 adds the instrument first; timeouts are not raised.

**Process slip:** the deploy command in the session summary pointed at `scratchpad/deploy.sh`, a file that no longer existed. The deploy was rebuilt from the repo's own `scripts/release-image.sh` and `scripts/render-k8s-deployment.sh`. A committed `scripts/deploy.sh` is proposed separately.

**#90 instrument and how to read it:** each retried 429 logs `discord.rate_limited`, and every Discord request that takes 1s or longer, retries included, logs `discord.slow_request` with its outcome. The second line exists because the review pointed out an asymmetry: retry lines alone could confirm the 429 hypothesis but never refute it, since a slow answer or a timeout swallowed by `fetchOrNull` left no trace. The lines carry no timestamp, so read them with `kubectl -n clip logs -f deploy/clip -c clip --timestamps`, started before the run.

**Found, not fixed (outside #90):** `DiscordApiError`'s message is `Discord ${method} ${path} failed …`. For `patchFollowupMessage` that path contains the interaction token. Nothing in the repo logs `error.message`, but an unhandled error that reached Next's own logger would print it.

## 2026-10-14 — 6.4 e2e on `sha-43fc2df`: the #90 lines name the cause

Ori deployed `sha-43fc2df` (#90's logging) and ran the full suite with `kubectl -n clip logs deploy/clip -c clip --timestamps` afterwards. 7 of 8 passed. "a valid setup link opens setup" failed again; "the archive list renders" passed, so #82 still holds.

What the log window (07:28:05–07:28:29) shows:
- 181 `discord.rate_limited` on `/channels/{id}/messages/{id}`, bucket `d2d6d106`, scope `user`. These are Screen D's source-message reads: 20 per page, all in one source channel, so all in one bucket.
- 81 `archive.content_read_failed` with step `source_read` and status 429: those reads still lost after three attempts.
- 93 `discord.slow_request`.
- `/guilds/{id}/channels` (bucket `a66d55b1`) was also rate-limited, with `retryAfterMs` at the 5000 cap. The last `discord.slow_request` for it ended with 429 after 10815ms at 07:28:29.4. That is the setup page's channel read, and it is the failure: the setup test had already passed its 5s window. Screen D and Screen E read `/guilds/{id}/channels` on every render, which loads the same bucket.
- `⨯ Error: The destination stream closed early`: Discord reads on the server continue after the browser has navigated away.

**Reading:** the hypothesis from the `sha-9bce61c` runs is confirmed. A render waits out 429s server-side, and Screen D's per-row source reads plus each render's channel-name read saturate the buckets that setup also needs. Three changes, Ori approved 2026-10-14:
1. When `retry_after` exceeds the 5s cap, fail at once instead of sleeping 5s and asking again. Discord has said the wait is longer.
2. Cache guild display data (guild name, channel names) for about 60s, across requests. This pulls a product-spec P1 item (line 565, short-lived server-side cache) into P0, for display lookups only, and amends restoration spec line 91.
3. Drop Screen D's source-message reads for P0. Cards lose the reply author line and the verified-unavailable tag (`원본 메시지를 찾을 수 없습니다.`); the original link is always offered. This amends restoration spec lines 81 and 151.

## 2026-10-14 — deploy.sh revision pin failed on its first real run

The first real `scripts/deploy.sh` run failed after the apply:

```
deployment.apps/clip condition met
error: desired revision (12) is different from the running revision (13)
```

**Root cause:** the Deployment uses `strategy: Recreate`. The controller's recreate path scales down the old ReplicaSets, then syncs status, which sets `observedGeneration` to the new generation. Only after the old pods are gone does it create the new ReplicaSet and bump the `deployment.kubernetes.io/revision` annotation. So the script's `kubectl wait` on `observedGeneration` returned, the revision read that followed got the old revision, and `rollout status --revision` pinned to it failed.

**Fix:** no `wait` and no revision read. Plain `kubectl -n clip rollout status deploy/clip --timeout=5m` waits for `observedGeneration` itself and then for the updated pods. The generation re-check against `applied_generation` stays and is what catches a `kubectl rollout restart` overlapping the deploy; a restart keeps the image, so the image read-back catches only an overlapping deploy of a different image. `tests/scripts/deploy.test.ts` has a regression test whose stub kubectl reproduces the lagging annotation.

**Found, not fixed:** the verification procedure in `docs/02_CLIP_IMPLEMENTATION_PLAN.md` (around lines 242-284) does the same thing, `wait` on `observedGeneration`, then a revision read and `rollout status --revision`, and has the same race under `Recreate`.

## 2026-10-14 — 6.4 e2e on `sha-b845a59`: 8 of 8, #38 gate met

`sha-b845a59` (#96: fail fast on long 429s, a 60s display-lookup cache, no Screen D source reads) was deployed with `scripts/deploy.sh`. Its rollout check failed (entry above), but the rollout itself completed: Ori read back generation, observed generation and revision 13 and the image `sha-b845a59`. Ori then ran `bash scripts/e2e-prod.sh 1559501336641404960` (guild `test2`, 21 clips) while `kubectl logs -f --timestamps` captured the server log.

- 8 of 8 passed in 10.0s. The archive list rendered in 2.5s (8.5s on `sha-9bce61c`), and setup passed in 4.1s.
- The log had two matching lines, both from one archive-channel history read: a 429 asking for 661ms, retried once, then 200 after 1300ms. On `sha-43fc2df` the same patterns matched 181 retried 429s, 93 slow requests and 81 failed source reads. There were no give-ups and no `destination stream closed early`.

**Process slip:** #38 had already been closed on 2026-10-13 by the merge of #89, whose PR body linked it as closed, before its 8/8 gate was met. The gate is met now, and the evidence is on #38. Link the gate issue with "Refs" until the gate is met.

## 2026-10-14 — `sha-3ed1d60`: deploy.sh green, e2e 8/8, R1/R2/R6 codes measured

- `bash scripts/deploy.sh` ran clean end to end for the first time on `sha-3ed1d60` (#98, #99): apply, plain rollout status, generation re-check, image read-back, `deployed`. The #97 fix held under `Recreate`.
- `bash scripts/e2e-prod.sh 1559501336641404960`: 8 of 8 in 9.4s, the archive list in 2.4s. This is the second clean run in a row after #96.
- The R1, R2 and R6 re-runs give logged codes for the first time (`docs/evidence/wave-6/RESULTS.md`, "Re-run 2026-10-14"):
  - Source-channel VIEW_CHANNEL and READ_MESSAGE_HISTORY denies both fail `source_read` with `403`/`50001`.
  - Message Content Intent off fails `forward_post` with `403`/`160014`, after a successful source read.
  - The README's permission table and the note under it now cite these runs.
- The local test Postgres is recreated as `clip-pg` with `--tmpfs /var/lib/postgresql`, after Docker storage pressure removed the old container. It holds no data across restarts, so run `prisma migrate deploy` after each one.

## 2026-10-14 — PENDING refusal copy (#83 follow-up)

- **Defect:** a `PENDING` Clip blocked an archive-channel change like a live one, so Screen B told the admin to remove archived messages that did not exist. Worse, a `PENDING` row stranded by a crash is taken over only when someone re-clips the same message, so it could block the change forever.
- **Rule:** `findArchiveChangeBlocker` replaces `hasLiveClips` and returns `'ARCHIVED' | 'IN_PROGRESS' | null`. An id-less `PENDING` row blocks (`IN_PROGRESS`) only while `updatedAt` is within `STALE_CONTROL_STATE_MS` (5 min, now exported from `lib/clip/repository.ts` and shared with the service's takeover). Any row holding an archive id, and every other non-tombstone non-`FAILED` status, is still `ARCHIVED`. The route answers 409 `CLIP_IN_PROGRESS` or `LIVE_CLIPS`; the #58 gone-channel exception covers both.
- **Safety:** excluding a stale `PENDING` row is safe because a creator that is still alive and posts into the old channel is refused at publish. Both the first-clip and the takeover path reach the single `publishArchive` call, which passes `config.archiveChannelId` to `lockClip`, and `lockClip` discards the write when the configured channel changed. The caller then takes the pair down. `tests/clip/service.test.ts` ("a first clip that posted into a channel repointed after its lease lapsed...") proves it for a brand-new `PENDING` Clip; the existing FAILED re-clip test covers the other path.

## 2026-10-14 — `sha-9b9d0eb`: e2e 8/8 after the PENDING refusal

- Ori deployed `sha-9b9d0eb` (#106) with `scripts/deploy.sh`, which ran green, then ran `bash scripts/e2e-prod.sh 1559501336641404960`: 8 of 8 in 9.5s, the archive list in 2.4s, and setup with a save in 3.7s.
- This proves that the Screen B save path still works on the deployed fix. It does not exercise the new `CLIP_IN_PROGRESS` refusal, which needs a Clip mid-post during the save. The real-Postgres tests in #106 cover that refusal.

## 2026-10-14 — Test output was not pristine; the agent shell hid it

- **Instrument gap:** inside a Claude Code shell, Vitest 4 picks a reporter that hides what passing tests print. `pnpm test` looked clean there, but `pnpm exec vitest run --reporter=default` printed 33 `logClipEvent` lines, and CI showed them too. Any earlier "output pristine" claim produced in that shell is unverified. Check with `--reporter=default`, or read the CI log.
- **A real test defect behind the noise:** two `tests/setup/save-route.test.ts` tests say the auto-created channel is deleted, but the stub threw on `DELETE /channels/222`. The route took its cleanup-failure path, and the tests passed because they only checked that the call was made. The stub now answers the delete, and both tests assert that no `setup.archive-channel-cleanup-failed` line is logged. The failure path keeps its own test.
- The other leaks now capture `console.log` like their neighbours do, and they assert the line where it is an expected error.

## 2026-10-14 — Review follow-up: test guards and a pinned reporter

- **A gap the stub fix opened:** once the `beforeEach` stub answered `DELETE /channels/222`, a regression that deleted the new channel after a successful save passed silently. The review proved it by mutation: 47 of 47 passed with no output. Every successful create-destination save test now asserts that no `DELETE` was sent. Under the same mutation, 5 tests fail.
- The two auto-create cleanup tests now assert that nothing is logged at all, not just that one event name is absent.
- **The instrument gap is fixed at its root:** `vitest.config.mts` pins `reporters` to `default` (plus `github-actions` on CI, which Vitest adds there anyway). A plain `pnpm test` now shows passing-test output in every shell, so the `--reporter=default` workaround in the entry above is no longer needed.
- **Left as is:** `tests/discord/context-commands.test.ts` and `tests/discord/remove-button-interaction.test.ts` mute every `console.log` line before each test, as `tests/clip/service.test.ts` does. Every line muted today is informational, but a future error line in those 13 tests would pass silently.
