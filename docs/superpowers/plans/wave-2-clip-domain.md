# Wave 2 — Clip domain

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` to
> implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

Branch: `wave/2-clip-domain`, off `main` (Wave 1 merged as `560b7a2`).

**Goal.** Build the Clip state machine and its storage so that every concurrency and idempotency
invariant in the product spec is proven against a real Postgres — before a single line of Discord
REST code exists.

**Architecture.** Three layers, each testable without the one above it. `lib/clip/types.ts` and
`lib/clip/authorization.ts` are pure. `lib/clip/repository.ts` owns every write, and every write
that depends on a clipper count happens inside a transaction holding a row lock on the canonical
Clip. `lib/clip/service.ts` orchestrates those writes against a `DiscordArchiveGateway`
*interface*; Wave 2 supplies only a fake implementation, and Wave 3.1 supplies the real one.

**Spec.** `docs/01_CLIP_PRODUCT_SPEC.md` §7, §9, §16, §17. Issues #19, #20, #21. Ordering map:
`docs/tasks/00_DAG.md`. This wave's merge gate is *"concurrency tests green against real Postgres"*.

**`2.2` locking and `2.3` state machine are on the DAG's never-cut list.** If time runs out, polish
elsewhere gets cut, not these.

---

## Global Constraints

These bind every task. The reviewer checks each one.

- **TDD is mandatory.** Write the failing test, run it, confirm it fails *for the right reason*,
  then implement.
- **Concurrency and uniqueness invariants get tests against a real Postgres, never mocks.** A local
  database is already running at `postgresql://clip:clip@localhost:5433/clip_dev` — note **port
  5433**, not 5432; `tests/setup/database-url.ts` already defaults to it. If the tests appear to
  pass suspiciously fast, verify they are actually reaching the database by pointing `DATABASE_URL`
  at a dead port and confirming they **fail** rather than skip.
- **Concurrency tests must warm the connection pool before the racing promises.** node-postgres
  opens connections lazily, so N promises issued against a cold pool serialize on connection
  establishment and never actually race. Wave 1 shipped a concurrency test that passed against its
  own regression for exactly this reason. Open the connections first with a throwaway
  `Promise.all` of trivial queries, then run the real race. **This warm-up is load-bearing — it is
  not boilerplate to be tidied away.**
- **Use database uniqueness and conditional writes, never check-then-insert.** A read followed by a
  write lets every concurrent caller observe the same pre-state.
- **Never persist raw Discord message bodies, attachments or embed payloads in Postgres — or in
  logs.** `tests/clip/schema-invariants.test.ts` pins the exact column set of `clips` and
  `clippers` against `information_schema`; a new column is a deliberate act that updates that
  allowlist, never a drive-by.
- Environment access goes through `parseEnv` in `lib/env.ts`. Feature code must not read
  `process.env` directly (the sole exception is `NODE_ENV`). Never call `parseEnv` at module top
  level in a route.
- Tests live in `tests/`, mirroring the `lib/` path of what they cover.
- `pnpm lint` (eslint + `tsc --noEmit`), `pnpm test` and `pnpm build` must all pass.
- If `tsc` reports an error that contradicts `tsconfig.json`, delete `tsconfig.tsbuildinfo` and
  re-run. `incremental: true` does not invalidate on a tsconfig change, and Wave 1 lost time to it.
- Smallest reasonable change. YAGNI. No backward-compatibility shims. No new dependencies without
  saying why in the report.
- Match surrounding style: single quotes, semicolons, 2-space indent. Comments explain *why*, never
  temporal context ("new", "moved", "recently").
- Conventional Commits, one commit per task, ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

### The review question this wave adds

Wave 1's mutation-testing regime found five defects and **structurally could not find a sixth**: the
setup-token exchange consumed the token and inserted the session as two independent statements, so a
failed insert burned the token and stranded the admin. Every mutation asks *"can an invariant be
violated"*, and non-atomicity violates none — it fails safe, in the direction of doing less.
(Recorded in `docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md` under `[2026-08-19 13:54 KST]`.)

This wave is dense with multi-write operations. Mutation testing stays, and every task additionally
answers, **per operation**:

> If the second write fails, what is already committed, and can the user retry?

