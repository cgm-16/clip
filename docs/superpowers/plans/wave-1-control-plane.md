# Wave 1 — control plane

Branch: `wave/1-control-plane`, stacked on `wave/0-deploy-skeleton`.

Task `1.3b` (registering the commands against the real test guild) is **not** in this plan.
It needs Ori's live Discord application and produces a screenshot as submission evidence.

## Context

Clip is a Discord app: an authorized member preserves one message into a server-owned
archive, with roughly the effort of pinning it. Discord holds the archived content; our
PostgreSQL holds only the control state needed to operate the archive correctly.

One Next.js App Router deployable serves both the Discord HTTP interaction endpoint and the
admin web UI. There is no Gateway worker. Repository layout is root-level: `app/`, `lib/`,
`tests/`, `scripts/` — there is no `src/`.

This wave builds the control plane: the database schema, a logger that cannot leak message
content, the Discord command definitions, and the one-time-token → short-session flow that
lets an admin reach the web UI from a slash command.

## Global Constraints

These bind every task. A reviewer checks each one.

- **TDD is mandatory.** Write the failing test first, run it, confirm it fails for the right
  reason, then implement.
- **Concurrency and uniqueness invariants get tests against a real Postgres, never mocks.**
  A local database is already running at
  `postgresql://clip:clip@localhost:5433/clip_dev`. Use that as `DATABASE_URL`.
- Tests live in `tests/`, mirroring the `lib/` path of what they cover.
- `pnpm lint` (eslint + `tsc --noEmit`), `pnpm test`, and `pnpm build` must all pass.
- **Never persist raw Discord message bodies, attachments, or embed payloads in Postgres —
  or in logs.** This is a product requirement stated to users in the README, not a
  preference.
- Environment access goes through `parseEnv` in `lib/env.ts`. Feature code must not read
  `process.env` directly. Never call `parseEnv` at module top level in a route — it would
  crash the build when env vars are absent in CI.
  - The single exception is `process.env.NODE_ENV`, which is not in the schema because
    the framework sets it and it is absent from `.env`. Read it directly where a
    production-only behaviour depends on it.
- Use database uniqueness and upsert, **never check-then-insert**. Mutations that depend on
  a clipper count must hold a row lock.
- Smallest reasonable change. No speculative features (YAGNI). No backward-compatibility
  shims. No new dependencies without saying why in the report.
- Match surrounding style: single quotes, semicolons, 2-space indent.
- Comments explain *why*, never temporal context ("new", "moved", "recently").
- Conventional Commits, one commit per task, ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Task 1 — Prisma schema and initial migration

### Files
`prisma/schema.prisma`, `lib/db.ts`, `tests/clip/schema-invariants.test.ts`

### Models
`GuildConfig`, `GuildAllowedRole`, `Clip`, `Clipper`, `AdminSession`, `SetupToken` — exactly
per `docs/01_CLIP_PRODUCT_SPEC.md` §8.3. Read that section; it is settled, do not redesign it.

### Enums
```text
ClipStatus: PENDING ACTIVE DELETING FAILED REMOVED_BY_AUTHOR REMOVED_BY_ADMIN
AuthorNotificationStatus: PENDING DELIVERED UNDELIVERABLE
```

### The amended Clip columns

`archive_provenance_message_id` **and** `archive_forward_message_id`, both nullable.
Discord rejects a forward that carries provenance content (error `160011`), so one archive
entry is two Discord messages. See spec §6.3. A schema with a single `archive_message_id`
is the pre-amendment design and is wrong.

### Uniqueness — these are product requirements, not schema taste
- `UNIQUE(guildId, sourceMessageId)` on `Clip`
- `PK(guildId, sourceMessageId, clipperUserId)` on `Clipper`

### Requirements
- [ ] Failing test first: a duplicate `Clip` insert and a duplicate `Clipper` insert are
      rejected **by the database**, not by application code. Assert on the Postgres unique
      violation, so the test would fail if the constraint were dropped.
- [ ] `lib/db.ts` exports a single `PrismaClient` instance, guarded against duplicate
      instantiation under Next's dev hot-reload.
- [ ] Generate the migration with
      `pnpm prisma migrate dev --name init_clip_control_plane`, and commit
      `prisma/migrations/`.

### Done check
The migration applies clean against the running Postgres, and the constraint tests pass.

## Task 2 — Safe structured logging

### Files
`lib/logging/safe-log.ts`, `tests/logging/safe-log.test.ts`

