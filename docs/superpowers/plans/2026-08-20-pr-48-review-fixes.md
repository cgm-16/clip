# PR #48 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Address the technically valid review threads on PR #48, preserve the two approved scope pushbacks, and leave the branch deployable and fully verified before its 2026-08-20 deadline.

**Architecture:** Five sequential commits isolate deployment rendering, Discord transport deadlines, setup/Clip database serialization, Discord setup lookups, and client-side setup recovery. Discord I/O remains outside PostgreSQL transactions; the database lock exists only long enough to make the GuildConfig read/Clip claim and setup recheck/config update mutually exclusive.

**Tech Stack:** Next.js 16.3.1 App Router, React 19, TypeScript, Prisma 7, PostgreSQL 17, Vitest, pnpm, Bash, Kubernetes.

**Spec:** CLAUDE.md; docs/01_CLIP_PRODUCT_SPEC.md; docs/06_DESIGN_HANDOFF.md; PR #48 review threads at https://github.com/cgm-16/clip/pull/48; Ori's approved 2026-08-20 review rulings recorded in this plan.

## Global Constraints

- Deadline: 2026-08-20 23:59 KST. Cut polish before correctness, consent, or deployment.
- Read AGENTS.md and CLAUDE.md completely before editing. For touched Next.js APIs, read the relevant guide under node_modules/next/dist/docs before editing.
- Make the smallest reasonable change. Do not refactor unrelated code, remove comments, add compatibility behavior, or change execution-neutral whitespace.
- Use apply_patch for content edits. Preserve surrounding style and every comment that is not proven false.
- Follow strict TDD for production behavior: write one failing test, run it and confirm the expected failure, implement only enough to pass, then rerun it. Concurrency tests use real PostgreSQL and deterministic barriers, never mocks or sleeps.
- Tests assert observable behavior at the project boundary. External Discord HTTP may use injected fetch doubles; database concurrency may not.
- Run the task's focused tests after each RED/GREEN cycle. Before each commit run pnpm lint, pnpm test against the real clip-pg database, and pnpm build. Output must contain no errors or warnings.
- Conventional Commits only, one logical commit per task. The controller supplies review and push actions; implementers do not push, reply on GitHub, resolve threads, or dispatch subagents.
- Keep all Discord I/O outside database transactions.
- Never log raw Discord message bodies, attachments, embeds, or arbitrary error objects. Use the SafeClipLog allowlist only.
- Do not vendor Pretendard, add a font dependency, or change font configuration. Ori rejected that review request because the deadline cannot absorb its time and cost.
- Do not restore role setup UI or rewrite final Korean role copy. Ori's recorded P0 decision intentionally ships admin-only clipping and defers matching role behavior to P1.
- Approved new Korean copy is exact: 채널을 선택하세요; 설정 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.; 다시 시도. Put it in WEB_COPY_AUTHORED and nowhere inline.
- Discord REST attempts time out after exactly 10,000 ms. Only HTTP 429 retries, using the existing maximum of three attempts; timeouts and 5xx responses do not retry.
- Deployment images accept exactly ghcr.io/cgm-16/clip:sha- followed by 7 to 40 lowercase hexadecimal characters. Both migrate and clip fields must equal the supplied released image.

## Review Thread Disposition

| Thread | Disposition |
| --- | --- |
| app/layout.tsx Pretendard | Push back: deadline/time/cost; no code change. |
| ScreenB empty channel option | Task 5. |
| SetupFlow initial load rejection | Task 5. |
| SetupFlow malformed save JSON | Task 5. |
| setup/save reconfiguration race | Task 3. Push back on a setup-only transaction as insufficient; implement shared serialization. |
| application ID used as member ID | Task 4. |
| stranded PENDING/FAILED recovery | Task 3 documentation and direct regression coverage; push back on the claim that recovery is absent. |
| role-copy mismatch | Push back: conflicts with approved P0 scope decision. |
| incompatible deployment image | Task 1. |
| unused roles lookup | Task 4. |
| REST timeout | Task 2. |

---

### Task 1: Render and validate the released deployment image