An operation whose answer is "the user is stuck" is a defect even when no invariant is violated.

---

## Task 1 — Domain types and authorization (`2.1`, issue #19)

### Files
Create `lib/clip/types.ts`, `lib/clip/authorization.ts`, `tests/clip/authorization.test.ts`.

Pure functions and type declarations only. No database, no network, no imports from `lib/db.ts`.

### The authorization rule

```text
canClip = hasManageGuild OR (memberRoleIds ∩ allowedRoleIds ≠ ∅)
```

`docs/02_CLIP_IMPLEMENTATION_PLAN.md` sketches this as
`canClip(adminPermission, memberRoleIds, allowedRoleIds)`. **Take a single input object instead:**

```ts
export type CanClipInput = {
  hasManageGuild: boolean;
  memberRoleIds: readonly string[];
  allowedRoleIds: readonly string[];
};

export function canClip(input: CanClipInput): boolean;
```

Two adjacent `readonly string[]` parameters are a silent swap hazard — transposed, the function
still typechecks and still returns `true` for an admin, so the admin tests keep passing while every
role check inverts. The object form makes the swap impossible. Record the deviation in the report.

### Requirements — tests first
- [ ] An admin (`hasManageGuild: true`) is allowed, whatever their roles.
- [ ] A member holding one of the configured roles is allowed.
- [ ] A member holding roles, none of them configured, is denied.
- [ ] An empty `allowedRoleIds` list still permits an admin, and denies every non-admin — including
      one who holds roles. "No roles configured" must not degrade into "everyone may clip".
- [ ] A member holding no roles at all is denied.

### The types this wave is built on

`lib/clip/types.ts` is the contract every later wave codes against. Define exactly this much — the
marker, author-DM and archive-fetch gateway methods belong to `3.2`, `3.3` and `5.2` and are not
written here, because nothing in Wave 2 calls them.

```ts
/** Both Discord messages that make up one archive entry. See spec §6.3. */
export type ArchiveMessageIds = {
  provenanceMessageId: string;
  forwardMessageId: string;
};

export type ClipCommandResult =
  | { kind: 'CREATED'; archive: ArchiveMessageIds }
  | { kind: 'CLIPPER_ADDED'; archive: ArchiveMessageIds | null }
  | { kind: 'ALREADY_CLIPPED_BY_USER'; archive: ArchiveMessageIds | null }
  | { kind: 'NOT_AUTHORIZED' }
  | { kind: 'REMOVED_BY_AUTHOR_OR_ADMIN' }
  | { kind: 'SOURCE_UNAVAILABLE' }
  | { kind: 'FAILED'; retryable: boolean };

export type UnclipResult =
  | { kind: 'UNCLIPPED'; remaining: number }
  | { kind: 'NOT_CLIPPED_BY_USER' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'FAILED'; retryable: boolean };

export type RemoveResult =
  | { kind: 'REMOVED' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'NOT_AUTHORIZED' }
  | { kind: 'FAILED'; retryable: boolean };

export type ClipInput = {
  guildId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  sourceAuthorUserId: string;
  clipperUserId: string;
  clipperRoleIds: readonly string[];
  clipperHasManageGuild: boolean;
};

export type UnclipInput = {
  guildId: string;
  sourceMessageId: string;
  clipperUserId: string;
};

export type RemoveInput = {
  guildId: string;
  sourceMessageId: string;
  invokerUserId: string;
  invokerHasManageGuild: boolean;
};

export type CreateArchiveInput = {
  archiveChannelId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  sourceAuthorUserId: string;
};

/**
 * The Discord side of the archive, as the domain needs it. Wave 2 exercises this
 * through a fake; `3.1` supplies the REST implementation.
 */
export interface DiscordArchiveGateway {
  /**
   * Posts the provenance message and the forward, in that order, and returns both
   * ids. An archive entry is two Discord messages because Discord rejects a forward
   * carrying additional content (error 160011, spec §6.3).
   *
   * Implementations MUST NOT return a partial archive. If the forward fails after the
   * provenance message posted, throw `ArchiveCreationFailedError` carrying the orphan's
   * id so the caller can clean it up (spec §17 case 19).
   */
  createArchiveMessage(input: CreateArchiveInput): Promise<ArchiveMessageIds>;

  /** Deletes both messages. Deleting an already-deleted message is not an error. */
  deleteArchiveMessage(archiveChannelId: string, ids: ArchiveMessageIds): Promise<void>;
}
```

