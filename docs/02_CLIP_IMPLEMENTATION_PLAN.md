# Clip P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy the approved Clip P0: an HTTP-interactions Discord application that archives explicitly selected messages into a server-owned Discord channel, maintains durable concurrency-safe control state in PostgreSQL, and provides a short-session admin setup/read-only archive web UI.

**Architecture:** A single Next.js/TypeScript deployable handles Discord HTTP interactions and the admin web UI. PostgreSQL is the authoritative control plane; archived message content stays in Discord and is fetched live for the web archive. No persistent Discord Gateway worker, AI feature, full OAuth member login, external content storage, or search index is part of P0.

**Tech Stack:** Next.js App Router + TypeScript + React, PostgreSQL, Prisma (recommended), Zod, Discord HTTP interactions + REST, Vitest (recommended for fast unit tests) or project-equivalent test runner, containerized deployment to existing k3s behind Traefik.

**Spec:** `docs/superpowers/specs/2026-08-18-clip-p0-design.md` (copy/adapt `01_CLIP_PRODUCT_SPEC.md` into the repo at this path before implementation).

## Global Constraints

- Deadline: 2026-08-20 23:59 KST.
- Deploy a reachable HTTPS skeleton early; do not leave deployment until final polish.
- P0 uses Discord HTTP interactions, not a persistent Gateway worker.
- Discord is authoritative for message/archive content.
- PostgreSQL is authoritative for guild config, Clip/Clipper state, tombstones, notification state and admin sessions.
- Do not persist raw Discord message bodies or attachment binaries in PostgreSQL.
- One canonical Clip per `(guild_id, source_message_id)`.
- One Clipper signal per `(guild_id, source_message_id, clipper_user_id)`.
- Author/admin removal overrides clippers and leaves a durable tombstone while guild remains configured.
- Clip exactly the selected message; do not automatically include parent/thread content.
- Archive created by the app is private/admin-visible by default.
- Admins are implicitly allowed to Clip; configured roles grant additional permission.
- Web clip content is read-only in P0.
- Web archive is admin-only through a short-lived Discord-issued setup/session flow; no full Discord OAuth.
- User-added marker reactions are ignored by product semantics in P0.
- No AI, publication, Book Print API, full-text search, tags, collections, per-user opt-out, channel denylist, permission-aware routing, or content cache in P0.
- Operational logs must not contain raw Discord message bodies/attachments.

---

## A. Expected file structure

If starting from an empty repo, use this boundary-first structure. If an existing repo differs, map responsibilities without collapsing the domain into route handlers.

```text
app/
  api/
    discord/
      interactions/route.ts
    setup/
      exchange/route.ts
    admin/
      guilds/[guildId]/config/route.ts
      guilds/[guildId]/delete-data/route.ts
  setup/[token]/page.tsx
  admin/[guildId]/page.tsx
  admin/[guildId]/archive/page.tsx
  expired/page.tsx
components/
  setup/archive-destination-field.tsx
  setup/role-selector.tsx
  archive/clip-card.tsx
  archive/channel-filter.tsx
  ui/*
lib/
  db.ts
  env.ts
  discord/
    verify-interaction.ts
    rest-client.ts
    commands.ts
    permissions.ts
    archive-message.ts
    notifications.ts
    marker.ts
  clip/
    types.ts
    authorization.ts
    service.ts
    state-machine.ts
    repository.ts
  admin-session/
    tokens.ts
    repository.ts
    service.ts
  archive/
    reader.ts
    view-model.ts
  logging/
    safe-log.ts
scripts/
  register-discord-commands.ts
tests/
  clip/
  discord/
  admin-session/
  archive/
prisma/
schema.prisma
migrations/
Dockerfile
k8s/
deployment.yaml
service.yaml
ingress.yaml
secret.example.yaml
.env.example
README.md
```

### Key interfaces to preserve