**Files:**
- Modify: k8s/deployment.yaml
- Create: scripts/render-k8s-deployment.sh
- Create: tests/scripts/render-k8s-deployment.test.ts
- Modify: .gitignore
- Modify: docs/02_CLIP_IMPLEMENTATION_PLAN.md

**Interfaces:**
- Consumes: tracked k8s/deployment.yaml containing exactly two __CLIP_RELEASE_IMAGE__ markers.
- Produces: scripts/render-k8s-deployment.sh IMAGE OUTPUT.
- IMAGE must match ^ghcr[.]io/cgm-16/clip:sha-[a-f0-9]{7,40}$.
- OUTPUT is written atomically only after the rendered manifest contains exactly two image values and both equal IMAGE.
- k8s/deployment.yaml remains intentionally non-deployable; only the generated file is passed to kubectl.

- [ ] **Step 1: Write the valid-render failing test**

Create tests/scripts/render-k8s-deployment.test.ts using Vitest plus node:child_process and node:fs. The test name is:

~~~ts
it('renders the released image identically for migrate and app containers', () => {})
~~~

Use image ghcr.io/cgm-16/clip:sha-7139b60 and a fresh directory from mkdtempSync. Execute the real script with execFileSync. Read the generated manifest and assert:

~~~ts
expect([...manifest.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((match) => match[1])).toEqual([
  'ghcr.io/cgm-16/clip:sha-7139b60',
  'ghcr.io/cgm-16/clip:sha-7139b60',
]);
expect(manifest).not.toContain('__CLIP_RELEASE_IMAGE__');
~~~

Clean the temporary directory in afterEach.

- [ ] **Step 2: Run the valid-render test and verify RED**

Run:

~~~sh
pnpm exec vitest run tests/scripts/render-k8s-deployment.test.ts -t "renders the released image identically"
~~~

Done-check: FAIL because scripts/render-k8s-deployment.sh does not exist. A syntax or fixture failure is not the expected RED.

- [ ] **Step 3: Add the non-deployable template markers and minimal atomic renderer**

Replace only the two existing sha-63a0ce1 values in k8s/deployment.yaml with __CLIP_RELEASE_IMAGE__. Preserve its existing comments, init command, probes, resources, secrets, and field order.

Create scripts/render-k8s-deployment.sh with the following implementation. Do not add the image-format guard until Step 6, so invalid image input has a real RED cycle.

~~~bash
#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 IMAGE OUTPUT" >&2
  exit 64
fi

image="$1"
output="$2"
template="k8s/deployment.yaml"

if [ ! -r "$template" ]; then
  echo "missing deployment template: $template" >&2
  exit 66
fi

output_directory="$(dirname -- "$output")"
if [ ! -d "$output_directory" ]; then
  echo "output directory does not exist: $output_directory" >&2
  exit 73
fi

temporary="$(mktemp "$output.tmp.XXXXXX")"
cleanup() {
  rm -f -- "$temporary"
}
trap cleanup EXIT

sed "s|__CLIP_RELEASE_IMAGE__|$image|g" "$template" > "$temporary"

if grep -Fq '__CLIP_RELEASE_IMAGE__' "$temporary"; then
  echo "unrendered deployment image marker" >&2
  exit 65
fi

rendered_images="$(sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]#]+).*/\1/p' "$temporary")"
expected_images="$(printf '%s\n%s' "$image" "$image")"
if [ "$rendered_images" != "$expected_images" ]; then
  echo "rendered manifest must contain exactly two identical Clip image values" >&2
  exit 65
fi

mv -- "$temporary" "$output"
trap - EXIT
~~~

Set only its executable mode with chmod +x scripts/render-k8s-deployment.sh.

- [ ] **Step 4: Run the valid-render test and verify GREEN**

Run the Step 2 command.

Done-check: one passing test; generated file has the released image exactly twice and no marker.

- [ ] **Step 5: Write invalid-input and atomic-output failing tests**

Add table cases for:

~~~ts
[
  'ghcr.io/cgm-16/clip:latest',
  'ghcr.io/cgm-16/clip:sha-ABCDEF1',
  'ghcr.io/other/clip:sha-7139b60',
  'ghcr.io/cgm-16/clip:sha-123456',
]
~~~

For every case, assert execFileSync throws and no output is created. Add a separate test that prewrites OUTPUT with literal preserve-me, invokes an invalid image, and asserts the file still contains preserve-me.

- [ ] **Step 6: Run invalid-input tests and verify RED then GREEN**

Run:

~~~sh
pnpm exec vitest run tests/scripts/render-k8s-deployment.test.ts -t "rejects|preserves"
~~~

Done-check RED: at least latest renders successfully. Add this guard immediately after assigning image and before reading or rendering the template:

~~~bash
if [[ ! "$image" =~ ^ghcr[.]io/cgm-16/clip:sha-[a-f0-9]{7,40}$ ]]; then
  echo "image must be a released ghcr.io/cgm-16/clip:sha-<lowercase-commit> tag" >&2
  exit 65
fi
~~~

Rerun and require all invalid cases to pass without creating or overwriting output.

- [ ] **Step 7: Update deployment instructions**

Add k8s/rendered/ to .gitignore.

In docs/02_CLIP_IMPLEMENTATION_PLAN.md, replace both the initial direct kubectl apply -f k8s/ step and the final grep-only image check. Render first, then apply the explicit tracked resources and the validated generated deployment:

~~~sh
git fetch origin main
CLIP_IMAGE="ghcr.io/cgm-16/clip:sha-$(git rev-parse --short=7 origin/main)"
mkdir -p k8s/rendered
scripts/render-k8s-deployment.sh "$CLIP_IMAGE" k8s/rendered/deployment.yaml
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/rendered/deployment.yaml
~~~

State that release CI must have published CLIP_IMAGE before rendering, k8s/deployment.yaml is a non-deployable template, renderer success precedes apply, and rollout verification must inspect successful migrate init-container completion.

- [ ] **Step 8: Verify and commit**

Run:

~~~sh
pnpm lint
pnpm test
pnpm build
~~~

Done-check: every command exits 0 with pristine output. Commit:

~~~sh
git add .gitignore docs/02_CLIP_IMPLEMENTATION_PLAN.md k8s/deployment.yaml scripts/render-k8s-deployment.sh tests/scripts/render-k8s-deployment.test.ts
git commit -m "fix(deploy): render a validated release image"
~~~

---

### Task 2: Bound every Discord REST attempt to 10 seconds

**Files:**
- Modify: lib/discord/rest-client.ts
- Create: tests/discord/rest-client.test.ts

**Interfaces:**
- Consumes: existing DiscordRestClient.request method and its current 429-only retry loop.
- Produces: a fresh AbortSignal.timeout(10_000) inside every internal HTTP attempt.
- Does not change DiscordRestClientOptions, retry counts, retry_after capping, error types, headers, request body encoding, or caller APIs.

- [ ] **Step 1: Write the fresh-signal failing test**

Create tests/discord/rest-client.test.ts. Spy on the real AbortSignal.timeout static method and return a new AbortController().signal per call. Inject a fetch implementation that returns 429 with retry_after: 0, then 200 with id: ok. Record each RequestInit.signal.

Test name:

~~~ts
it('starts each HTTP 429 retry with a fresh 10,000 ms abort signal', async () => {})
~~~

Assert the request resolves to the literal object, AbortSignal.timeout was called twice with 10_000, fetch was called twice, both signals are defined, and signals[0] is not signals[1]. Restore spies in afterEach.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

~~~sh
pnpm exec vitest run tests/discord/rest-client.test.ts -t "fresh 10,000 ms abort signal"
~~~

Done-check: FAIL because AbortSignal.timeout has zero calls and fetch receives no signal.

- [ ] **Step 3: Add the minimal per-attempt timeout**

In lib/discord/rest-client.ts add:

~~~ts
const DISCORD_REQUEST_TIMEOUT_MS = 10_000;
~~~

Inside the internal attempt function, create and pass:

~~~ts
signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
~~~

The expression must execute inside attempt, not once in request, so every 429 retry receives a fresh signal.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command.

Done-check: one passing test with two distinct signals and no retry-policy change.

- [ ] **Step 5: Add preservation tests for non-retry behavior**

Add:

~~~ts
it('does not retry a timeout rejection', async () => {})
it('does not retry a 502 response', async () => {})
~~~

For timeout, make the timeout spy return AbortSignal.abort(new DOMException('timed out', 'TimeoutError')) and make fetch throw init.signal.reason; assert the same error is rejected and fetch runs once. For 502, return a 502 Response; assert DiscordApiError with status 502 and one fetch. These preserve existing behavior and require no production branch beyond Step 3.

- [ ] **Step 6: Verify and commit**

Run:

~~~sh
pnpm exec vitest run tests/discord/rest-client.test.ts
pnpm lint
pnpm test
pnpm build
~~~

Done-check: all commands exit 0 with pristine output. Commit:

~~~sh
git add lib/discord/rest-client.ts tests/discord/rest-client.test.ts
git commit -m "fix(discord): bound each REST attempt"
~~~

---

### Task 3: Serialize setup reconfiguration with Clip claims

**Files:**
- Modify: lib/clip/repository.ts
- Modify: lib/clip/service.ts
- Modify: app/setup/save/route.ts
- Modify: tests/clip/repository.test.ts
- Modify: tests/clip/service.test.ts
- Modify: tests/setup/save-route.test.ts
- Modify: docs/journal/journal-2026-08.md

**Interfaces:**
- Produces:

~~~ts
lockGuildConfig<T>(
  guildId: string,
  fn: (tx: TxClient, config: GuildArchiveConfig) => Promise<T>,
): Promise<T | null>

finalizeGuildArchiveConfig(input: {
  guildId: string;
  archiveChannelId: string;
  configuredByUserId: string;
}): Promise<{ kind: 'SAVED' } | { kind: 'CONFLICT' }>
~~~

- lockGuildConfig issues SELECT 1 FROM guild_configs WHERE guild_id = the supplied guild ID FOR UPDATE inside an interactive transaction, reads config and roles with the same transaction client, and returns null without calling fn when the row does not exist.
- claimClip, hasLiveClips, and upsertGuildArchiveConfig gain internal transaction-client forms. No global Prisma call occurs inside a lock callback.
- ClipService.clip performs the config read, role authorization, and canonical claim under the same GuildConfig lock, then performs Discord I/O after commit.
- finalizeGuildArchiveConfig runs after Discord I/O. For an existing config it locks the same row, recomputes whether the channel changes, rechecks live Clips, and upserts within that transaction. First setup retains the existing no-row upsert path; simultaneous first setup is outside this review.
- If an auto-created destination loses the final recheck, the route best-effort deletes only that created channel and returns the existing 409 conflict whether cleanup succeeds or fails.

- [ ] **Step 1: Write the deterministic real-Postgres race test**

In tests/clip/repository.test.ts add:

~~~ts
it('prevents reconfiguration between a Clip config read and its canonical claim', async () => {})
~~~

Use a random guild, old channel, new channel, source message, and user. Warm two real pool connections using the existing Promise.all SELECT 1 pattern. Create two explicit deferred barriers with Promise.withResolvers or the file's local equivalent; do not sleep or make elapsed-time assertions.

Operation A acquires lockGuildConfig, asserts old channel, signals clipHasReadConfig, waits for releaseClipClaim, then calls the tx-scoped claim. Only after A signals, start operation B calling finalizeGuildArchiveConfig for the new channel. Before releasing A, use a separate real Prisma query plus Vitest's bounded condition waiting to observe in `pg_stat_activity` that another same-user backend is active, has `wait_event_type = 'Lock'`, and is running the `guild_configs ... FOR UPDATE` query. The condition timeout may fail the test but is not correctness evidence. Only after the actual blocked-lock condition is observed, release A, await both, and assert:

~~~ts
expect(claim.created).toBe(true);
expect(finalize).toEqual({ kind: 'CONFLICT' });
expect(persistedConfig.archiveChannelId).toBe(oldChannelId);
expect(await prisma.clip.count({ where: { guildId } })).toBe(1);
~~~

- [ ] **Step 2: Run the race test and verify RED**

Run:

~~~sh
pnpm exec vitest run tests/clip/repository.test.ts -t "prevents reconfiguration"
~~~

Done-check: FAIL because the shared lock/finalizer/transaction-client operations do not exist. After those interfaces compile, temporarily removing the GuildConfig `FOR UPDATE` must also fail because the blocked-lock condition is never observed (or because stale state wins); restore the lock before continuing.

- [ ] **Step 3: Implement the repository serialization boundary**

Follow lockClip's complete transaction pattern. Add only the lock and transaction-scoped operations required by Step 1. Keep external I/O forbidden from callbacks. Make finalizeGuildArchiveConfig return CONFLICT only when the locked config points at a different archive channel and a live Clip exists; otherwise persist and return SAVED.

- [ ] **Step 4: Run the race test and verify GREEN**

Run the Step 2 command.

Done-check: PostgreSQL row locking deterministically forces the claim to commit before final recheck, which returns CONFLICT and preserves the old destination.

- [ ] **Step 5: Add direct recovery regression coverage**

In tests/clip/service.test.ts add a parameterized real-Postgres test for PENDING and FAILED:

~~~ts
it.each(['PENDING', 'FAILED'] as const)(
  'allows the source author to remove an archive-less %s Clip and clear the live blocker',
  async (status) => {},
)
~~~

Seed the exact nonterminal state and clipper using repository operations, call real removeByAuthorOrAdmin as the source author, and assert the REMOVED_BY_AUTHOR tombstone, hasLiveClips(guildId) is false, zero Discord delete calls for an archive-less row, and no Clipper rows. This covers existing recovery behavior; record that it passes before production changes and perform the mutation check from writing-good-tests during self-review.

- [ ] **Step 6: Write route conflict-cleanup failing tests**

In tests/setup/save-route.test.ts add:

~~~ts
it('returns 409 and deletes a newly created channel when final reconfiguration conflicts', async () => {})
it('keeps the 409 result and safe-logs when created-channel cleanup fails', async () => {})
~~~

For the first, make channel creation return id 222 and the finalizer return CONFLICT. Assert status 409, exactly one DELETE /channels/222, and no old upsert call. For the second, make only DELETE reject with DiscordApiError. Capture log output and assert the SafeClipLog contains:

~~~ts
{
  event: 'setup.archive-channel-cleanup-failed',
  guildId,
  errorCode: String(error.code ?? error.status),
}
~~~

Assert it contains no Discord response body or arbitrary error fields and the HTTP result remains 409.

- [ ] **Step 7: Run route tests and verify RED**

Run:

~~~sh
pnpm exec vitest run tests/setup/save-route.test.ts -t "final reconfiguration conflicts|cleanup fails"
~~~

Done-check: current route unconditionally persists/returns success after Discord creation and has no cleanup branch.

- [ ] **Step 8: Integrate the lock in service and route**

Refactor ClipService.clip so its config read, authorization, and claim share lockGuildConfig. Carry only the committed result/config into existing Discord work.

Keep the setup route's early live-Clip check as a cheap optimization. Replace the post-I/O unconditional upsert with finalizeGuildArchiveConfig. On CONFLICT:

- delete only a channel created by this request;
- use DiscordApiError code/status or UNKNOWN in SafeClipLog;
- never throw cleanup failure over the 409;
- never delete an existing-channel destination.

- [ ] **Step 9: Run focused backend verification**

Run:

~~~sh
pnpm exec vitest run tests/clip/repository.test.ts tests/clip/service.test.ts tests/setup/save-route.test.ts
~~~

Done-check: all focused suites pass with real PostgreSQL; existing service result unions, Discord archive behavior, and early 409 tests remain unchanged.

- [ ] **Step 10: Correct only the stale journal conclusion**

Append an evergreen correction beside the journal entry that says PENDING/FAILED permanently strand setup. Record:

- PENDING does not automatically retry archive creation on a later Clip request;
- its existing clipper or source author/admin can remove the archive-less row/tombstone it;
- FAILED already retries to ACTIVE on a later Clip request and also supports removal;
- these statuses block channel reconfiguration while present, but not permanently.

Do not rewrite or delete historical evidence and do not change recovery semantics.

- [ ] **Step 11: Verify and commit**

Run:

~~~sh
pnpm lint
pnpm test
pnpm build
~~~

Done-check: every command exits 0 with pristine output. Commit:

~~~sh
git add app/setup/save/route.ts lib/clip/repository.ts lib/clip/service.ts tests/clip/repository.test.ts tests/clip/service.test.ts tests/setup/save-route.test.ts docs/journal/journal-2026-08.md
git commit -m "fix(clip): serialize setup reconfiguration"
~~~

---

### Task 4: Resolve the bot user and remove the unused roles lookup

**Files:**
- Create: lib/discord/bot-user.ts
- Modify: lib/discord/guild-lookup.ts
- Modify: app/setup/data/route.ts
- Modify: app/setup/save/route.ts
- Create: tests/discord/bot-user.test.ts
- Modify: tests/discord/guild-lookup.test.ts
- Modify: tests/setup/save-route.test.ts

**Interfaces:**
- Produces:

~~~ts
getDiscordBotUserId(options: DiscordBotUserLookupOptions): Promise<string | null>
getGuildSetupChannels(guildId: string): Promise<SetupChannel[]>
~~~

- getDiscordBotUserId uses the existing authenticated REST client, calls exactly GET /users/@me, returns a non-empty string id, returns null for malformed 2xx bodies, and propagates DiscordApiError.
- getGuildSetupChannels removes SetupRole, GuildSetupTargets, parseRoles, and GET /guilds/{guildId}/roles. It returns only narrowed channel data.
- In setup save's create branch, bot identity is resolved before channel creation. A null identity returns 502 without channel creation or persistence. The type-1 overwrite uses bot user ID; the type-0 overwrite continues using guild ID. DISCORD_APPLICATION_ID remains unchanged for actual application endpoints.

- [ ] **Step 1: Write the channels-only lookup failing test**

In tests/discord/guild-lookup.test.ts replace the roles-dependent setup-target expectation with:

~~~ts
it('requests only the guild channel list and returns narrowed channels', async () => {})
~~~

Return one full representative Discord channel. Assert one authenticated GET to /guilds/GUILD_ID/channels, no request URL ending in /roles, and the exact SetupChannel array.

- [ ] **Step 2: Run lookup test RED, narrow implementation, run GREEN**

Run:

~~~sh
pnpm exec vitest run tests/discord/guild-lookup.test.ts -t "only the guild channel list"
~~~

Done-check RED: current code makes the roles request and returns an object. Remove only the unused roles types/parser/request, rename the function, update app/setup/data/route.ts and setup/save's existing-channel branch, then rerun to GREEN.

- [ ] **Step 3: Write bot identity failing tests**

Create tests/discord/bot-user.test.ts:

~~~ts
it('gets the authenticated bot user id from /users/@me', async () => {})
it('returns null when /users/@me has no non-empty string id', async () => {})
~~~

Use a full representative current-user body with id BOT_USER_ID. Assert the literal result, one GET /users/@me, and Bot authorization. Test missing id, empty id, and non-string id as null.

- [ ] **Step 4: Run bot tests RED, implement helper, run GREEN**

Run:

~~~sh
pnpm exec vitest run tests/discord/bot-user.test.ts
~~~

Done-check RED: module/function absent. Add the focused helper without caching, an environment variable, fallback to application ID, or a new retry layer. Rerun to GREEN.

- [ ] **Step 5: Write route overwrite and malformed-identity failing tests**

In tests/setup/save-route.test.ts make APPLICATION_ID and BOT_USER_ID different. Add or rename:

~~~ts
it('grants the authenticated bot user VIEW_CHANNEL and SEND_MESSAGES', async () => {})
it('returns 502 before channel creation when bot identity is malformed', async () => {})
~~~

For success, make GET /users/@me return BOT_USER_ID and channel POST return the created channel. Assert the type-1 overwrite id is BOT_USER_ID and never APPLICATION_ID, the type-0 deny remains guild ID, and finalization succeeds. For malformed identity, return a 2xx body without id and assert 502, no channel POST, and no finalizer.

- [ ] **Step 6: Run route tests RED, integrate helper, run GREEN**

Run:

~~~sh
pnpm exec vitest run tests/setup/save-route.test.ts -t "authenticated bot user|bot identity is malformed"
~~~

Done-check RED: current code never requests /users/@me and uses application ID. Resolve the helper only in the create branch, preserve current DiscordApiError-to-502 behavior, and rerun to GREEN.

- [ ] **Step 7: Verify all consumers and commit**

Remove obsolete roles fixtures from route tests. Run:

~~~sh
pnpm exec vitest run tests/discord/guild-lookup.test.ts tests/discord/bot-user.test.ts tests/setup/save-route.test.ts
pnpm lint
pnpm test
pnpm build
~~~

Done-check: no setup path requests roles, the member overwrite uses the authenticated bot user, and every command exits 0 with pristine output. Commit:

~~~sh
git add app/setup/data/route.ts app/setup/save/route.ts lib/discord/bot-user.ts lib/discord/guild-lookup.ts tests/discord/bot-user.test.ts tests/discord/guild-lookup.test.ts tests/setup/save-route.test.ts
git commit -m "fix(setup): resolve the bot user"
~~~

---

### Task 5: Recover setup UI from empty, transient, and malformed states

**Files:**
- Modify: lib/ui/copy.ts
- Modify: app/setup/[token]/ScreenB.tsx
- Modify: app/setup/[token]/SetupFlow.tsx
- Rename: app/setup/[token]/ScreenA.module.css to app/setup/[token]/SetupStatusCard.module.css
- Modify: app/setup/[token]/ScreenA.tsx
- Create: app/setup/[token]/ScreenLoadError.tsx
- Modify: tests/ui/copy.test.ts
- Modify: tests/ui/setup-form.test.tsx

**Interfaces:**
- WEB_COPY_AUTHORED gains exactly:

~~~ts
setupExistingChannelPlaceholder: '채널을 선택하세요',
setupDataLoadFailed: '설정 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
retry: '다시 시도',
~~~

- Existing-channel Select prepends value '' with the approved placeholder.
- Setup data parsing produces:

~~~ts
type SetupDataResult =
  | { status: 'ready'; data: SetupData }
  | { status: 'unauthenticated' }
  | { status: 'failed' };
~~~

- 401 is unauthenticated. Rejected fetch, invalid JSON, invalid body, and every other non-OK response are failed.
- FlowState gains load-error with canExchangeToken. A transient failure never spends a token. A retry repeats data load. After a successful exchange, canExchangeToken is false forever and retry never exchanges again.
- ScreenLoadError is a separate semantic component with the 오류 Callout, exact sentence, and one primary retry Button. It shares only the generic status-card CSS module with ScreenA.
- Save success requires a complete runtime-validated SaveResult. Invalid or malformed 2xx bodies return false to ScreenB and use the existing saveFailed callout.

- [ ] **Step 1: Write placeholder failing test**

Add:

~~~ts
it('starts existing-channel selection at the approved empty placeholder', async () => {})
~~~

Select the existing destination radio. Assert the combobox value is empty and an option named WEB_COPY_AUTHORED.setupExistingChannelPlaceholder has value empty.

- [ ] **Step 2: Run placeholder RED, implement, run GREEN**

Run:

~~~sh
pnpm exec vitest run tests/ui/setup-form.test.tsx -t "approved empty placeholder"
~~~

Done-check RED: no empty option exists. Add the authored copy and prepend the option in ScreenB without changing Select's generic interface or validation. Rerun to GREEN.

- [ ] **Step 3: Write transient-load failing test**

Add:

~~~ts
it('shows a retryable load error without exchanging an unspent token', async () => {})
~~~

Return 502 for /setup/data. Assert the exact failure sentence, retry button, 오류 tag, no expired-link title, and no /api/setup/exchange request.

- [ ] **Step 4: Run transient RED, implement load-error state, run GREEN**

Run:

~~~sh
pnpm exec vitest run tests/ui/setup-form.test.tsx -t "without exchanging an unspent token"
~~~

Done-check RED: current code treats 502 like 401 and attempts exchange. Add the discriminated parser/state, rename the CSS module without altering styles, add ScreenLoadError, preserve the current unmount cancellation guard, then rerun to GREEN.

- [ ] **Step 5: Write retry token-preservation failing tests**

Add:

~~~ts
it('retries setup data without exchanging when the token remains unspent', async () => {})
it('never exchanges again when retry follows a post-exchange load failure', async () => {})
~~~

First test returns 502 then valid data and asserts two data calls, zero exchanges, and Screen B. Second returns 401, successful exchange, 502, then valid data after retry and asserts exactly one exchange total.

- [ ] **Step 6: Run retry tests RED, wire shared loader, run GREEN**

Run:

~~~sh
pnpm exec vitest run tests/ui/setup-form.test.tsx -t "retries setup data|never exchanges again"
~~~

Done-check RED: retry is absent or repeats exchange. Wire ScreenLoadError.onRetry to the same loader with retained canExchangeToken and rerun to GREEN.

- [ ] **Step 7: Write wrong-shaped save failing test**

Add:

~~~ts
it('keeps Screen B for a 200 save response with the wrong shape', async () => {})
~~~

Return only archiveChannelId from /setup/save. Assert existing saveFailed text, Screen B still rendered, and Screen C absent.

- [ ] **Step 8: Run shape RED, add runtime parser, run GREEN**

Run:

~~~sh
pnpm exec vitest run tests/ui/setup-form.test.tsx -t "wrong shape"
~~~

Done-check RED: current TypeScript assertion advances to Screen C. Add a local parseSaveResult that accepts only non-empty string archiveChannelId, string archiveChannelName, boolean autoCreated, and finite number clipCount. Transition only after non-null parse. Rerun to GREEN.

- [ ] **Step 9: Write malformed JSON failing test**

Add:

~~~ts
it('keeps Screen B for malformed JSON in a 200 save response', async () => {})
~~~

Return a 200 application/json Response with body {not-json. Assert the same save failure, Screen B remains, Screen C absent, and no unhandled rejection.

- [ ] **Step 10: Run malformed RED, widen failure boundary, run GREEN**

Run:

~~~sh
pnpm exec vitest run tests/ui/setup-form.test.tsx -t "malformed JSON"
~~~

Done-check RED: response.json rejects outside the current catch. Move parsing and parseSaveResult into the existing try, return false on rejection or null, then rerun to GREEN.

- [ ] **Step 11: Verify copy authority and commit**

Add exact WEB_COPY_AUTHORED assertions in tests/ui/copy.test.ts. Do not add these strings to handoff-derived WEB_COPY.

Run:

~~~sh
pnpm exec vitest run tests/ui/copy.test.ts tests/ui/setup-form.test.tsx
pnpm lint
pnpm test
pnpm build
~~~

Done-check: placeholder, transient retry, token preservation, wrong-shape, and malformed-JSON tests pass; every command exits 0 with pristine output. Commit:

~~~sh
git add -A 'app/setup/[token]' lib/ui/copy.ts tests/ui/copy.test.ts tests/ui/setup-form.test.tsx
git commit -m "fix(setup): recover from transient responses"
~~~

## Final Verification and Authorized GitHub Actions

After all task reviews are clean:

- Run pnpm lint.
- Run pnpm test against the already-running real clip-pg database.
- Run pnpm build with Ori's approved elevated build permission if sandboxed Next build stalls.
- Run scripts/render-k8s-deployment.sh with ghcr.io/cgm-16/clip:sha-7139b60 into a temporary directory and inspect exactly two identical image values.
- Confirm git status is clean and git diff 7139b603..HEAD contains only planned files.
- Dispatch one whole-branch reviewer against the implementation range.
- Push verified detached HEAD to refs/heads/wave/3-discord-archive.
- Reply in each inline thread using its root comment database ID and resolve only its GraphQL thread ID.
- For accepted comments, state the concrete fix and test evidence.
- For Pretendard, state that vendoring a licensed asset is intentionally deferred because the same-day deadline cannot absorb its time and cost and current system fallback remains.
- For role copy, cite Ori's recorded admin-only P0 decision.
- For recovery, cite the real code/tests showing author/admin removal and FAILED retry behavior; do not claim automatic PENDING retry.