### The two error types the service branches on

```ts
/** The target message cannot be archived: deleted, invisible, or an unforwardable type. */
export class ArchiveTargetUnavailableError extends Error {}

/**
 * The archive could not be created. `orphanedProvenanceMessageId` is set when the
 * provenance message posted but the forward did not, so the caller can delete it.
 */
export class ArchiveCreationFailedError extends Error {
  readonly retryable: boolean;
  readonly orphanedProvenanceMessageId: string | null;
}
```

The pre-amendment interface in `docs/02_CLIP_IMPLEMENTATION_PLAN.md` §A returns a single
`archiveMessageId`. That predates the 2026-08-18 two-message amendment; `prisma/schema.prisma`
already carries `archive_provenance_message_id` **and** `archive_forward_message_id`, and the
schema is the newer authority. Do not "restore" the singular form.

### Done check
`pnpm test tests/clip/authorization.test.ts` green; `pnpm lint` clean. `lib/clip/types.ts` compiles
with no implementation importing it yet.

---

## Task 2 — Clip repository: transactions and row locking (`2.2`, issue #20)

### Files
Create `lib/clip/repository.ts`, `tests/clip/repository.test.ts`, and one new migration under
`prisma/migrations/`. Depends on Task 1.

**This is the correctness core of the product. Do not weaken a test to make it pass.**

### The exported surface

```ts
// Verify both paths against lib/db.ts, which already imports the generated client.
import type { ClipStatus, Prisma } from '@/generated/prisma/client';

export type TxClient = Prisma.TransactionClient;

export type ClipRecord = {
  guildId: string;
  sourceMessageId: string;
  sourceChannelId: string;
  authorUserId: string;
  status: ClipStatus;
  archiveProvenanceMessageId: string | null;
  archiveForwardMessageId: string | null;
};

/** Creates the canonical Clip if absent. Never resurrects: see the note below. */
export function claimClip(input: {
  guildId: string;
  sourceMessageId: string;
  sourceChannelId: string;
  authorUserId: string;
}): Promise<{ created: boolean; clip: ClipRecord }>;

/**
 * Runs `fn` with the canonical Clip row locked `FOR UPDATE` for the duration of the
 * transaction. Resolves to null without calling `fn` if the Clip does not exist.
 */
export function lockClip<T>(
  guildId: string,
  sourceMessageId: string,
  fn: (tx: TxClient, clip: ClipRecord) => Promise<T>,
): Promise<T | null>;

// Every method below takes `tx` first, so it cannot be called outside a lock.
export function addClipper(tx: TxClient, input: { guildId: string; sourceMessageId: string; clipperUserId: string }): Promise<{ added: boolean }>;
export function removeClipper(tx: TxClient, input: { guildId: string; sourceMessageId: string; clipperUserId: string }): Promise<{ removed: boolean; remaining: number }>;
export function countClippers(tx: TxClient, guildId: string, sourceMessageId: string): Promise<number>;

export function markActive(tx: TxClient, guildId: string, sourceMessageId: string, archive: ArchiveMessageIds): Promise<void>;
export function markDeleting(tx: TxClient, guildId: string, sourceMessageId: string): Promise<void>;
export function markFailed(tx: TxClient, guildId: string, sourceMessageId: string): Promise<void>;
export function markRemovedByAuthor(tx: TxClient, guildId: string, sourceMessageId: string, now: Date): Promise<void>;
export function markRemovedByAdmin(tx: TxClient, guildId: string, sourceMessageId: string, now: Date): Promise<void>;

/** Clears both archive ids. Only legal while the Clip is not ACTIVE — the CHECK enforces it. */
export function clearArchiveMessageIds(tx: TxClient, guildId: string, sourceMessageId: string): Promise<void>;

/** Drops every preservation signal, keeping the Clip row. Used when tombstoning. */
export function deleteClippers(tx: TxClient, guildId: string, sourceMessageId: string): Promise<void>;

/** Ordinary deletion: removes the clipper rows, then the Clip row. Leaves no tombstone. */
export function deleteClipWithClippers(tx: TxClient, guildId: string, sourceMessageId: string): Promise<void>;

/** Reads for the service. Null when the guild has never completed setup. */
export function findGuildArchiveConfig(guildId: string): Promise<{ archiveChannelId: string; allowedRoleIds: string[] } | null>;
```