```ts
export type ClipCommandResult =
  | { kind: 'CREATED'; archiveMessageId: string }
  | { kind: 'CLIPPER_ADDED'; archiveMessageId: string }
  | { kind: 'ALREADY_CLIPPED_BY_USER'; archiveMessageId: string | null }
  | { kind: 'NOT_AUTHORIZED' }
  | { kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' }
  | { kind: 'SOURCE_UNAVAILABLE' }
  | { kind: 'FAILED'; retryable: boolean };

export interface ClipService {
  clip(input: ClipInput): Promise<ClipCommandResult>;
  unclip(input: UnclipInput): Promise<UnclipResult>;
  removeByAuthorOrAdmin(input: RemoveInput): Promise<RemoveResult>;
}

export interface DiscordArchiveGateway {
  createArchiveMessage(input: CreateArchiveInput): Promise<{ archiveMessageId: string }>;
  deleteArchiveMessage(channelId: string, messageId: string): Promise<void>;
  fetchArchiveMessage(channelId: string, messageId: string): Promise<DiscordArchiveMessage | null>;
  addArchiveMarker(channelId: string, messageId: string): Promise<void>;
  removeArchiveMarker(channelId: string, messageId: string): Promise<void>;
  notifyAuthor(input: AuthorNotificationInput): Promise<'DELIVERED' | 'UNDELIVERABLE'>;
}
```

Keep domain tests against these interfaces so Discord REST details can be mocked.

---

## Wave 0 — Deployment skeleton and real Discord endpoint first

**Why first:** Discord interaction verification, HTTPS, DNS, Traefik and secrets are external constraints. Discovering them on submission night is unnecessary risk.

### Task 0.1: Scaffold application and health endpoint

**Files:**
- Create: `package.json`, `app/page.tsx`, `app/api/health/route.ts`, `lib/env.ts`, `Dockerfile`, `.env.example`

**Produces:** A container that returns `200 {"ok":true}` at `/api/health`.

- [ ] Initialize Next.js TypeScript App Router project and install runtime/test dependencies.

```bash
pnpm add zod @prisma/client discord-interactions
pnpm add -D prisma vitest @vitest/coverage-v8 tsx
```

- [ ] Create strict environment parser in `lib/env.ts` for at least:

```ts
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),
  DISCORD_PUBLIC_KEY: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().min(1),
  ADMIN_SESSION_SECRET: z.string().min(32),
  PUBLIC_BASE_URL: z.string().url(),
});
```

- [ ] Add health route:

```ts
export async function GET() {
  return Response.json({ ok: true });
}
```

- [ ] Build locally.

```bash
pnpm build
```

Expected: build succeeds.

- [ ] Build container.

```bash
docker build -t clip:p0 .
```

- [ ] Commit.

```bash
git add .
git commit -m "chore: scaffold Clip web service"
```

### Task 0.2: Deploy skeleton to k3s + domain/HTTPS

**Files:**
- Create: `k8s/deployment.yaml`, `k8s/service.yaml`, `k8s/ingress.yaml`, `k8s/secret.example.yaml`

**Produces:** Reachable HTTPS `PUBLIC_BASE_URL/api/health`.

- [ ] Configure DNS for the chosen project domain/subdomain to the existing ingress path.
- [ ] Create Deployment with conservative starting resources:

```yaml
resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: "1"
    memory: 512Mi
```

- [ ] Reuse existing Traefik/TLS conventions; do not introduce a second ingress stack.
- [ ] Render then apply manifests. Release CI must have published `CLIP_IMAGE` before rendering. `k8s/deployment.yaml` is an intentionally non-deployable template; renderer success must precede apply.

```bash
git fetch origin main
CLIP_IMAGE="ghcr.io/cgm-16/clip:sha-$(git rev-parse --short=7 origin/main)"
mkdir -p k8s/rendered
scripts/render-k8s-deployment.sh "$CLIP_IMAGE" k8s/rendered/deployment.yaml
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/rendered/deployment.yaml
```

- [ ] Verify.

```bash
curl -fsS https://<domain>/api/health
kubectl get pods
kubectl logs deployment/clip --tail=100
```

Expected: HTTPS health returns `{"ok":true}` and pod remains ready.