### Shape
```ts
type SafeClipLog = {
  event: string
  guildId?: string; sourceMessageId?: string; archiveMessageId?: string
  userId?: string; stateFrom?: string; stateTo?: string; errorCode?: string
}
```

### Requirements
- [ ] Failing test first: `content`, `embeds` and `attachments` **cannot** be passed through
      the helper's API — rejected by the TypeScript type — and are **dropped at runtime** if
      they arrive anyway from an untyped call site.
- [ ] The runtime drop must be an allowlist over the known-safe keys, not a denylist of
      forbidden ones. A denylist silently passes the next field someone adds.
- [ ] Log state transitions and error codes.

### Why this is a real task and not boilerplate
`docs/01_CLIP_PRODUCT_SPEC.md` §12 and §17 case 18 make "logs never contain message bodies"
a privacy commitment stated to users in the README. A permissive logger quietly breaks a
user-facing promise, and nothing else in the system catches it.

## Task 3 — Discord command definitions and registration script

### Files
`lib/discord/commands.ts`, `scripts/register-discord-commands.ts`,
`tests/discord/commands.test.ts`

### Commands
- `/setup` — chat input
- `Clip` — message context menu
- `Unclip` — message context menu
- `Remove from Clip Archive` — message context menu

These names are stable identifiers that the interaction router matches on. Fix them now and
export them as named constants, so no later task retypes a string literal.

### Requirements
- [ ] Zod schemas validate the command payloads, and a test asserts each payload validates.
- [ ] The script registers **guild-scoped** commands (global commands take up to an hour to
      propagate; guild commands are immediate). Guild id comes from the environment.
- [ ] The script must support a dry run that prints the payloads and performs **no** network
      call, and must dry-run by default — actually registering requires an explicit flag.
      Someone will run this script by accident; make that harmless.

### Done check
The script builds and dry-runs; payloads validate against the Zod schemas.

## Task 4 — One-time setup token and short admin session

### Files
`lib/admin-session/tokens.ts`, `lib/admin-session/repository.ts`,
`lib/admin-session/service.ts`, `app/api/setup/exchange/route.ts`,
`tests/admin-session/service.test.ts`

Depends on Task 1.

### Behaviour
Token TTL is **15 minutes**. The final Korean copy on Screen A says `발급 후 15분`, and the
copy is authoritative over the spec's original 10 minutes. Session is ~30 minutes with no
refresh.

### Requirements — tests first, against the real Postgres
- [ ] `service.ts` owns **both** halves of the token lifecycle: issuing a token for a
      `(guildId, userId)` pair and exchanging it. Task 5 calls the issuing half; nothing
      else in the wave creates `SetupToken` rows. Return the bearer value to the caller
      exactly once, at issue time — it is never recoverable afterwards.
- [ ] A valid unused token exchanges exactly once
- [ ] A second exchange of the same token fails
- [ ] An expired token fails
- [ ] The session is scoped to guild **and** user
- [ ] An expired or revoked session fails
- [ ] Store only a token **hash**; never persist the bearer value. Compare in constant time.
- [ ] Cookie is `HttpOnly`, `Secure` in production, `SameSite=Lax`, and scoped to a narrow
      path
- [ ] The single-use guarantee must survive two simultaneous exchanges of the same token —
      exactly one wins. Enforce it with a conditional database update, not a read followed
      by a write, and test it with concurrent calls.

### Done check
All the above tests green against the real Postgres.

### Spec
`docs/01_CLIP_PRODUCT_SPEC.md` §5.1, §14, §17 cases 2 and 3.

## Task 5 — `/setup` interaction issues the admin link

### Files
`app/api/discord/interactions/route.ts` (extend), `lib/discord/permissions.ts`,
`tests/discord/setup-command.test.ts`

Depends on Tasks 3 and 4, and on `0.3a`, which is already merged into this branch:
`app/api/discord/interactions/route.ts` already verifies signatures and answers PING.
Extend it — do not rewrite it, and do not weaken its verification.

### Requirements
- [ ] Test: a non-admin invoking `/setup` gets a private (ephemeral) denial
- [ ] Test: an admin gets a one-time URL of the form `PUBLIC_BASE_URL/setup/<token>`
- [ ] Check `MANAGE_GUILD` from the **interaction member permissions, server-side**. Never
      trust a permission claim that arrives from a browser later.
- [ ] The response is ephemeral (flag `64`), so the link is not posted into the channel
- [ ] Discord kills an interaction that is not answered within **3 seconds**. Do no slow
      work on this path before responding.

### Done check
Both tests pass.

### Spec
`docs/01_CLIP_PRODUCT_SPEC.md` §3, §5.1, §5.4.