### `claimClip` must not be an upsert

Prisma's reflex here is `upsert`, and its `update` branch is a resurrection path straight over a
`REMOVED_BY_AUTHOR` row — precisely the harassment loop §7.4 exists to prevent. An
application-level pre-read (`findUnique`, then create if absent) satisfies the tombstone rule but
breaks *"never check-then-insert"*, and would let ten concurrent callers each observe "absent".

Use an insert that the database itself de-duplicates, then read the row back and let the caller
branch on `status`:

```ts
const { count } = await prisma.clip.createMany({
  data: [{ guildId, sourceMessageId, sourceChannelId, authorUserId }],
  skipDuplicates: true, // emits ON CONFLICT DO NOTHING — no exception-driven control flow
});
const clip = await prisma.clip.findUniqueOrThrow({
  where: { guildId_sourceMessageId: { guildId, sourceMessageId } },
});
return { created: count === 1, clip };
```

Reading after the fact is safe: the conditional insert has already decided the winner, and nothing
ever rewrites a Clip's `guildId`, `sourceMessageId`, `sourceChannelId` or `authorUserId`.

### `lockClip` must hand the transaction to its callback

```ts
export function lockClip<T>(guildId, sourceMessageId, fn: (tx: TxClient, clip: ClipRecord) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$executeRaw`
      SELECT 1 FROM clips
      WHERE guild_id = ${guildId} AND source_message_id = ${sourceMessageId}
      FOR UPDATE
    `;
    if (locked === 0) {
      return null;
    }
    const clip = await tx.clip.findUniqueOrThrow({
      where: { guildId_sourceMessageId: { guildId, sourceMessageId } },
    });
    return fn(tx, clip);
  });
}
```

If a callback could reach the module-level `prisma` instead of `tx`, it would check out a *second*
pool connection while holding the first — a deadlock under load, not merely slowness. Passing `tx`
as a parameter is what makes that unwritable. Verify empirically that `$executeRaw` returns the row
count for a `SELECT`; if it does not on this Prisma version, use `$queryRaw` and test `length`.

### The deferred CHECK constraint lands here

Wave 1 deferred this and it belongs to this task, because it **forces** Task 3's write ordering:

```sql
ALTER TABLE clips ADD CONSTRAINT clips_active_requires_archive
  CHECK (
    status <> 'ACTIVE'
    OR (archive_provenance_message_id IS NOT NULL AND archive_forward_message_id IS NOT NULL)
  );
```

With it in place the archive ids cannot be nulled while the Clip is `ACTIVE`, so the only legal
paths are `ACTIVE → DELETING → (delete on Discord) → clear ids` and, on revival,
`DELETING → (recreate on Discord) → set ids → ACTIVE`. That ordering is what makes §9.3
implementable at all: clearing the ids in the same locked transaction that records a *successful*
Discord delete is the only thing that later lets the finalizer distinguish "already deleted, must
recreate" from "not yet attempted".

This is also the database-level half of the product invariant *"never reach ACTIVE with a missing or
partial Discord archive"* — it holds even against code that has not been written yet.

Prisma cannot express `CHECK` declaratively. Generate an empty migration and hand-write the SQL:

```bash
pnpm prisma migrate dev --create-only --name clip_active_requires_archive
# edit the generated migration.sql, then:
pnpm prisma migrate dev
```

**A new migration, never an edit to `init_clip_control_plane`.** That migration is already applied
in the running database; editing it is a Prisma checksum mismatch.

### Do not add `onDelete: Cascade` to the Clipper foreign key

It is restrictive today, which means the revival race fails *loudly* if a clipper row still exists
when the finalizer tries to delete the Clip. Cascade would convert that loud failure into silent
loss of a live preservation signal. If making a test pass seems to require cascade, the test is
wrong — stop and report it.

### Requirements — tests first, real Postgres, `Promise.all` after a pool warm-up
- [ ] **10 simultaneous first Clips → exactly one canonical Clip.** Assert `created === true`
      **exactly once** across the ten results, and exactly one row in `clips`. Not "at least once".