- [ ] Record domain recurring cost and environment in `README.md` / cumulative snapshot.
- [ ] Commit deployment manifests.

### Task 0.3: Implement Discord interaction verification + PING

**Files:**
- Create: `lib/discord/verify-interaction.ts`
- Create: `app/api/discord/interactions/route.ts`
- Test: `tests/discord/verify-interaction.test.ts`

**Produces:** Discord can verify the Interaction Endpoint URL.

- [ ] Write test that unsigned/bad-signature request is rejected.
- [ ] Implement verification with `discord-interactions` `verifyKey` using raw request body, `X-Signature-Ed25519`, `X-Signature-Timestamp`.
- [ ] Implement type-1 PING response:

```ts
if (interaction.type === 1) {
  return Response.json({ type: 1 });
}
```

- [ ] Deploy immediately.
- [ ] Set Discord Interaction Endpoint URL to `https://<domain>/api/discord/interactions`.
- [ ] Verify Discord accepts endpoint.
- [ ] Commit.

**Gate:** Do not move deep into product code until real endpoint verification succeeds.

---

## Wave 1 — Durable control plane and admin bootstrap

### Task 1.1: Define Prisma schema and migration

**Files:**
- Create: `prisma/schema.prisma`
- Create: `lib/db.ts`
- Test: `tests/clip/schema-invariants.test.ts`

**Produces:** Durable P0 relational state with uniqueness constraints.

- [ ] Define enums:

```prisma
enum ClipStatus {
  PENDING
  ACTIVE
  DELETING
  FAILED
  REMOVED_BY_AUTHOR
  REMOVED_BY_ADMIN
}

enum AuthorNotificationStatus {
  PENDING
  DELIVERED
  UNDELIVERABLE
}
```

- [ ] Define `GuildConfig`, `GuildAllowedRole`, `Clip`, `Clipper`, `AdminSession`, `SetupToken` following the product spec.
- [ ] Enforce canonical uniqueness using composite IDs/unique constraints on `(guildId, sourceMessageId)` and `(guildId, sourceMessageId, clipperUserId)`.
- [ ] Run migration against development/test DB.

```bash
pnpm prisma migrate dev --name init_clip_control_plane
```

- [ ] Write DB test that duplicate Clip/Clipper insertion is rejected/upserted as intended.
- [ ] Commit.

### Task 1.2: Implement safe structured logging

**Files:**
- Create: `lib/logging/safe-log.ts`
- Test: `tests/logging/safe-log.test.ts`

**Produces:** State/error logs that exclude message bodies/attachments.

- [ ] Define allowed log shape:

```ts
type SafeClipLog = {
  event: string;
  guildId?: string;
  sourceMessageId?: string;
  archiveMessageId?: string;
  userId?: string;
  stateFrom?: string;
  stateTo?: string;
  errorCode?: string;
};
```

- [ ] Test that arbitrary `content`, `embeds`, `attachments` fields cannot be passed through helper API.
- [ ] Commit.

### Task 1.3: Register Discord commands

**Files:**
- Create: `lib/discord/commands.ts`
- Create: `scripts/register-discord-commands.ts`

**Produces:** `/setup` plus message commands `Clip`, `Unclip`, `Remove from Clip Archive`.

- [ ] Define command payloads with stable names.
- [ ] Register to a dedicated test guild first for rapid propagation.
- [ ] Verify commands appear.
- [ ] Append command-registration evidence to cumulative snapshot.
- [ ] Commit.

### Task 1.4: Implement one-time setup token + short admin session

**Files:**
- Create: `lib/admin-session/tokens.ts`
- Create: `lib/admin-session/repository.ts`
- Create: `lib/admin-session/service.ts`
- Create: `app/api/setup/exchange/route.ts`
- Test: `tests/admin-session/service.test.ts`

**Produces:** One-use ~10-minute setup token exchanged for short secure admin cookie/session.

- [ ] Write tests for:
  - valid unused token exchanges once;
  - second exchange fails;
  - expired token fails;
  - session is guild/user scoped;
  - expired/revoked session fails.
