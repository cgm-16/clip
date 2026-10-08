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