- [ ] **Same user clipping twice, simultaneously → exactly one Clipper.** `added === true` exactly
      once; exactly one row in `clippers`.
- [ ] **Two simultaneous Unclips from two different clippers → `remaining: 0` reported exactly
      once**, and `remaining: 1` exactly once. Both callers observing `0` is the defect this test
      exists to catch, so assert the multiset of returned counts, not just its minimum.
- [ ] **An author tombstone blocks a later normal claim.** After `markRemovedByAuthor`, a fresh
      `claimClip` returns `created: false` with `status: 'REMOVED_BY_AUTHOR'` — and does **not**
      revive the row.
- [ ] **The CHECK constraint rejects an ACTIVE Clip with missing archive ids**, asserted as a
      Postgres constraint violation, so the test fails if the constraint is dropped.
- [ ] `deleteClipWithClippers` removes both tables' rows and leaves no tombstone; a subsequent
      `claimClip` creates a fresh `PENDING` Clip.

### Mutation checks to run before reporting done
Break each one, confirm the named test fails, then restore:
1. Replace the `skipDuplicates` insert with `findUnique`-then-`create` → test 1 must fail.
2. Drop `FOR UPDATE` from `lockClip` → test 3 must fail.
3. Drop the CHECK constraint → test 5 must fail.
4. Remove the pool warm-up from any race test → report whether it still passes. If it does, the
   test is not racing and must be rewritten.

Then run the whole suite with `?connection_limit=2` appended to `DATABASE_URL`, several times.
Wave 1 used exactly this to prove an interactive transaction was not starving the pool.

### Answer the partial-write question in the report
For `claimClip`, `removeClipper` and `deleteClipWithClippers`: if the second write fails, what is
committed, and can the user retry?

### Done check
`pnpm test tests/clip/repository.test.ts` green; the migration applies clean; `pnpm lint` clean.

### Spec
§7, §9 (all ten invariants), §16 tombstone retention.

---

## Task 3 — ClipService against a fake gateway (`2.3`, issue #21)

### Files
Create `lib/clip/state-machine.ts`, `lib/clip/service.ts`, `tests/clip/fake-gateway.ts`,
`tests/clip/service.test.ts`. Modify `lib/logging/safe-log.ts` and
`tests/logging/safe-log.test.ts` (see "the log allowlist" below). Depends on Tasks 1 and 2.

The fake gateway captures side effects, so the entire state machine is proven before any REST code
exists. Tests run against the real Postgres — only Discord is faked.

### `lib/clip/state-machine.ts`

A pure transition table plus `assertTransition(from, to)`, which throws on an illegal move. Legal
transitions:

```text
PENDING            → ACTIVE, FAILED
FAILED             → ACTIVE, DELETING
ACTIVE             → DELETING, REMOVED_BY_AUTHOR, REMOVED_BY_ADMIN
DELETING           → ACTIVE            (revival: a signal arrived during deletion)
PENDING/FAILED/ACTIVE/DELETING → REMOVED_BY_AUTHOR, REMOVED_BY_ADMIN
REMOVED_BY_AUTHOR  → (terminal)
REMOVED_BY_ADMIN   → (terminal)
```

Terminal means terminal: author/admin removal overrides every preservation signal and cannot be
undone by a normal Clip (§7.4, §9.9). The tombstone is the `REMOVED_BY_*` Clip row itself, retained
while the guild remains configured (§16). Nothing in this wave expires a tombstone; only the
admin's explicit "delete Clip data" action in `5.4` removes one.

**Clipper rows are deleted when a Clip is tombstoned.** §7.4 says removal overrides all clipper
signals; leaving them behind would mean a later Unclip on a tombstoned Clip reports a signal that no
longer means anything. `NOT_CLIPPED_BY_USER` is the honest answer there. Do not change this to keep
a test convenient.

### `lib/clip/service.ts`

```ts
export function createClipService(gateway: DiscordArchiveGateway): {
  clip(input: ClipInput): Promise<ClipCommandResult>;
  unclip(input: UnclipInput): Promise<UnclipResult>;
  removeByAuthorOrAdmin(input: RemoveInput): Promise<RemoveResult>;
};
```