- [ ] Store token hash/nonce server-side; never store bearer token plaintext.
- [ ] Set cookie `HttpOnly`, `Secure` in production, `SameSite=Lax` (or stricter if flow permits), narrow path/domain as practical.
- [ ] Commit.

### Task 1.5: `/setup` interaction

**Files:**
- Modify: `app/api/discord/interactions/route.ts`
- Create: `lib/discord/permissions.ts`
- Test: `tests/discord/setup-command.test.ts`

**Produces:** Admin-only ephemeral Configure Clip URL.

- [ ] Test non-admin receives private denial.
- [ ] Test admin receives one-time URL using `PUBLIC_BASE_URL/setup/<token>`.
- [ ] Verify permission from interaction member permissions server-side; do not trust browser later.
- [ ] Deploy and test from real Discord server.
- [ ] Commit.

---

## Wave 2 — Clip domain state machine first, Discord side effects second

### Task 2.1: Define domain types and authorization

**Files:**
- Create: `lib/clip/types.ts`
- Create: `lib/clip/authorization.ts`
- Test: `tests/clip/authorization.test.ts`

**Produces:** `canClip(adminPermission, memberRoleIds, allowedRoleIds)`.

- [ ] Test admin implicit permission.
- [ ] Test member with allowed role.
- [ ] Test member without role.
- [ ] Test empty allowed-role list still permits admin only.
- [ ] Commit.

### Task 2.2: Implement Clip repository transactions/locking

**Files:**
- Create: `lib/clip/repository.ts`
- Test: `tests/clip/repository.test.ts`

**Produces:** Atomic methods for claiming Clip, adding/removing Clipper, locking a canonical Clip, tombstoning.

Required repository methods:

```ts
claimClip(input): Promise<{ created: boolean; clip: ClipRecord }>;
addClipper(input): Promise<{ added: boolean }>;
removeClipper(input): Promise<{ removed: boolean; remaining: number }>;
lockClip(guildId, sourceMessageId, fn): Promise<...>;
markActive(...): Promise<void>;
markDeleting(...): Promise<void>;
markRemovedByAuthor(...): Promise<void>;
markRemovedByAdmin(...): Promise<void>;
```

- [ ] Implement with DB transaction and row lock/advisory equivalent for mutations that depend on clipper count.
- [ ] Write concurrency-oriented integration tests using parallel promises against test Postgres:
  - 10 simultaneous first Clips -> one canonical Clip;
  - same user double Clip -> one Clipper;
  - two simultaneous Unclips from two clippers -> final remaining 0 exactly once;
  - author tombstone blocks later normal claim.
- [ ] Commit.

### Task 2.3: Implement ClipService with fake Discord gateway

**Files:**
- Create: `lib/clip/service.ts`
- Create: `lib/discord/rest-client.ts` interface/adapter shell
- Test: `tests/clip/service.test.ts`

**Produces:** Tested orchestration independent of actual REST.

- [ ] Create fake gateway capturing side effects.
- [ ] Test first Clip:
  - claim PENDING;
  - add clipper;
  - create one archive message;
  - mark ACTIVE.
- [ ] Test second user Clip -> no second archive side effect.
- [ ] Test same user duplicate -> idempotent.
- [ ] Test last Unclip -> DELETING -> archive delete -> remove ordinary Clip row.
- [ ] Test one of multiple Unclips -> archive remains.
- [ ] Test author removal -> archive delete + tombstone; later Clip rejected.
- [ ] Test admin removal same override.
- [ ] Test create failure -> recoverable FAILED/PENDING semantics, never false ACTIVE.
- [ ] Test delete/new-clip race converges to ACTIVE if a signal remains; if Discord delete already succeeded, recreate archive before final ACTIVE mapping.
- [ ] Commit.

---

## Wave 3 — Real Discord archive, marker, notification

### Task 3.1: Implement Discord REST gateway

**Files:**
- Implement: `lib/discord/rest-client.ts`
- Create: `lib/discord/archive-message.ts`
- Test: `tests/discord/archive-message.test.ts`

**Produces:** Create/fetch/delete archive message with snapshot/forward + provenance.

