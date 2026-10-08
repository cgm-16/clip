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

Live checks, test guild `testa`, three accounts (A admin, B member, the bot), each confirmed against production rows, not only the screen:

1. Configured guild opens prefilled (existing channel, `#clip-archive` selected, saved role chips); a roles-only edit saved `manage servers` + `clip-test` and Screen C listed them. **Pass.**
2. B, holding only `clip-test`, clipped a message: row `ACTIVE`, both archive ids, B as clipper; two archive messages posted. **Pass.**
3. With `clip-test` taken from B: Clip refused and no row created; Unclip succeeded, both archive messages deleted, Clip and Clipper rows gone (last clipper, so no tombstone). **Pass.**
4. Existing `#clip-denied` with the bot role's `READ_MESSAGE_HISTORY` denied: save refused under `오류` with a `READ_MESSAGE_HISTORY` chip; config unchanged. The channel was deleted before its overwrites were re-read, so "overwrites unchanged" rests on the save-route tests (refusal path issues only GETs), not a live reading. The chip-removal announcement was heard with VoiceOver. **Pass.**

Found along the way, none caused by Wave 4 code:

- **Kicking the bot deletes its guild-scoped commands.** Re-inviting does not restore them; `scripts/register-discord-commands.ts --register` (with `.env` loaded) does. The bot's managed role also gets a new id on re-invite.
- **A deleted archive channel is a dead end in setup.** Ori had deleted the old `#clip-archive` while one Aug-20 clip was still `ACTIVE`. The fresh link prefilled the dead channel id, so the select showed only its placeholder with no `누락` explanation, and every destination change hit the `LIVE_CLIPS` refusal, which does not say which messages are live. Recovery needed a database query to find the message, then `Remove from Clip Archive` on it (deleting archive messages in a missing channel 404s, which the deleter already treats as gone). Fixing it needs new Korean copy; candidate issue for Wave 5 planning. Extends the deferred minor "deleted archive channel surfaces only as the generic save failure".
- **The bot's own managed role is selectable** in the role picker. No member can hold it, so selecting it is a no-op. Minor; could mark managed roles non-selectable like `@everyone`.
- My check-4 instructions said the refusal would carry `누락`; the design reserves `누락` for a missing archive copy, and `오류` is correct.