**`clip`:**
1. `findGuildArchiveConfig(guildId)`. Null → `{ kind: 'FAILED', retryable: false }` — an
   unconfigured guild fails safely until an admin configures it (§17 case 12). No DB write.
2. `canClip({ hasManageGuild: input.clipperHasManageGuild, memberRoleIds: input.clipperRoleIds,
   allowedRoleIds })`. False → `NOT_AUTHORIZED`, with no DB write and no gateway call.
3. `claimClip(...)`.
   - `status` is `REMOVED_BY_AUTHOR` or `REMOVED_BY_ADMIN` → `REMOVED_BY_AUTHOR_OR_ADMIN`. No
     clipper is added.
   - `created: false` and the clip is live → `lockClip`, `addClipper`. `added: false` →
     `ALREADY_CLIPPED_BY_USER` with the current ids. `added: true` → `CLIPPER_ADDED`. **No gateway
     call on either branch** — invariant §9.4: only the request that claimed a *new* Clip may create
     the archive.
   - `created: true` → `lockClip`, `addClipper`, then create the archive (below).
4. Archive creation, outside the lock (it is a network call):
   `gateway.createArchiveMessage(...)` → on success, re-enter `lockClip` and `markActive` with both
   ids → `CREATED`.
   - `ArchiveTargetUnavailableError` → `markFailed`, return `SOURCE_UNAVAILABLE`.
   - `ArchiveCreationFailedError` → if `orphanedProvenanceMessageId` is set, best-effort
     `deleteArchiveMessage` for the orphan; `markFailed`; return `{ kind: 'FAILED', retryable }`.
     **Never `markActive`** (§17 cases 7 and 19).

**`unclip`:**
1. `lockClip`. Null → `NOT_FOUND`.
2. `removeClipper`. `removed: false` → `NOT_CLIPPED_BY_USER`.
3. `remaining > 0` → return `{ kind: 'UNCLIPPED', remaining }`; the archive stays.
4. `remaining === 0` → `markDeleting` inside the same lock, capture the ids, release the lock, then
   run the finalizer below. Return `{ kind: 'UNCLIPPED', remaining: 0 }`.

**The deletion finalizer — this is §9.3, and it is the hardest thing in the wave:**
1. `gateway.deleteArchiveMessage(channelId, ids)`.
2. Re-enter `lockClip` and **re-read state**:
   - `clearArchiveMessageIds` first — the Discord delete succeeded, and the row must say so before
     the lock is released, or a concurrent revival cannot tell whether content still exists.
   - `countClippers === 0` → `deleteClipWithClippers`. Done.
   - `countClippers > 0` → the Clip was revived while deletion was in flight. Leave it `DELETING`
     with null ids and exit the lock.
3. On revival, recreate outside the lock: `createArchiveMessage`, then `lockClip` + `markActive`
   with the new ids. **Recreate before the final ACTIVE, never after** — the CHECK constraint makes
   the wrong order impossible to commit, which is the point of adding it in Task 2.
4. If the Clip was tombstoned while deletion was in flight, the terminal state wins: do not revive.

**`removeByAuthorOrAdmin`:**
1. `lockClip`. Null → `NOT_FOUND`.
2. Authorized if `invokerUserId === clip.authorUserId` **or** `invokerHasManageGuild`. Otherwise
   `NOT_AUTHORIZED`. This is not `canClip` — a configured clip role does not grant removal.
3. Capture the ids, `markRemovedByAuthor` or `markRemovedByAdmin` (by which test passed),
   `deleteClippers`, release the lock.
4. `deleteArchiveMessage` for the captured ids. A failure here leaves a tombstone whose ids point at
   messages that may still exist — recoverable, and preferable to leaving the Clip clippable.
   Report which choice you made and why.

### The log allowlist changes with the amendment

`SafeClipLog` in `lib/logging/safe-log.ts` carries a single `archiveMessageId`, which predates the
two-message representation and no caller uses yet. Replace it with `archiveProvenanceMessageId` and
`archiveForwardMessageId` in `SafeClipLog` and in `SAFE_KEYS`, and update
`tests/logging/safe-log.test.ts`.