- [ ] Implement bot-auth REST helper with rate-limit/error mapping.
- [ ] Build archive message payload from selected target:
  - forwarded/snapshot reference where API supports it;
  - original author attribution;
  - source channel;
  - original timestamp;
  - source link;
  - clip timestamp.
- [ ] Do not serialize raw message payload into Postgres/logs.
- [ ] Test payload builder against fixture input.
- [ ] Test manually in test guild.
- [ ] Commit.

### Task 3.2: Implement marker as auxiliary side effect

**Files:**
- Create: `lib/discord/marker.ts`
- Modify: `lib/clip/service.ts`
- Test: `tests/discord/marker.test.ts`

**Produces:** Bot-owned `📎` status reaction added on active archive and removed on canonical removal where possible.

- [ ] Treat marker failure as non-fatal to canonical Clip state.
- [ ] Never count user reactions as clipper signals.
- [ ] Add safe log on marker failure.
- [ ] Commit.

### Task 3.3: Implement first-clip author DM

**Files:**
- Create: `lib/discord/notifications.ts`
- Modify: `lib/clip/service.ts`
- Test: `tests/discord/notifications.test.ts`

**Produces:** One best-effort DM per first canonical archival; failure stored as UNDELIVERABLE, no rollback.

- [ ] Notification contains source context + remove action/custom ID.
- [ ] Test duplicate clippers do not trigger repeated DM.
- [ ] Test DM 50007/unavailable maps to `UNDELIVERABLE`.
- [ ] Commit.

### Task 3.4: Wire message context interactions

**Files:**
- Modify: `app/api/discord/interactions/route.ts`
- Test: `tests/discord/context-commands.test.ts`

**Produces:** Real `Clip`, `Unclip`, `Remove from Clip Archive` flows with ephemeral feedback.

- [ ] `Clip` checks role/admin authorization.
- [ ] `Unclip` only affects invoking user's signal.
- [ ] Remove command authorizes source author OR guild admin.
- [ ] Button-based DM removal re-verifies interacting user against `author_user_id`.
- [ ] Use minimal private responses from spec.
- [ ] Deploy and test in real Discord after each command is wired.
- [ ] Commit.

**Gate:** At end of Wave 3, a deployed Discord-only happy path must work end-to-end even if web archive UI is unfinished.

---

## Wave 4 — Admin web setup/configuration

### Task 4.1: Guild/channel/role lookup for setup

**Files:**
- Extend: `lib/discord/rest-client.ts`
- Create: `app/setup/[token]/page.tsx`
- Test: `tests/discord/setup-data.test.ts`

**Produces:** Valid setup page can display guild identity, selectable channels and roles without full OAuth.

- [ ] Server uses bot credentials + token-guild identity to fetch required guild channels/roles.
- [ ] Never trust guild ID submitted by browser without matching setup/admin session.
- [ ] Commit.

### Task 4.2: Archive destination configuration

**Files:**
- Create: `components/setup/archive-destination-field.tsx`
- Create/modify: `app/api/admin/guilds/[guildId]/config/route.ts`
- Test: `tests/admin/config-route.test.ts`

**Produces:** Choose automatic private channel creation or existing channel.

- [ ] Existing channel path validates bot permissions and refuses with explicit missing-permission copy; do not mutate permissions.
- [ ] Auto-create path uses channel creation API + private/default overwrite; requires bootstrap permission.
- [ ] Persist `archive_channel_id` only after success.
- [ ] Reconfiguring an already-configured destination is refused (`409`) while `hasLiveClips` is true, and a `PENDING` or `FAILED` Clip that never posted an archive still counts as live; an operator locked out this way takes the stranded Clip to a tombstone through `Remove from Clip Archive` before the change is accepted.
- [ ] Commit.

### Task 4.3: Role configuration

**Files:**
- Create: `components/setup/role-selector.tsx`
- Modify: config API route
- Test: `tests/admin/role-config.test.ts`

**Produces:** Replace configured allowed-role set transactionally.

