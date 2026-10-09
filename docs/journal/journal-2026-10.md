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