Do this **deliberately and in this task's commit, with a comment saying why.** That file's entire
design is that changing `SAFE_KEYS` is a conscious act; a silent widening is the failure mode it
was written to prevent. Log every state transition (`stateFrom`, `stateTo`) and every error code —
never anything that could carry message content.

### Requirements — tests first, fake gateway, real Postgres
- [ ] **First clip:** Clip claimed `PENDING` → clipper added → **exactly one**
      `createArchiveMessage` call → `markActive`. Final status `ACTIVE` with both ids set.
- [ ] **Second, different user clips:** result `CLIPPER_ADDED`; the fake records **no** second
      `createArchiveMessage` call.
- [ ] **Same user clips twice:** result `ALREADY_CLIPPED_BY_USER`; one clipper row; no second
      gateway call.
- [ ] **Unauthorized member:** `NOT_AUTHORIZED`, zero rows written, zero gateway calls. (Not in the
      issue brief — without it the union member is unreachable and the check could be deleted with
      the suite still green.)
- [ ] **Last unclip:** `DELETING` → `deleteArchiveMessage` called with **both** ids → Clip row and
      clipper rows gone.
- [ ] **One of several unclips:** `remaining: 1`, archive untouched, zero delete calls.
- [ ] **Author removal:** archive deleted, tombstone `REMOVED_BY_AUTHOR` retained, clipper rows
      gone; a later `clip` by anyone returns `REMOVED_BY_AUTHOR_OR_ADMIN` and creates no archive.
- [ ] **Admin removal:** same override, tombstone `REMOVED_BY_ADMIN`.
- [ ] **Archive creation fails:** `markFailed`, result `FAILED`, status is `FAILED` — never
      `ACTIVE`. A retry then succeeds and reaches `ACTIVE`.
- [ ] **Provenance posted, forward failed** (§17 case 19): the fake throws
      `ArchiveCreationFailedError` with `orphanedProvenanceMessageId`. Assert the orphan is deleted,
      status is `FAILED`, and no id pair is stored.
- [ ] **Delete/new-clip race** (§9.3): drive it deterministically by having the fake's
      `deleteArchiveMessage` invoke a hook that performs a concurrent `clip` before it resolves.
      Assert the run converges to `ACTIVE` with a **new**, different id pair — proving the archive
      was recreated after the delete rather than left pointing at deleted content.
- [ ] **Delete/no-revival race:** same hook, but the hook does nothing. Assert the Clip row is
      deleted and `createArchiveMessage` was called exactly once for the whole run.

### Mutation checks to run before reporting done
1. Make the second clipper's path also call `createArchiveMessage` → the "no second archive" test
   must fail.
2. Move `markActive` before `createArchiveMessage` → the CHECK constraint or the failure test must
   reject it.
3. Let `REMOVED_BY_AUTHOR` fall through to the normal claim path → the tombstone test must fail.
4. Delete `clearArchiveMessageIds` from the finalizer → the revival race test must fail.

### Answer the partial-write question in the report
For the first-clip flow, the finalizer, and removal: if the second write fails, what is committed,
and can the user retry? Name the state the system is left in for each.

### Done check
`pnpm test` fully green (Wave 1's 77 plus this wave's), `pnpm lint` clean, `pnpm build` OK.

### Spec
§7, §9, §16, §17 cases 5–8, 16, 19.

---

## Wave exit

- [ ] All three tasks committed, one commit each.
- [ ] Full gate green: `pnpm lint`, `pnpm test`, `pnpm build`.
- [ ] Mutation checks from Tasks 2 and 3 run and reported, with the code restored.
- [ ] `docs/journal/journal-2026-08.md` — technical findings and dead ends.
- [ ] `docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md` — one wave entry using the §0 template, plus an
      **immediate** entry for any AI proposal that turned out wrong.
- [ ] PR against `main` closing #19, #20, #21. Merge gate: *concurrency tests green against real
      Postgres*.

Both documentation files are append-only and are edited by every wave, so this branch **will**
conflict with `main` on them. Resolve by keeping **both** sides in chronological order. A wave PR
that conflicts never runs CI at all — GitHub cannot compute the merge commit — and shows only a
CodeRabbit tick, which is easy to misread as passing. Check `mergeStateStatus` before believing a
PR is green.