- [ ] Empty selection allowed.
- [ ] UI explicitly states admins are always allowed.
- [ ] Validate role IDs belong to target guild.
- [ ] Commit.

### Task 4.4: Setup completion/current config

**Files:**
- Create: `app/admin/[guildId]/page.tsx`

**Produces:** Minimal success/config page showing archive destination, roles, usage instruction, archive link, bootstrap permission note.

- [ ] Add expired-session recovery path to `/expired`.
- [ ] Commit.

---

## Wave 5 — Read-only web archive

### Task 5.1: Paginated Clip metadata reader

**Files:**
- Create: `lib/archive/reader.ts`
- Test: `tests/archive/reader.test.ts`

**Produces:** Newest-first pagination with optional `source_channel_id` filter.

```ts
getClipPage({ guildId, sourceChannelId?, cursor?, limit: 20 })
```

- [ ] Use stable cursor based on `(createdAt, sourceMessageId)` or equivalent.
- [ ] Do not use offset pagination if avoidable.
- [ ] Commit.

### Task 5.2: Live Discord content fetch/view model

**Files:**
- Create: `lib/archive/view-model.ts`
- Extend: `lib/discord/rest-client.ts`
- Test: `tests/archive/view-model.test.ts`

**Produces:** Metadata page -> live Discord archive-message payload -> render model.

- [ ] Fetch only current page of archive messages.
- [ ] Bound concurrency to avoid uncontrolled REST fan-out.
- [ ] Missing Discord archive message returns `missing` view model; do not crash page.
- [ ] Do not persist response body.
- [ ] Commit.

### Task 5.3: Archive UI

**Files:**
- Create: `app/admin/[guildId]/archive/page.tsx`
- Create: `components/archive/clip-card.tsx`
- Create: `components/archive/channel-filter.tsx`

**Produces:** Read-only newest-first admin archive with channel filter + pagination.

- [ ] Render original/source metadata and `Open original`/`Original unavailable`.
- [ ] Render loading/error/empty states.
- [ ] Keep content mutation out of web P0.
- [ ] Commit.

### Task 5.4: Delete Clip control-plane data

**Files:**
- Create: `app/api/admin/guilds/[guildId]/delete-data/route.ts`
- Test: `tests/admin/delete-data.test.ts`

**Produces:** Explicit admin action deletes Clip DB state but leaves Discord archive untouched.

- [ ] Require valid admin session for same guild.
- [ ] Delete in transaction in FK-safe order/cascade.
- [ ] UI confirmation states Discord archive messages are not deleted.
- [ ] Commit.

---

## Wave 6 — Failure handling, permissions validation, integrated QA

### Task 6.1: Permission matrix test on fresh Discord test guild

**Files:**
- Update: `README.md` permission table
- Update: cumulative snapshot

- [ ] Install with intended minimum runtime permissions and validate:
  - message context command works;
  - source message can be archived;
  - archive send/forward works;
  - marker reaction works;
  - DMs work when user allows them;
  - existing-channel setup correctly reports missing perms.
- [ ] Test auto-create path with optional `MANAGE_CHANNELS`.
- [ ] Revoke `MANAGE_CHANNELS` after setup and verify ordinary clipping still works.
- [ ] Record exact permission set actually required; replace speculative list in docs.

### Task 6.2: Integrated race/idempotency test

**Files:**
- Add: `tests/integration/clip-concurrency.test.ts`

- [ ] Parallel Clip same source, different users -> one Discord archive side effect (mocked) + N clippers.
- [ ] Parallel same-user Clip -> one signal.
- [ ] Parallel final Unclips -> exactly one ordinary deletion intent.
- [ ] Author remove racing normal Clip -> tombstone wins.
- [ ] Create/delete REST failure -> state remains recoverable.
- [ ] Commit.

### Task 6.3: Manual real-environment scenario suite

Execute in deployed test guild and record evidence:

