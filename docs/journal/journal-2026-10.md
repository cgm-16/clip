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