1. setup create-new;
2. setup existing-channel;
3. admin implicit Clip;
4. allowed-role Clip;
5. unauthorized Clip;
6. same user double Clip;
7. two users Clip;
8. one Unclip while another remains;
9. final Unclip;
10. author removal;
11. reclip after author removal denied;
12. source edit after Clip leaves archive snapshot unchanged;
13. source delete leaves archive;
14. DM blocked -> Clip still works;
15. archive browser filter/pagination;
16. admin session expiration;
17. manually missing archive message -> graceful web state.

Append results/screenshots to cumulative snapshot.

---

## Wave 7 — Visual system and submission polish

This wave may be executed by a separate design agent using `05_DESIGN_AGENT_BRIEF.md`.

### Task 7.1: Minimum design system

**Files:**
- Modify/create: `app/globals.css`, `components/ui/*`

- [ ] Define explicit typography/spacing/radius/semantic color tokens.
- [ ] Normalize button/input/select/status states.
- [ ] Apply archive card pattern.
- [ ] Verify responsive setup/archive pages.
- [ ] Verify keyboard/focus/contrast basics.
- [ ] Do not add product features during visual polish without recording scope change.
- [ ] Commit.

### Task 7.2: Documentation

**Files:**
- Modify: `README.md`
- Create: `docs/product-decisions.md` (can derive from handoff log)

README should contain:

- problem;
- positioning vs Pins/Starboard/Pin Archiver;
- core loop;
- architecture diagram;
- content/control-plane boundary;
- P0 included/deferred;
- permissions;
- deployment;
- privacy/data behavior;
- known limitations;
- P1 roadmap;
- AI-assisted development method summary;
- screenshots/video links if appropriate.

### Task 7.3: Assignment evidence and presentation capture

- [ ] Update `04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md` with actual implementation/design evidence.
- [ ] Capture screenshots/video because interview presentation has <=5 min and no live demo requirement.
- [ ] Capture at minimum:
  - setup page;
  - Discord context Clip action;
  - archived Discord message;
  - author DM/marker;
  - web archive;
  - one architecture/decision slide visual if presentation agent creates it.
- [ ] Record final implemented-vs-mocked table.

---

## Timeline / priority checkpoints to protect the deadline

These are sequencing checkpoints, not promises of elapsed implementation time.

### 2026-08-18 — infrastructure risk first

Target state before ending the first implementation block:

- repo/scaffold;
- production domain/DNS/HTTPS;
- deployed health route;
- Discord Interaction Endpoint verified;
- Postgres migration path working.

### 2026-08-19 — core service before polish

Priority:

- schema + state machine;
- Clip/Unclip/remove happy path;
- real Discord archive;
- role authorization;
- admin setup flow;
- author notification/marker.

The deployed Discord-only product should already work before archive UI polish.

### 2026-08-20 — web archive, QA, design, submission

Priority order:

1. read-only archive/setup completion;
2. integrated failure/concurrency checks;
3. permission validation;
4. minimal design system;
5. README/evidence snapshot;
6. screenshots/video;
7. form-answer synthesis/presentation preparation;
8. preserve buffer before **23:59 KST** for deployment/submission problems.

If scope is endangered, cut P0 polish before cutting correctness/consent/deployment.

---

## Final verification commands / evidence

Adapt to actual repo scripts, but final gate should include at least:

```bash
pnpm lint
pnpm test
pnpm build
kubectl rollout status deployment/clip
curl -fsS https://<domain>/api/health
kubectl logs deployment/clip --tail=200
```

Before applying, release CI must have published `CLIP_IMAGE`; `k8s/deployment.yaml` is a non-deployable template and must never be passed directly to `kubectl`. Renderer success must precede applying the generated deployment. As part of rollout verification, inspect the successful completion of the `migrate` init-container as well as the app logs.

And manual Discord checks from Task 6.3.

Do not claim completion until tests/build/deployed interaction have been observed in the final environment.

---

## Implementation-agent reporting requirement

After every task or meaningful group of tasks, append to `04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md`:

- AI tool/agent used;
- input spec/task;
- AI proposal;
- human review/rejection/changes;
- test/verification outcome;
- failure discovered;
- commit/screenshot/reference.

This evidence is a required deliverable because the assignment explicitly asks how the human operated AI, not merely whether the final code works.
