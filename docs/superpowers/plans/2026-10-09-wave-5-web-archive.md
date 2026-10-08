# Wave 5: Web Archive, Settings, and Guild-Data Deletion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the admin web surfaces cut in August: the read-only archive (Screen D), the settings page with guild-data deletion (Screen E), and the guild lifecycle boundary (advisory lock + `GuildConfig.configurationId`). Route configured guilds through them, and fix #58 and #59.

**Architecture:**
- One per-guild, transaction-scoped Postgres advisory lock serializes every guild control-plane writer: setup-token issuance and exchange, config finalization, deletion, and every Clip row-lock transaction. The advisory lock is always taken first, before any row lock.
- `configurationId` is created once with the config row. Clip operations capture it and recheck it under the lock, so a completion that started before a delete-and-re-setup is discarded instead of landing on the new config.
- Admin pages are thin async server pages. Each one authenticates the cookie, checks that the session's guild matches the path, and loads metadata from Postgres. Client components fetch live Discord content through a bounded, session-gated batch route.

**Tech Stack:** Next.js 16 App Router (async `params`/`searchParams`/`cookies()`), React 19, CSS modules + `tokens.css`, Prisma 7 on PostgreSQL 18, Zod 4, Vitest 4 + Testing Library (jsdom), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-05-p0-restoration-design.md`. Task briefs are #31 (5.1), #32 (5.2), #33 (5.3), #34 (5.4), #12 (F.5), #58, and #59. The UI source is `docs/06_DESIGN_HANDOFF.md` (Clip card, Screens D/E, Interactions, State, Accessibility).

## Global Constraints

- One branch and one PR: `wave/5-web-archive`, worktree `/Users/ori/repos/clip-wave5`. Never commit to `main`. Use Conventional Commits, one commit per task (or per step where the task says so).
- The gate before the PR is `pnpm lint && pnpm test && pnpm build`, against real Postgres 18: container `clip-pg`, `localhost:5433`, `export DATABASE_URL=postgresql://clip:clip@localhost:5433/clip_dev`. Read the Vitest `Errors` line, not only the pass count.
- TDD. Write the failing test first and record the RED reason. Concurrency invariants are tested against real Postgres, not mocks.
- Copy:
  - Korean copy comes only from `docs/06_DESIGN_HANDOFF.md` (`WEB_COPY`/`WEB_COPY_TEMPLATES`) or from Ori-approved strings (`WEB_COPY_AUTHORED`, with attribution). Never invent Korean, including aria-labels.
  - The nine design-table strings were approved by Ori on 2026-10-09.
  - The #58 string is **pending Ori**. Task 13 has a copy gate for it.
- Visual values:
  - `tokens.css` is the only source of visual values. A handoff value with no token becomes a named token in `tokens.css` (§10.7 precedent).
  - `--faint` is used only in disabled-only rules; `tests/ui/primitives.test.tsx` enforces this.
  - No shadows, gradients, blur, or animation beyond the 120ms hover color.
  - Radius is 2px (1px for chips).
  - Monospace is for machine values only.
- Never persist or log raw message bodies, attachments, embed payloads, or Discord response bodies. Never log bearer values.
- Never reach `ACTIVE` with a missing or partial archive. Use DB uniqueness or an upsert, never check-then-insert. Never weaken an invariant to make a test pass.
- Do not add reaction/vote/rank counts, a theme switcher, search, caching, a content proxy, or `next/image` optimization.
- Next 16 specifics:
  - Pages take `params: Promise<…>` and `searchParams: Promise<…>`.
  - `cookies()` is async.
  - A page that reads cookies is dynamically rendered, and Next sends `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` for it.
  - Route handlers set `Cache-Control: private, no-store` explicitly on authenticated JSON.
  - `PageProps<'/route'>` and `RouteContext<'/route'>` are global helper types; `app/setup/[token]/page.tsx` already uses `PageProps`.
- Lock order is **advisory guild lock → `guild_configs` row → `clips` row**, in every transaction. No Discord I/O inside any lock.

## Decisions Recorded For This Plan

| # | Decision | Source |
|---|---|---|
| D1 | The configured-guild routing follows the design. A fresh `/setup` link for a configured guild goes to `/admin/:guildId/settings` (Screen E). `설정 변경` opens `/admin/:guildId/setup`, the prefilled Screen B. A successful edit returns to Screen E with the `설정을 저장했습니다.` toast. First setup stays Screen B → Screen C, and Screen C's actions open `/admin/:guildId/archive` and `/admin/:guildId/settings`. | Ori, 2026-10-09 |
| D2 | #59: the `LIVE_CLIPS` refusal gets an `아카이브 열기` link to `/admin/:guildId/archive`. No new copy. | Ori, 2026-10-09 |
| D3 | Nine strings (spec copy table rows 123–131) approved as drafted. | Ori, 2026-10-09 |
| D4 | Spec over #32. Each archive row makes **two** Discord reads: the forward (content) and the source message (reply metadata and original availability). #32's "one request per row" predates the spec's reply/original-availability contract. The cost is twice the reads per page, still capped at 4 concurrent. | Plan ruling |
| D5 | A session whose guild differs from the path is treated exactly like no session: API routes return 401 and pages render the session-expired screen. This leaks nothing about other guilds. | Plan ruling |
| D6 | Attachment previews use a plain `<img>` with the fresh Discord URL. `next/image` is not used: the spec forbids optimization and caches, and plain `<img>` needs no `remotePatterns` config. | Plan ruling |
| D9 | Every Clip row transaction takes the guild lock, so Clip writes within one guild run one at a time, even for different messages. The `ponytail:` comment in `lib/guild-lock.ts` gives the upgrade path: shared-mode advisory locks for Clip writers. | Plan ruling |
| D7 | `claimAuthorNotification`/`markAuthorNotificationDelivered` are **not** put under the guild lock. Worst case, after a delete and immediate re-setup, a stale run claims the new Clip's first-author DM, and the DM is skipped. §11.1 already treats that DM as best-effort. | Plan ruling, ponytail |

## Review Focus

1. **Delete, then immediate re-setup, while a Clip is between claim and publish.** The stale publish must not write `ACTIVE` onto the new guild's same-key Clip, and its Discord pair must be deleted quietly. Pinned by Task 5.
2. **A forward with no `message_snapshots`, or a malformed one.** This is `오류` (invalid payload), never `누락`. Only Discord codes 10008/10003 mean `누락`. Pinned by Task 9.
3. **Attachment, embed, or link URLs with a non-`https:` scheme** (`javascript:`, `data:`, `http:`). They never become an `href` or `src`; the row still renders. Pinned by Tasks 9 and 10.
4. **A stale cursor whose row has since been removed, or a malformed cursor.** A stale cursor still pages correctly, because the boundary is a value, not a row. A malformed cursor or channel id returns `{ kind: 'INVALID' }` and the page renders recovery, never an unbounded query. Pinned by Task 8.
5. **A filter option for a deleted source channel.** It is offered by id when the name lookup misses, and filtering by it works. Pinned by Tasks 8 and 11.

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma`, `prisma/migrations/20261009000000_guild_configuration_id_and_archive_index/migration.sql` | `configurationId` UUID column; `(guild_id, status, created_at, source_message_id)` index |
| `lib/guild-lock.ts` (new) | `lockGuild(tx, guildId)`, `withGuildLock(guildId, fn)` |
| `lib/clip/repository.ts` | Advisory lock in `lockClip`/`lockGuildConfig`; `configurationId` on config reads; `finalizeGuildArchiveConfig` under the lock with a session recheck; `deleteGuildData` |
| `lib/admin-session/repository.ts`, `service.ts` | Issuance and exchange under the guild lock; `isAdminSessionLive(tx, …)`; `sessionTokenHash()` |
| `lib/clip/service.ts` | Capture and recheck `configurationId` |
| `lib/admin/auth.ts` (new) | `authenticateAdminRequest`, `authenticateAdminPage`, `checkMutationRequest` |
| `app/api/admin/guilds/[guildId]/delete-data/route.ts` (new) | Deletion POST |
| `lib/archive/reader.ts` (new) | `getClipPage`, cursor codec |
| `lib/archive/content.ts` (new) | Discord reads → `ArchiveRowContent` view model, bounded concurrency |
| `lib/discord/guild-lookup.ts` | `getGuildChannelNames` |
| `app/api/admin/guilds/[guildId]/archive/content/route.ts` (new) | Batch content POST |
| `components/archive/ClipCard.tsx` + css (new) | F.5 card, all states |
| `components/admin/AdminHeader.tsx`, `SessionExpired.tsx`, `ConfigTable.tsx` + css (new) | Shared admin chrome |
| `app/admin/[guildId]/archive/page.tsx`, `ArchiveScreen.tsx` + css (new) | Screen D |
| `app/admin/[guildId]/settings/page.tsx`, `SettingsScreen.tsx` + css (new) | Screen E and the deletion flow |
| `app/admin/[guildId]/setup/page.tsx`, `AdminSetupEdit.tsx` (new) | Prefilled Screen B edit |
| `app/setup/[token]/SetupFlow.tsx`, `ScreenB.tsx`, `ScreenC.tsx`, `app/setup/data/route.ts`, `app/setup/save/route.ts` | Routing (D1), #58, #59, session recheck |
| `lib/ui/copy.ts`, `tokens.css`, `components/ui/Callout.tsx` | Approved copy, tokens, `missing` callout variant |
| `k8s/deployment.yaml`, `tests/scripts/render-k8s-deployment.test.ts` | `strategy: Recreate` |

---

### Task 0: Record approvals and commit the plan

- [ ] **Step 1: Mark the copy approvals in the spec.** In `docs/superpowers/specs/2026-10-05-p0-restoration-design.md`, append ` — **approved by Ori 2026-10-09**` to the "Condition" cell of rows 123–131 (from `Archive fetch failed transiently` through `Deletion failed`). Do not edit the Korean cells.
- [ ] **Step 2: Commit.**

```bash
git add docs/superpowers/plans/2026-10-09-wave-5-web-archive.md docs/superpowers/specs/2026-10-05-p0-restoration-design.md
git commit -m "docs(plan): Wave 5 web archive, settings and deletion plan"
```

---

### Task 1: Approved copy, tokens, and the `missing` callout

**Files:**
- Modify: `lib/ui/copy.ts`, `tokens.css`, `components/ui/Callout.tsx`, `components/ui/Callout.module.css`
- Test: `tests/ui/copy.test.ts`, `tests/ui/primitives.test.tsx`

**Interfaces:**
- Produces:
  - `WEB_COPY.clipCard.viewOriginal` (`'원본 보기'`)
  - `WEB_COPY_AUTHORED`: `archiveFetchFailed`, `archiveAccessDenied`, `archiveEmpty`, `archiveFilterEmpty`, `originalUnavailable`, `adminSessionExpiredTitle`, `deletionLosesControlState`, `deletionCompleted`, `deletionFailed`
  - `CalloutVariant` gains `'missing'`
  - New tokens (names below)

- [ ] **Step 1: Write the failing copy test.** Append to `tests/ui/copy.test.ts`, inside its top-level `describe`:

```ts
test('pins the Wave 5 strings Ori approved on 2026-10-09 exactly', () => {
  expect(WEB_COPY_AUTHORED.archiveFetchFailed).toBe('보관된 내용을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  expect(WEB_COPY_AUTHORED.archiveAccessDenied).toBe('아카이브 채널에 접근할 수 없습니다. Discord에서 Clip의 채널 권한을 확인해 주세요.');
  expect(WEB_COPY_AUTHORED.archiveEmpty).toBe('아직 보관된 메시지가 없습니다.');
  expect(WEB_COPY_AUTHORED.archiveFilterEmpty).toBe('이 채널에서 보관된 메시지가 없습니다.');
  expect(WEB_COPY_AUTHORED.originalUnavailable).toBe('원본 메시지를 찾을 수 없습니다.');
  expect(WEB_COPY_AUTHORED.adminSessionExpiredTitle).toBe('관리자 세션이 만료되었습니다');
  expect(WEB_COPY_AUTHORED.deletionLosesControlState).toBe(
    '보관 기록과 삭제 차단 기록이 사라집니다. 남아 있는 Discord 사본은 Clip에서 관리할 수 없으며, 같은 원본 메시지가 다시 보관될 수 있습니다.',
  );
  expect(WEB_COPY_AUTHORED.deletionCompleted).toBe(
    '이 서버의 Clip 데이터를 삭제했습니다. Discord 아카이브 채널과 그 안의 메시지는 그대로 남아 있습니다.',
  );
  expect(WEB_COPY_AUTHORED.deletionFailed).toBe('Clip 데이터를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.');
});

test('the clip card action reuses the handoff label', () => {
  expect(WEB_COPY.clipCard.viewOriginal).toBe('원본 보기');
});
```

If the file's existing `WEB_COPY_AUTHORED` exact-pin test lists every key (check around `tests/ui/copy.test.ts:151–161`), extend that list with the nine keys instead of duplicating them.

- [ ] **Step 2: Run it and confirm RED.**

Run: `pnpm vitest run tests/ui/copy.test.ts`
Expected: FAIL. The new keys are `undefined`.

- [ ] **Step 3: Add the copy.** In `lib/ui/copy.ts`:
  - Add `viewOriginal: '원본 보기',` to `WEB_COPY.clipCard`, with the comment `/** The card's single secondary action. Handoff: author DM actions. */`. The verbatim test then confirms it appears in the handoff.
  - Append to `WEB_COPY_AUTHORED`:

```ts
  /**
   * Wave 5 archive, session and deletion copy — drafted in
   * docs/superpowers/specs/2026-10-05-p0-restoration-design.md and approved
   * by Ori on 2026-10-09.
   */
  archiveFetchFailed: '보관된 내용을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
  archiveAccessDenied: '아카이브 채널에 접근할 수 없습니다. Discord에서 Clip의 채널 권한을 확인해 주세요.',
  archiveEmpty: '아직 보관된 메시지가 없습니다.',
  archiveFilterEmpty: '이 채널에서 보관된 메시지가 없습니다.',
  originalUnavailable: '원본 메시지를 찾을 수 없습니다.',
  adminSessionExpiredTitle: '관리자 세션이 만료되었습니다',
  deletionLosesControlState:
    '보관 기록과 삭제 차단 기록이 사라집니다. 남아 있는 Discord 사본은 Clip에서 관리할 수 없으며, 같은 원본 메시지가 다시 보관될 수 있습니다.',
  deletionCompleted:
    '이 서버의 Clip 데이터를 삭제했습니다. Discord 아카이브 채널과 그 안의 메시지는 그대로 남아 있습니다.',
  deletionFailed: 'Clip 데이터를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.',
```

- [ ] **Step 4: Add the tokens.** In `tokens.css`, append this to `:root`, after `--sp-option-x`:

```css
  /* Wave 5 — Screens D/E and the clip card. docs/06_DESIGN_HANDOFF.md "Clip card", "Screen D", "Screen E". */
  --card-pad-x: 18px;           /* clip card horizontal padding (vertical reuses --sp-4) */
  --card-pad-x-narrow: 12px;    /* ≤640px card padding, both axes */
  --avatar-size: 22px;          /* source-line avatar square */
  --avatar-surface: #2a2e34;
  --channel-text: #8b9096;      /* source-line channel name, 11px mono */
  --code-surface: #08090b;
  --code-border: #23262b;
  --code-text: #a8b4c0;
  --attachment-size: 104px;     /* striped attachment placeholder / preview box height */
  --skeleton-strong: #23262b;
  --skeleton-weak: #1c1f23;
  --skeleton-height: 9px;
  --missing-surface: #0d0e10;   /* missing-copy row background */
  --pager-disabled-fg: #4a4e54; /* disabled 이전/다음 — disabled control only */
  --pager-disabled-border: #23262b;
  --w-settings-main: 460px;
  --w-settings-confirm: 400px;
```

The `tests/ui/primitives.test.tsx` check confines `--faint` to disabled rules. `--pager-disabled-fg` is a separate token used only under `:disabled`/`[aria-disabled="true"]` selectors (Task 11).

- [ ] **Step 5: Write the failing Callout test.** Add to `tests/ui/primitives.test.tsx`, in the same style as the existing Callout tests:

```tsx
test('Callout missing variant leads with the 누락 tag', () => {
  render(<Callout variant="missing">본문</Callout>);
  expect(screen.getByText('누락')).toBeInTheDocument();
});
```

- [ ] **Step 6: Run it and confirm RED.**

Run: `pnpm vitest run tests/ui/primitives.test.tsx -t "missing variant"`
Expected: FAIL. `TAG_TEXT.missing` is undefined, so no `누락` is rendered. It is also a type error caught by lint.

- [ ] **Step 7: Implement the variant.** In `components/ui/Callout.tsx`:
  - Change the variant type to `export type CalloutVariant = 'note' | 'ok' | 'confirm' | 'error' | 'missing';`.
  - Add `missing: WEB_COPY.tags.missing,` to `TAG_TEXT`.

In `components/ui/Callout.module.css`, add a `.missing` rule that mirrors the existing `.confirm` rule, using `--warning-surface`, `--warning-border` and `--warning-text`. Read `.confirm` first and copy its property list, swapping only the tokens.

- [ ] **Step 8: Run GREEN, then commit.**

Run: `pnpm vitest run tests/ui && pnpm lint`
Expected: PASS, lint exit 0.

```bash
git add lib/ui/copy.ts tokens.css components/ui/Callout.tsx components/ui/Callout.module.css tests/ui/copy.test.ts tests/ui/primitives.test.tsx
git commit -m "feat(ui): add Wave 5 approved copy, archive tokens and the missing callout"
```

---

### Task 2: Schema — `configurationId` and the archive index

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261009000000_guild_configuration_id_and_archive_index/migration.sql`
- Test: `tests/clip/repository.test.ts`

**Interfaces:**
- Produces:
  - `GuildConfig.configurationId: string` (UUID). The DB generates it on insert; nothing ever updates it.
  - The index `clips_guild_status_created_idx`.

- [ ] **Step 1: Write the failing test.** Add to `tests/clip/repository.test.ts`:

```ts
test('a configuration keeps its configurationId across edits', async () => {
  const guildId = trackedGuildId();
  const base = { guildId, configuredByUserId: fakeSnowflake(), allowedRoleIds: [] };
  await upsertGuildArchiveConfig({ ...base, archiveChannelId: fakeSnowflake() });
  const first = await prisma.guildConfig.findUniqueOrThrow({ where: { guildId } });
  expect(first.configurationId).toMatch(/^[0-9a-f-]{36}$/);

  await upsertGuildArchiveConfig({ ...base, archiveChannelId: fakeSnowflake(), allowedRoleIds: [fakeSnowflake()] });
  const second = await prisma.guildConfig.findUniqueOrThrow({ where: { guildId } });
  expect(second.configurationId).toBe(first.configurationId);
});

test('a configuration recreated after deletion gets a new configurationId', async () => {
  const guildId = trackedGuildId();
  const input = { guildId, archiveChannelId: fakeSnowflake(), configuredByUserId: fakeSnowflake(), allowedRoleIds: [] };
  await upsertGuildArchiveConfig(input);
  const first = await prisma.guildConfig.findUniqueOrThrow({ where: { guildId } });
  await prisma.guildConfig.delete({ where: { guildId } });
  await upsertGuildArchiveConfig(input);
  const second = await prisma.guildConfig.findUniqueOrThrow({ where: { guildId } });
  expect(second.configurationId).not.toBe(first.configurationId);
});
```

- [ ] **Step 2: Run it and confirm RED.**

Run: `pnpm vitest run tests/clip/repository.test.ts -t configurationId`
Expected: FAIL. TypeScript/Prisma reports that `configurationId` does not exist on the row (it is `undefined`).

- [ ] **Step 3: Change the schema.** In `prisma/schema.prisma`:
  - In `model GuildConfig`, after `guildId`, add:

```prisma
  /// Identity of this configuration's lifetime. Generated by the database when
  /// the row is created and never updated, so a deletion followed by re-setup
  /// yields a new value. Clip operations capture it and recheck it under the
  /// guild lock (lib/guild-lock.ts) before each later write.
  configurationId    String   @default(dbgenerated("gen_random_uuid()")) @map("configuration_id") @db.Uuid
```

  - In `model Clip`, add `@@index([guildId, status, createdAt, sourceMessageId], map: "clips_guild_status_created_idx")` before `@@map("clips")`.

- [ ] **Step 4: Write the migration by hand.** Then make sure Prisma agrees with it.

```sql
-- configuration_id: existing rows get a value from the default.
ALTER TABLE "guild_configs" ADD COLUMN "configuration_id" UUID NOT NULL DEFAULT gen_random_uuid();

-- Screen D ordering: ACTIVE rows newest first, ties broken by source_message_id.
CREATE INDEX "clips_guild_status_created_idx" ON "clips"("guild_id", "status", "created_at", "source_message_id");
```

Run: `export DATABASE_URL=postgresql://clip:clip@localhost:5433/clip_dev && pnpm prisma migrate deploy && pnpm prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$DATABASE_URL" --exit-code; echo "diff exit $?"`
Expected: `diff exit 0`, so the schema and migrations agree. If the `--shadow-database-url` flag is rejected by this Prisma version, run `pnpm prisma migrate diff --help` and use its equivalent; never edit an applied migration.

Then run `pnpm prisma generate`.

- [ ] **Step 5: Run GREEN, then commit.**

Run: `pnpm vitest run tests/clip`
Expected: PASS.

```bash
git add prisma tests/clip/repository.test.ts
git commit -m "feat(db): add GuildConfig.configurationId and the archive ordering index"
```

---

### Task 3: The guild advisory lock

**Files:**
- Create: `lib/guild-lock.ts`
- Modify: `lib/clip/repository.ts` (`GuildArchiveConfig`, `guildArchiveConfigSelect`, `guildArchiveConfigOf`, `lockClip`, `lockGuildConfig`)
- Test: `tests/clip/guild-lock.test.ts` (new), `tests/clip/repository.test.ts`

**Interfaces:**
- Produces:
  - `lockGuild(tx: TxClient, guildId: string): Promise<void>`
  - `withGuildLock<T>(guildId: string, fn: (tx: TxClient) => Promise<T>): Promise<T>`
  - `GuildArchiveConfig` gains `configurationId: string`
  - `lockClip(guildId, sourceMessageId, fn, options?: { configurationId?: string })`. With a `configurationId` that no longer matches the guild's current config (or with no config), it resolves to `null` without calling `fn`.

- [ ] **Step 1: Write the failing lock test.** Create `tests/clip/guild-lock.test.ts`, using the env-stub and `warmConnectionPool` pattern from `tests/clip/repository.test.ts:40–90` (copy those helpers):

```ts
test('withGuildLock serializes two writers on the same guild', async () => {
  const guildId = fakeSnowflake();
  await warmConnectionPool(2);
  const firstHolds = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const order: string[] = [];

  const first = withGuildLock(guildId, async () => {
    order.push('first-start');
    firstHolds.resolve();
    await releaseFirst.promise;
    order.push('first-end');
  });
  await firstHolds.promise;
  const second = withGuildLock(guildId, async () => {
    order.push('second');
  });

  try {
    await vi.waitFor(
      async () => {
        const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock' AND wait_event = 'advisory'
          ) AS blocked`;
        expect(row?.blocked).toBe(true);
      },
      { timeout: 2_000, interval: 10 },
    );
  } finally {
    releaseFirst.resolve();
  }
  await Promise.all([first, second]);
  expect(order).toEqual(['first-start', 'first-end', 'second']);
});

test('withGuildLock does not block a different guild', async () => {
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = withGuildLock(fakeSnowflake(), async () => {
    holding.resolve();
    await release.promise;
  });
  await holding.promise;
  await withGuildLock(fakeSnowflake(), async () => {}); // must not wait
  release.resolve();
  await first;
});
```

- [ ] **Step 2: Run it and confirm RED.**

Run: `pnpm vitest run tests/clip/guild-lock.test.ts`
Expected: FAIL. The module `@/lib/guild-lock` cannot be resolved.

- [ ] **Step 3: Implement `lib/guild-lock.ts`.**

```ts
import type { TxClient } from '@/lib/clip/repository';
import { getPrismaClient } from '@/lib/db';

/**
 * Takes this guild's transaction-scoped advisory lock on `tx`. Postgres
 * releases it at commit or rollback; there is no unlock call.
 *
 * Every guild control-plane writer takes this lock first, before any row
 * lock: setup-token issuance and exchange, configuration finalization,
 * guild-data deletion, and every Clip row-lock transaction. That one order
 * is what keeps the combination deadlock-free. It also covers the cases a
 * row lock cannot: first setup has no `guild_configs` row to lock, and a
 * deletion removes the rows a row lock would wait on.
 *
 * The key is `hashtextextended` of a namespaced guild id, so the lock space
 * is shared with nothing else and works for any id string, including the
 * non-numeric ones the tests generate. Two guilds colliding on one 64-bit
 * hash would only serialize them; it can never let two writers to one guild
 * run together.
 *
 * `$executeRaw`, not `$queryRaw`: the function returns `void`, which the
 * driver adapter has no column type to deserialize into.
 *
 * ponytail: this serializes every Clip write in a guild, not just writes to
 * one message. That is fine at a guild's interaction rate. If it ever
 * measures slow, keep the guild lock for lifecycle writers only and have
 * Clip writers take it in shared mode (`pg_advisory_xact_lock_shared`).
 */
export async function lockGuild(tx: TxClient, guildId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`clip.guild:${guildId}`}, 0))`;
}

/** Runs `fn` in a new transaction holding the guild lock. No Discord I/O inside. */
export function withGuildLock<T>(guildId: string, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return getPrismaClient().$transaction(async (tx) => {
    await lockGuild(tx, guildId);
    return fn(tx);
  });
}
```

If `$executeRaw` rejects a `SELECT`, look at how `lockClip` already runs `SELECT 1 … FOR UPDATE` through `$executeRaw` at `lib/clip/repository.ts:138`. That precedent says it works.

- [ ] **Step 4: Run GREEN.**

Run: `pnpm vitest run tests/clip/guild-lock.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing `lockClip`/`configurationId` tests.** Add to `tests/clip/repository.test.ts`:

```ts
test('lockClip refuses a configurationId that is no longer current', async () => {
  const input = newClipInput();
  await upsertGuildArchiveConfig({
    guildId: input.guildId,
    archiveChannelId: fakeSnowflake(),
    configuredByUserId: fakeSnowflake(),
    allowedRoleIds: [],
  });
  await claimClip(input);
  const config = await findGuildArchiveConfig(input.guildId);

  const called = vi.fn(async () => 'ran');
  expect(
    await lockClip(input.guildId, input.sourceMessageId, called, { configurationId: config!.configurationId }),
  ).toBe('ran');
  expect(
    await lockClip(input.guildId, input.sourceMessageId, called, { configurationId: randomUUID() }),
  ).toBeNull();
  expect(called).toHaveBeenCalledTimes(1);
});

test('lockClip with a configurationId refuses when the guild has no config', async () => {
  const input = newClipInput();
  await claimClip(input);
  expect(
    await lockClip(input.guildId, input.sourceMessageId, async () => 'ran', { configurationId: randomUUID() }),
  ).toBeNull();
});

test('a Clip row lock waits behind the guild lock', async () => {
  const input = newClipInput();
  await claimClip(input);
  await warmConnectionPool(2);
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const guildWriter = withGuildLock(input.guildId, async () => {
    holding.resolve();
    await release.promise;
    order.push('guild');
  });
  await holding.promise;
  const clipWriter = lockClip(input.guildId, input.sourceMessageId, async () => {
    order.push('clip');
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(order).toEqual([]);
  release.resolve();
  await Promise.all([guildWriter, clipWriter]);
  expect(order).toEqual(['guild', 'clip']);
});
```

Import `withGuildLock` from `@/lib/guild-lock`. The third test uses a 100 ms observation window instead of `pg_stat_activity`. It is a negative check: the clip writer must not have run. The final ordering assertion is the real proof, and it is robust.

- [ ] **Step 6: Run them and confirm RED.**

Run: `pnpm vitest run tests/clip/repository.test.ts -t "lockClip|guild lock"`
Expected: FAIL. `lockClip` ignores the 4th argument, so it returns `'ran'` where `null` is expected; `config.configurationId` is undefined; and the clip writer runs before the guild writer.

- [ ] **Step 7: Implement it in `lib/clip/repository.ts`.**
  - Add `configurationId: string;` to `GuildArchiveConfig`.
  - Add `configurationId: true,` to `guildArchiveConfigSelect`.
  - Map it in `guildArchiveConfigOf` (the parameter type gains `configurationId: string`).
  - Import `lockGuild` from `@/lib/guild-lock`.
  - Replace `lockClip`:

```ts
export function lockClip<T>(
  guildId: string,
  sourceMessageId: string,
  fn: (tx: TxClient, clip: ClipRecord) => Promise<T>,
  options: { configurationId?: string } = {},
): Promise<T | null> {
  return getPrismaClient().$transaction(async (tx) => {
    // Guild lock first, always: see lib/guild-lock.ts for the lock order.
    await lockGuild(tx, guildId);
    if (options.configurationId !== undefined) {
      // The caller started under a configuration that a deletion (and
      // perhaps a re-setup) has since replaced. Its write belongs to a
      // lifetime that no longer exists, so it is discarded, not applied to
      // whatever Clip now holds the same key.
      const current = await tx.guildConfig.findUnique({
        where: { guildId },
        select: { configurationId: true },
      });
      if (current?.configurationId !== options.configurationId) {
        return null;
      }
    }
    const locked = await tx.$executeRaw`
      SELECT 1 FROM clips
      WHERE guild_id = ${guildId} AND source_message_id = ${sourceMessageId}
      FOR UPDATE
    `;
    if (locked === 0) {
      return null;
    }

    const clip = await tx.clip.findUniqueOrThrow({
      where: clipKey(guildId, sourceMessageId),
      select: clipRecordSelect,
    });
    return fn(tx, clip);
  });
}
```

  - Add one paragraph to `lockClip`'s doc comment: "With `options.configurationId`, resolves to null without calling `fn` unless the guild's current configuration still has that id: the guild lock makes the check and the write atomic with respect to deletion and re-setup." Keep every existing paragraph.
  - In `lockGuildConfig`, insert `await lockGuild(tx, guildId);` as the first statement inside the transaction, with the comment `// Guild lock first, always: see lib/guild-lock.ts.`.

- [ ] **Step 8: Run GREEN.**

Run: `pnpm vitest run tests/clip`
Expected: PASS. The existing race tests in `repository.test.ts` and `service.test.ts` must stay green. In particular, "prevents reconfiguration between a Clip config read and its canonical claim" still blocks, now on the advisory lock first. If its `pg_stat_activity` probe (`query LIKE '%FOR UPDATE%'`, `wait_event_type = 'Lock'`) no longer matches because the waiter now waits on `pg_advisory_xact_lock`, ledger a ruling and widen the probe to `wait_event_type = 'Lock'` with `query LIKE '%pg_advisory_xact_lock%' OR query LIKE '%FOR UPDATE%'`. The test's claim (finalize blocks behind a claim) is unchanged; only the lock it waits on changes.

- [ ] **Step 9: Commit.**

```bash
git add lib/guild-lock.ts lib/clip/repository.ts tests/clip/guild-lock.test.ts tests/clip/repository.test.ts
git commit -m "feat(db): serialize guild control-plane writers on a guild advisory lock"
```

---

### Task 4: Setup credentials and finalization under the lock

**Files:**
- Modify: `lib/admin-session/repository.ts`, `lib/admin-session/service.ts`, `lib/clip/repository.ts` (`finalizeGuildArchiveConfig`), `app/setup/save/route.ts`
- Test: `tests/admin-session/service.test.ts`, `tests/clip/repository.test.ts`, `tests/setup/save-route.test.ts`

**Interfaces:**
- Consumes: `lockGuild`, `withGuildLock` (Task 3).
- Produces:
  - `isAdminSessionLive(tx: TxClient, tokenHash: string, guildId: string, now: Date): Promise<boolean>` (admin-session repository)
  - `sessionTokenHash(sessionToken: string): string` (admin-session service)
  - `finalizeGuildArchiveConfig(input: UpsertGuildArchiveConfigInput & { sessionTokenHash: string; now?: Date }): Promise<{ kind: 'SAVED' } | { kind: 'CONFLICT' } | { kind: 'SESSION_REVOKED' }>`
  - `/setup/save` returns 401 when finalize reports `SESSION_REVOKED`, after deleting an auto-created channel.

- [ ] **Step 1: Write the failing repository tests.** Add to `tests/clip/repository.test.ts`. The helper creates a live session row directly:

```ts
async function liveSession(guildId: string): Promise<string> {
  const tokenHash = fakeSnowflake();
  await prisma.adminSession.create({
    data: { tokenHash, guildId, userId: fakeSnowflake(), expiresAt: new Date(Date.now() + 60_000) },
  });
  return tokenHash;
}

test('finalize refuses when the session was revoked before the save committed', async () => {
  const guildId = trackedGuildId();
  const sessionTokenHash = await liveSession(guildId);
  await prisma.adminSession.delete({ where: { tokenHash: sessionTokenHash } });
  const outcome = await finalizeGuildArchiveConfig({
    guildId,
    archiveChannelId: fakeSnowflake(),
    configuredByUserId: fakeSnowflake(),
    allowedRoleIds: [],
    sessionTokenHash,
  });
  expect(outcome).toEqual({ kind: 'SESSION_REVOKED' });
  expect(await prisma.guildConfig.count({ where: { guildId } })).toBe(0);
});

test('simultaneous first setups both settle, and one configuration exists', async () => {
  const guildId = trackedGuildId();
  const sessionTokenHash = await liveSession(guildId);
  await warmConnectionPool(2);
  const results = await Promise.all(
    [fakeSnowflake(), fakeSnowflake()].map((archiveChannelId) =>
      finalizeGuildArchiveConfig({
        guildId,
        archiveChannelId,
        configuredByUserId: fakeSnowflake(),
        allowedRoleIds: [],
        sessionTokenHash,
      }),
    ),
  );
  expect(results).toEqual([{ kind: 'SAVED' }, { kind: 'SAVED' }]);
  expect(await prisma.guildConfig.count({ where: { guildId } })).toBe(1);
});
```

Add `await prisma.adminSession.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });` and the matching `setupToken` cleanup to this file's `afterEach`. Update every existing `finalizeGuildArchiveConfig(...)` call in `tests/clip/repository.test.ts` and `tests/clip/service.test.ts` to pass `sessionTokenHash: await liveSession(guildId)`, adding the same helper to `service.test.ts`.

- [ ] **Step 2: Run them and confirm RED.**

Run: `pnpm vitest run tests/clip/repository.test.ts -t "finalize refuses|simultaneous first setups"`
Expected: FAIL. The first test returns `SAVED` and writes a config. The second may fail with a unique-violation 500 (the unlocked first-setup fallback). If it passes by luck, the first test still pins this step's RED.

- [ ] **Step 3: Implement `isAdminSessionLive` and the exchange/issuance locks.** In `lib/admin-session/repository.ts`:

```ts
import type { TxClient } from '@/lib/clip/repository';
import { lockGuild, withGuildLock } from '@/lib/guild-lock';

/**
 * True if the session is still live *for this guild*, read on the caller's
 * locked transaction. Admin writers recheck the session here, under the
 * guild lock, because a deletion can revoke it between the request's
 * authentication and its commit.
 */
export async function isAdminSessionLive(
  tx: TxClient,
  tokenHash: string,
  guildId: string,
  now: Date,
): Promise<boolean> {
  const session = await tx.adminSession.findFirst({
    where: { tokenHash, guildId, revokedAt: null, expiresAt: { gt: now } },
    select: { tokenHash: true },
  });
  return session !== null;
}
```

  - Change `insertSetupToken` to `return withGuildLock(credential.guildId, async (tx) => { await tx.setupToken.create({ data: credential }); });`, with the comment: "Under the guild lock, so a token is either issued before a deletion (and deleted by it) or after it (and valid for the new setup), never in between."
  - In `exchangeSetupTokenForSession`, before the transaction, add:

```ts
  // The token hash is all the exchange has, so its guild is read first,
  // unlocked, to know which lock to take. The conditional update below
  // still decides the outcome: a deletion that removed the token in the
  // meantime leaves it matching nothing.
  const pending = await getPrismaClient().setupToken.findUnique({
    where: { tokenHash: setupTokenHash },
    select: { guildId: true },
  });
  if (pending === null) {
    return null;
  }
```

  and make the first statement inside the existing `$transaction(async (tx) => {` callback `await lockGuild(tx, pending.guildId);`. Keep the existing doc comment and add one sentence: "The guild lock orders the exchange against deletion: a token deleted first matches nothing."

- [ ] **Step 4: Implement `sessionTokenHash`.** In `lib/admin-session/service.ts`:

```ts
/** The stored form of a session cookie value, for rechecks under the guild lock. */
export function sessionTokenHash(sessionToken: string): string {
  return hashBearerToken(sessionToken, sessionSecret());
}
```

- [ ] **Step 5: Rewrite `finalizeGuildArchiveConfig` under the lock.** In `lib/clip/repository.ts`:

```ts
/**
 * Persists setup after Discord work. Runs under the guild lock, so it is
 * ordered against Clip claims, deletion, and other saves, including first
 * setup, when there is no config row to lock. The session is rechecked
 * inside: a deletion between this request's authentication and its commit
 * revokes the session, and the save must not recreate the configuration
 * the deletion removed.
 */
export async function finalizeGuildArchiveConfig(
  input: UpsertGuildArchiveConfigInput & { sessionTokenHash: string; now?: Date },
): Promise<{ kind: 'SAVED' } | { kind: 'CONFLICT' } | { kind: 'SESSION_REVOKED' }> {
  const { sessionTokenHash, now = new Date(), ...config } = input;
  return withGuildLock(config.guildId, async (tx) => {
    if (!(await isAdminSessionLive(tx, sessionTokenHash, config.guildId, now))) {
      return { kind: 'SESSION_REVOKED' as const };
    }
    const existing = await tx.guildConfig.findUnique({
      where: { guildId: config.guildId },
      select: { archiveChannelId: true },
    });
    if (
      existing !== null &&
      existing.archiveChannelId !== config.archiveChannelId &&
      (await hasLiveClipsWithClient(tx, config.guildId))
    ) {
      return { kind: 'CONFLICT' as const };
    }
    await upsertGuildArchiveConfigWithClient(tx, config);
    return { kind: 'SAVED' as const };
  });
}
```

Import `withGuildLock` and `isAdminSessionLive`. `lib/admin-session/repository.ts` imports only the type `TxClient` from `lib/clip/repository`, so this does not create a runtime cycle.

- [ ] **Step 6: Run the repository tests GREEN.**

Run: `pnpm vitest run tests/clip tests/admin-session`
Expected: PASS. Every pre-existing exchange and issuance test stays green.

- [ ] **Step 7: Write the failing route test.** In `tests/setup/save-route.test.ts`:
  - Extend the hoisted `vi.mock('@/lib/admin-session/service', …)` to also export `sessionTokenHash: vi.fn(() => 'session-hash')`.
  - Add:

```ts
test('a session revoked during an auto-create save deletes the new channel and returns 401', async () => {
  // Arrange as in this file's existing "create" success test, but:
  finalizeGuildArchiveConfig.mockResolvedValue({ kind: 'SESSION_REVOKED' });
  const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [] }));
  expect(response.status).toBe(401);
  expect(discordRequest).toHaveBeenCalledWith('DELETE', expect.stringMatching(/^\/channels\//));
});

test('finalize receives the session hash', async () => {
  // Arrange as the existing "existing channel" success test.
  await POST(postJson({ destination: 'existing', channelId: '111', allowedRoleIds: [] }));
  expect(finalizeGuildArchiveConfig).toHaveBeenCalledWith(
    expect.objectContaining({ sessionTokenHash: 'session-hash' }),
  );
});
```

Use the existing arrange helpers in that file (read the "create" success test and copy its stubs). Update every existing `toHaveBeenCalledWith` on finalize to include `sessionTokenHash: 'session-hash'`.

- [ ] **Step 8: Run it and confirm RED.**

Run: `pnpm vitest run tests/setup/save-route.test.ts`
Expected: FAIL. The route returns 200 for `SESSION_REVOKED` (its kind falls through), and finalize is called without `sessionTokenHash`.

- [ ] **Step 9: Implement it in the route.** In `app/setup/save/route.ts`:
  - Import `sessionTokenHash`.
  - Pass `sessionTokenHash: sessionTokenHash(sessionToken)` to `finalizeGuildArchiveConfig`.
  - Extract the existing channel-cleanup block into a local `async function deleteCreatedChannel()`, and call it for `CONFLICT` (unchanged behaviour) and for the new branch:

```ts
  if (finalized.kind === 'SESSION_REVOKED') {
    if (destination === 'create') {
      await deleteCreatedChannel();
    }
    return new Response(null, { status: 401 });
  }
```

- [ ] **Step 10: Run GREEN, then commit.**

Run: `pnpm vitest run tests/setup tests/clip tests/admin-session && pnpm lint`
Expected: PASS; lint exit 0.

```bash
git add lib/admin-session lib/clip/repository.ts app/setup/save/route.ts tests
git commit -m "feat(setup): issue, exchange and finalize setup under the guild lock"
```

---

### Task 5: Clip operations capture and recheck `configurationId`

**Files:**
- Modify: `lib/clip/service.ts`
- Test: `tests/clip/service.test.ts`

**Interfaces:**
- Consumes:
  - `GuildArchiveConfig.configurationId`, and `lockClip(…, { configurationId })` (Task 3).
- Produces: no new exports.
  - `clip`, `unclip` and `removeByAuthorOrAdmin` keep their result types.
  - A completion whose configuration was replaced reports `{ kind: 'FAILED', retryable: true }` and deletes its own Discord pair.

- [ ] **Step 1: Write the failing race test.** Add to `tests/clip/service.test.ts`. Reuse that file's `clipInput`/config helpers; read the first `service.clip` test to see how it builds a `ClipInput` and configures the guild, and use the same builders.

```ts
test('a completion that straddles deletion and re-setup is discarded, not applied to the new Clip', async () => {
  const guildId = trackedGuildId();
  const oldChannelId = fakeSnowflake();
  const newChannelId = fakeSnowflake();
  await finalizeGuildArchiveConfig({
    guildId,
    archiveChannelId: oldChannelId,
    configuredByUserId: fakeSnowflake(),
    allowedRoleIds: [],
    sessionTokenHash: await liveSession(guildId),
  });
  const first = clipInputFor(guildId); // admin clipper, same helper the file uses
  const second = { ...first, clipperUserId: fakeSnowflake() };

  gateway.onNextCreate(async () => {
    // Inside the first request's Discord round-trip: the guild's data is
    // deleted, the guild is set up again, and someone clips the same message.
    await prisma.clipper.deleteMany({ where: { guildId } });
    await prisma.clip.deleteMany({ where: { guildId } });
    await prisma.guildAllowedRole.deleteMany({ where: { guildId } });
    await prisma.guildConfig.deleteMany({ where: { guildId } });
    await finalizeGuildArchiveConfig({
      guildId,
      archiveChannelId: newChannelId,
      configuredByUserId: fakeSnowflake(),
      allowedRoleIds: [],
      sessionTokenHash: await liveSession(guildId),
    });
    expect((await service.clip(second)).kind).toBe('CREATED');
  });

  const result = await service.clip(first);

  expect(result).toEqual({ kind: 'FAILED', retryable: true });
  const row = await prisma.clip.findUniqueOrThrow({
    where: { guildId_sourceMessageId: { guildId, sourceMessageId: first.sourceMessageId } },
  });
  expect(row.status).toBe('ACTIVE');
  expect(row.archiveProvenanceMessageId).toBe('provenance-2'); // the new setup's pair
  // The stale pair (posted to the old channel) is taken back down.
  expect(gateway.deleteCalls).toContainEqual({
    archiveChannelId: oldChannelId,
    ids: { provenanceMessageId: 'provenance-1', forwardMessageId: 'forward-1' },
  });
});
```

Check the `forwardMessageId` naming the fake gateway produces (`tests/clip/fake-gateway.ts`, the return of `createArchiveMessage`) and match it exactly.

- [ ] **Step 2: Run it and confirm RED.**

Run: `pnpm vitest run tests/clip/service.test.ts -t "straddles deletion"`
Expected: FAIL. Today the first request's `publishArchive` locks the *new* PENDING-or-ACTIVE row with the same key. Depending on timing it either marks it ACTIVE with `provenance-1` or reports a different result. Record the actual failure output in the ledger.

- [ ] **Step 3: Implement the change.** In `lib/clip/service.ts`:
  - **`recordArchiveFailure`.** Change it to `recordArchiveFailure(key: ClipKey, configurationId: string)` and pass `{ configurationId }` as `lockClip`'s 4th argument.
  - **`publishArchive`.** Change it to `publishArchive(key, archive, configurationId: string | null)` and pass `configurationId === null ? {} : { configurationId }` to `lockClip`.
  - **`clip`.**
    - After the claim, read `const { configurationId } = config;`.
    - Pass `{ configurationId }` to the `joined` `lockClip`, to `recordArchiveFailure(key, configurationId)`, and to `publishArchive(key, archive, configurationId)`.
    - Comment on the first of these: `// Every later write rechecks the configuration this claim ran under: a deletion followed by re-setup inside the Discord round-trip must not let this request write onto the new configuration's Clip.`
  - **`finalizeDeletion`.**
    - Add `configurationId: string | null` to its context.
    - Pass `configurationId === null ? {} : { configurationId }` to its `lockClip`, and pass `configurationId` through to `publishArchive`.
  - **`unclip`.**
    - Pass `config === null ? {} : { configurationId: config.configurationId }` to its `lockClip`.
    - Pass `configurationId: config?.configurationId ?? null` into `finalizeDeletion`.
  - **`removeByAuthorOrAdmin`.** Pass the same options object to both of its `lockClip` calls.

Keep every existing comment. A `null` from a configuration-checked `lockClip` already maps to the right result at each call site:
  - The join reports `FAILED` retryable.
  - Publish reports `{published:false, clip:null}`, so the pair is deleted and `FAILED` retryable is returned.
  - Unclip and removal report `NOT_FOUND`.
  - The finalizer stops.

- [ ] **Step 4: Run GREEN, then commit.**

Run: `pnpm vitest run tests/clip`
Expected: PASS, with every existing service race still green.

```bash
git add lib/clip/service.ts tests/clip/service.test.ts
git commit -m "feat(clip): discard completions whose guild configuration was replaced"
```

---

### Task 6: Admin request and page authentication

**Files:**
- Create: `lib/admin/auth.ts`
- Test: `tests/admin/auth.test.ts`

**Interfaces:**
- Consumes: `authenticateAdminSession` and `sessionTokenHash` (admin-session service), and `ADMIN_SESSION_COOKIE_NAME`.
- Produces:
  - `type AdminAuth = { identity: AdminIdentity; sessionTokenHash: string }`
  - `authenticateAdminRequest(request: NextRequest, guildId: string): Promise<AdminAuth | null>`
  - `authenticateAdminPage(guildId: string): Promise<AdminAuth | null>`, which reads `cookies()`
  - `rejectUnsafeMutation(request: NextRequest): Response | null`, which returns a 403 or 415 response, or null when the request may proceed
  - `PRIVATE_NO_STORE: HeadersInit`

- [ ] **Step 1: Write the failing tests.** Create `tests/admin/auth.test.ts`:

```ts
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { authenticateAdminSession, cookieGet } = vi.hoisted(() => ({
  authenticateAdminSession: vi.fn(),
  cookieGet: vi.fn(),
}));
vi.mock('@/lib/admin-session/service', () => ({
  authenticateAdminSession,
  sessionTokenHash: (token: string) => `hash:${token}`,
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));

const { authenticateAdminRequest, authenticateAdminPage, rejectUnsafeMutation } = await import('@/lib/admin/auth');

function request(headers: Record<string, string> = {}) {
  return new NextRequest('https://clipendpoint.cc/api/admin/guilds/g1/x', { method: 'POST', headers });
}

describe('admin auth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');
    vi.stubEnv('DATABASE_URL', 'postgresql://x');
    vi.stubEnv('DISCORD_APPLICATION_ID', '1');
    vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
    vi.stubEnv('DISCORD_BOT_TOKEN', 't');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
  });

  test('no cookie is unauthenticated', async () => {
    expect(await authenticateAdminRequest(request(), 'g1')).toBeNull();
    expect(authenticateAdminSession).not.toHaveBeenCalled();
  });

  test("a live session for another guild is treated as no session", async () => {
    authenticateAdminSession.mockResolvedValue({ guildId: 'g2', userId: 'u' });
    expect(await authenticateAdminRequest(request({ Cookie: 'clip_admin_session=s' }), 'g1')).toBeNull();
  });

  test('a live session for this guild returns identity and hash', async () => {
    authenticateAdminSession.mockResolvedValue({ guildId: 'g1', userId: 'u' });
    expect(await authenticateAdminRequest(request({ Cookie: 'clip_admin_session=s' }), 'g1')).toEqual({
      identity: { guildId: 'g1', userId: 'u' },
      sessionTokenHash: 'hash:s',
    });
  });

  test('pages read the cookie through next/headers', async () => {
    cookieGet.mockReturnValue({ value: 's' });
    authenticateAdminSession.mockResolvedValue({ guildId: 'g1', userId: 'u' });
    expect((await authenticateAdminPage('g1'))?.identity.guildId).toBe('g1');
    expect(await authenticateAdminPage('g2')).toBeNull();
  });

  test('mutations need a same-origin JSON request', () => {
    expect(rejectUnsafeMutation(request({ Origin: 'https://evil.example', 'Content-Type': 'application/json' }))?.status).toBe(403);
    expect(rejectUnsafeMutation(request({ 'Content-Type': 'text/plain' }))?.status).toBe(415);
    expect(rejectUnsafeMutation(request({ 'Content-Type': 'application/json; charset=utf-8' }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm RED.**

Run: `pnpm vitest run tests/admin/auth.test.ts`
Expected: FAIL. `@/lib/admin/auth` cannot be resolved.

- [ ] **Step 3: Implement `lib/admin/auth.ts`.**

```ts
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { authenticateAdminSession, sessionTokenHash } from '@/lib/admin-session/service';
import type { AdminIdentity } from '@/lib/admin-session/repository';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/admin-session/tokens';
import { parseEnv } from '@/lib/env';

export type AdminAuth = { identity: AdminIdentity; sessionTokenHash: string };

export const PRIVATE_NO_STORE: HeadersInit = { 'Cache-Control': 'private, no-store' };

/**
 * The live session behind `sessionToken`, if it belongs to `guildId`.
 *
 * A session for a different guild is treated exactly like no session, so
 * the guild id in a path or body never confers authority and the response
 * says nothing about whether that guild exists.
 */
async function authenticate(sessionToken: string | undefined, guildId: string): Promise<AdminAuth | null> {
  if (!sessionToken) {
    return null;
  }
  const identity = await authenticateAdminSession(sessionToken);
  if (identity === null || identity.guildId !== guildId) {
    return null;
  }
  return { identity, sessionTokenHash: sessionTokenHash(sessionToken) };
}

export function authenticateAdminRequest(request: NextRequest, guildId: string): Promise<AdminAuth | null> {
  return authenticate(request.cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value, guildId);
}

export async function authenticateAdminPage(guildId: string): Promise<AdminAuth | null> {
  return authenticate((await cookies()).get(ADMIN_SESSION_COOKIE_NAME)?.value, guildId);
}

/**
 * CSRF guard for admin POSTs. The Origin check matches `/setup/save`'s; a
 * request with no Origin passes it. So JSON is also required: a
 * cross-site form or `text/plain` POST cannot set it without a CORS
 * preflight, which this app never grants.
 */
export function rejectUnsafeMutation(request: NextRequest): Response | null {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== parseEnv(process.env).PUBLIC_BASE_URL) {
    return new Response(null, { status: 403 });
  }
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(contentType)) {
    return new Response(null, { status: 415 });
  }
  return null;
}
```

- [ ] **Step 4: Run GREEN, then commit.**

Run: `pnpm vitest run tests/admin/auth.test.ts && pnpm lint`
Expected: PASS (5 tests); lint exit 0.

```bash
git add lib/admin/auth.ts tests/admin/auth.test.ts
git commit -m "feat(admin): add session and CSRF guards for admin routes and pages"
```

---

### Task 7: Guild-data deletion (5.4 API)

**Files:**
- Create: `lib/admin/guild-data.ts`, `app/api/admin/guilds/[guildId]/delete-data/route.ts`
- Test: `tests/admin/guild-data.test.ts` (real DB), `tests/admin/delete-data-route.test.ts`

**Interfaces:**
- Consumes: `withGuildLock` (Task 3), `isAdminSessionLive` (Task 4), and `authenticateAdminRequest`, `rejectUnsafeMutation` (Task 6).
- Produces:
  - `deleteGuildData(guildId: string, sessionTokenHash: string, now?: Date): Promise<{ kind: 'DELETED' } | { kind: 'SESSION_REVOKED' }>`
  - `POST /api/admin/guilds/:guildId/delete-data`, body `{ "acknowledged": true }`:
    - 200 clears the cookie.
    - 400 means a missing acknowledgement.
    - 401 means no session or a revoked one.
    - 403 or 415 means the mutation guard refused it.
    - 500 means the delete threw.

- [ ] **Step 1: Write the failing repository tests.** Create `tests/admin/guild-data.test.ts`. Use the env-stub, `fakeSnowflake` and cleanup pattern from `tests/clip/repository.test.ts:31–70`. The cleanup also deletes `setupToken` and `adminSession` for tracked guilds.

```ts
async function seedGuild(guildId: string) {
  const sessionTokenHash = fakeSnowflake();
  await prisma.guildConfig.create({ data: { guildId, archiveChannelId: fakeSnowflake(), configuredByUserId: fakeSnowflake() } });
  await prisma.guildAllowedRole.create({ data: { guildId, roleId: fakeSnowflake() } });
  const sourceMessageId = fakeSnowflake();
  await prisma.clip.create({
    data: {
      guildId, sourceMessageId, sourceChannelId: fakeSnowflake(), authorUserId: fakeSnowflake(),
      status: 'ACTIVE', archiveProvenanceMessageId: fakeSnowflake(), archiveForwardMessageId: fakeSnowflake(),
    },
  });
  await prisma.clip.create({
    data: {
      guildId, sourceMessageId: fakeSnowflake(), sourceChannelId: fakeSnowflake(), authorUserId: fakeSnowflake(),
      status: 'REMOVED_BY_AUTHOR', removedAt: new Date(),
    },
  });
  await prisma.clipper.create({ data: { guildId, sourceMessageId, clipperUserId: fakeSnowflake() } });
  await prisma.setupToken.create({ data: { tokenHash: fakeSnowflake(), guildId, userId: fakeSnowflake(), expiresAt: new Date(Date.now() + 60_000) } });
  await prisma.adminSession.create({ data: { tokenHash: sessionTokenHash, guildId, userId: fakeSnowflake(), expiresAt: new Date(Date.now() + 60_000) } });
  return { sessionTokenHash };
}

async function countsFor(guildId: string) {
  return {
    configs: await prisma.guildConfig.count({ where: { guildId } }),
    roles: await prisma.guildAllowedRole.count({ where: { guildId } }),
    clips: await prisma.clip.count({ where: { guildId } }),
    clippers: await prisma.clipper.count({ where: { guildId } }),
    tokens: await prisma.setupToken.count({ where: { guildId } }),
    sessions: await prisma.adminSession.count({ where: { guildId } }),
  };
}

const NONE = { configs: 0, roles: 0, clips: 0, clippers: 0, tokens: 0, sessions: 0 };

test('deletes every control-plane row for the guild, tombstones included, and nothing else', async () => {
  const target = trackedGuildId();
  const other = trackedGuildId();
  const { sessionTokenHash } = await seedGuild(target);
  await seedGuild(other);
  const otherBefore = await countsFor(other);

  expect(await deleteGuildData(target, sessionTokenHash)).toEqual({ kind: 'DELETED' });
  expect(await countsFor(target)).toEqual(NONE);
  expect(await countsFor(other)).toEqual(otherBefore);
});

test('a revoked session deletes nothing', async () => {
  const guildId = trackedGuildId();
  await seedGuild(guildId);
  const before = await countsFor(guildId);
  expect(await deleteGuildData(guildId, 'not-a-live-session')).toEqual({ kind: 'SESSION_REVOKED' });
  expect(await countsFor(guildId)).toEqual(before);
});

test('a save authenticated before the deletion cannot recreate the configuration after it', async () => {
  const guildId = trackedGuildId();
  const { sessionTokenHash } = await seedGuild(guildId);
  await deleteGuildData(guildId, sessionTokenHash);
  const late = await finalizeGuildArchiveConfig({
    guildId, archiveChannelId: fakeSnowflake(), configuredByUserId: fakeSnowflake(), allowedRoleIds: [], sessionTokenHash,
  });
  expect(late).toEqual({ kind: 'SESSION_REVOKED' });
  expect(await prisma.guildConfig.count({ where: { guildId } })).toBe(0);
});

test('a setup token issued before the deletion cannot be exchanged after it', async () => {
  const guildId = trackedGuildId();
  const issued = await issueSetupToken(guildId, fakeSnowflake());
  const { sessionTokenHash } = await seedGuild(guildId);
  await deleteGuildData(guildId, sessionTokenHash);
  expect(await exchangeSetupToken(issued.token)).toBeNull();
  expect(await prisma.adminSession.count({ where: { guildId } })).toBe(0);
});

test('deletion waits for an in-flight Clip row transaction', async () => {
  const guildId = trackedGuildId();
  const { sessionTokenHash } = await seedGuild(guildId);
  const clip = await prisma.clip.findFirstOrThrow({ where: { guildId, status: 'ACTIVE' } });
  await warmConnectionPool(2);
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const clipTx = lockClip(guildId, clip.sourceMessageId, async () => {
    holding.resolve();
    await release.promise;
    return 'done';
  });
  await holding.promise;
  const deletion = deleteGuildData(guildId, sessionTokenHash);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await prisma.guildConfig.count({ where: { guildId } })).toBe(1);
  release.resolve();
  expect(await clipTx).toBe('done');
  expect(await deletion).toEqual({ kind: 'DELETED' });
});
```

Imports: `deleteGuildData` from `@/lib/admin/guild-data`; `finalizeGuildArchiveConfig` and `lockClip` from `@/lib/clip/repository`; `issueSetupToken` and `exchangeSetupToken` from `@/lib/admin-session/service`.

- [ ] **Step 2: Run it and confirm RED.**

Run: `pnpm vitest run tests/admin/guild-data.test.ts`
Expected: FAIL. `@/lib/admin/guild-data` cannot be resolved.

- [ ] **Step 3: Implement `lib/admin/guild-data.ts`.**

```ts
import { isAdminSessionLive } from '@/lib/admin-session/repository';
import { withGuildLock } from '@/lib/guild-lock';

/**
 * Deletes everything Clip stores for one guild, in one transaction, under
 * the guild lock: configuration, allowed roles, Clips (tombstones and
 * notification state included), clippers, setup tokens, and admin sessions.
 * A failure rolls all of it back.
 *
 * It makes no Discord calls (spec §16). The archive channel, its
 * messages, and the source messages all survive, and Clip can no longer
 * locate or manage them; the confirmation copy says so.
 *
 * The session is rechecked under the lock, the same as a save: a request
 * authenticated before a concurrent deletion must not act after it.
 * Children are deleted before parents because both foreign keys are
 * RESTRICT.
 */
export async function deleteGuildData(
  guildId: string,
  sessionTokenHash: string,
  now: Date = new Date(),
): Promise<{ kind: 'DELETED' } | { kind: 'SESSION_REVOKED' }> {
  return withGuildLock(guildId, async (tx) => {
    if (!(await isAdminSessionLive(tx, sessionTokenHash, guildId, now))) {
      return { kind: 'SESSION_REVOKED' as const };
    }
    await tx.clipper.deleteMany({ where: { guildId } });
    await tx.clip.deleteMany({ where: { guildId } });
    await tx.guildAllowedRole.deleteMany({ where: { guildId } });
    await tx.guildConfig.deleteMany({ where: { guildId } });
    await tx.setupToken.deleteMany({ where: { guildId } });
    await tx.adminSession.deleteMany({ where: { guildId } });
    return { kind: 'DELETED' as const };
  });
}
```

- [ ] **Step 4: Run GREEN.**

Run: `pnpm vitest run tests/admin/guild-data.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing route test.** Create `tests/admin/delete-data-route.test.ts`:

```ts
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { authenticateAdminRequest, deleteGuildData } = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  deleteGuildData: vi.fn(),
}));
vi.mock('@/lib/admin/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/auth')>()),
  authenticateAdminRequest,
}));
vi.mock('@/lib/admin/guild-data', () => ({ deleteGuildData }));

const { POST } = await import('@/app/api/admin/guilds/[guildId]/delete-data/route');
const context = { params: Promise.resolve({ guildId: 'g1' }) };

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('https://clipendpoint.cc/api/admin/guilds/g1/delete-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'clip_admin_session=s', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST delete-data', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');
    vi.stubGlobal('fetch', fetchSpy);
    authenticateAdminRequest.mockResolvedValue({ identity: { guildId: 'g1', userId: 'u' }, sessionTokenHash: 'h' });
  });

  test('deletes, clears the session cookie, and calls Discord zero times', async () => {
    deleteGuildData.mockResolvedValue({ kind: 'DELETED' });
    const response = await POST(post({ acknowledged: true }), context);
    expect(response.status).toBe(200);
    expect(deleteGuildData).toHaveBeenCalledWith('g1', 'h');
    expect(response.headers.get('Set-Cookie')).toMatch(/clip_admin_session=;.*Max-Age=0.*Path=\//i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('requires the explicit acknowledgement', async () => {
    expect((await POST(post({ acknowledged: false }), context)).status).toBe(400);
    expect((await POST(post({}), context)).status).toBe(400);
    expect(deleteGuildData).not.toHaveBeenCalled();
  });

  test('refuses cross-origin and non-JSON requests before authenticating', async () => {
    expect((await POST(post({ acknowledged: true }, { Origin: 'https://evil.example' }), context)).status).toBe(403);
    expect((await POST(post({ acknowledged: true }, { 'Content-Type': 'text/plain' }), context)).status).toBe(415);
    expect(authenticateAdminRequest).not.toHaveBeenCalled();
  });

  test('401 without a session for this guild, and when revoked under the lock', async () => {
    authenticateAdminRequest.mockResolvedValueOnce(null);
    expect((await POST(post({ acknowledged: true }), context)).status).toBe(401);
    deleteGuildData.mockResolvedValue({ kind: 'SESSION_REVOKED' });
    expect((await POST(post({ acknowledged: true }), context)).status).toBe(401);
  });

  test('a failed delete is a 500 and does not clear the cookie', async () => {
    deleteGuildData.mockRejectedValue(new Error('db down'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await POST(post({ acknowledged: true }), context);
    expect(response.status).toBe(500);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('admin.delete-data-failed'));
  });
});
```

- [ ] **Step 6: Run it and confirm RED.**

Run: `pnpm vitest run tests/admin/delete-data-route.test.ts`
Expected: FAIL. The route module does not exist.

- [ ] **Step 7: Implement the route.**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticateAdminRequest, PRIVATE_NO_STORE, rejectUnsafeMutation } from '@/lib/admin/auth';
import { deleteGuildData } from '@/lib/admin/guild-data';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/admin-session/tokens';
import { logClipEvent } from '@/lib/logging/safe-log';

const DeleteRequestSchema = z.object({ acknowledged: z.literal(true) });

/**
 * Screen E's step 2. The acknowledgement is checked here as well as in the
 * UI: a destructive endpoint does not trust the button that called it.
 * Makes no Discord calls; see `deleteGuildData`.
 */
export async function POST(request: NextRequest, context: RouteContext<'/api/admin/guilds/[guildId]/delete-data'>) {
  const unsafe = rejectUnsafeMutation(request);
  if (unsafe) {
    return unsafe;
  }
  const { guildId } = await context.params;
  const auth = await authenticateAdminRequest(request, guildId);
  if (!auth) {
    return new Response(null, { status: 401, headers: PRIVATE_NO_STORE });
  }
  const parsed = DeleteRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new Response(null, { status: 400, headers: PRIVATE_NO_STORE });
  }

  let outcome;
  try {
    outcome = await deleteGuildData(guildId, auth.sessionTokenHash);
  } catch {
    logClipEvent({ event: 'admin.delete-data-failed', guildId, errorCode: 'UNKNOWN' });
    return new Response(null, { status: 500, headers: PRIVATE_NO_STORE });
  }
  if (outcome.kind === 'SESSION_REVOKED') {
    return new Response(null, { status: 401, headers: PRIVATE_NO_STORE });
  }

  const response = NextResponse.json({ deleted: true }, { headers: PRIVATE_NO_STORE });
  // Same name and path as the exchange route set it with, or the browser keeps it.
  response.cookies.set(ADMIN_SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    secure: process.env.NODE_ENV === 'production',
  });
  return response;
}
```

`logClipEvent` (`lib/logging/safe-log.ts`) takes `event: string` and writes one JSON line through `console.log`. That is why the 500 test stubs `console.log` and asserts on the line.

- [ ] **Step 8: Run GREEN, then commit.**

Run: `pnpm vitest run tests/admin && pnpm lint`
Expected: PASS; lint exit 0.

```bash
git add lib/admin/guild-data.ts app/api/admin tests/admin lib/logging/safe-log.ts
git commit -m "feat(admin): delete a guild's Clip data atomically under the guild lock"
```

---

### Task 8: Paginated archive metadata reader (5.1)

**Files:**
- Create: `lib/archive/reader.ts`
- Test: `tests/archive/reader.test.ts` (real DB)

**Interfaces:**
- Produces:
  - `ARCHIVE_PAGE_SIZE = 20`
  - `type ArchiveItem = { sourceMessageId: string; sourceChannelId: string; authorUserId: string; clippedAt: string /* ISO */ }`
  - `type ClipPage = { items: ArchiveItem[]; total: number; range: { start: number; end: number } | null; newerCursor: string | null; olderCursor: string | null; channelIds: string[] }`
  - `getClipPage(query: { guildId: string; sourceChannelId?: string; before?: string; after?: string }): Promise<{ kind: 'OK'; page: ClipPage } | { kind: 'INVALID' }>`
  - `encodeCursor(item: ArchiveItem): string`

- [ ] **Step 1: Write the failing tests.** Create `tests/archive/reader.test.ts`, using the env-stub, cleanup and `fakeSnowflake` pattern of `tests/clip/repository.test.ts`.

```ts
const T0 = Date.parse('2026-10-01T00:00:00.000Z');

async function seedActive(guildId: string, count: number, options: { channelId?: string; startMs?: number } = {}) {
  const channelId = options.channelId ?? fakeSnowflake();
  const start = options.startMs ?? T0;
  for (let i = 0; i < count; i++) {
    await prisma.clip.create({
      data: {
        guildId,
        sourceMessageId: `m${String(i).padStart(4, '0')}${fakeSnowflake().slice(0, 6)}`,
        sourceChannelId: channelId,
        authorUserId: fakeSnowflake(),
        status: 'ACTIVE',
        archiveProvenanceMessageId: fakeSnowflake(),
        archiveForwardMessageId: fakeSnowflake(),
        createdAt: new Date(start + i * 1000),
      },
    });
  }
  return channelId;
}

async function page(query: Parameters<typeof getClipPage>[0]) {
  const result = await getClipPage(query);
  if (result.kind !== 'OK') throw new Error('expected OK');
  return result.page;
}

test('newest first in pages of 20, with ranges and both directions', async () => {
  const guildId = trackedGuildId();
  await seedActive(guildId, 45);
  const p1 = await page({ guildId });
  expect(p1.total).toBe(45);
  expect(p1.range).toEqual({ start: 1, end: 20 });
  expect(p1.newerCursor).toBeNull();
  expect(p1.items[0].clippedAt > p1.items[1].clippedAt).toBe(true);

  const p2 = await page({ guildId, before: p1.olderCursor! });
  expect(p2.range).toEqual({ start: 21, end: 40 });
  const p3 = await page({ guildId, before: p2.olderCursor! });
  expect(p3.range).toEqual({ start: 41, end: 45 });
  expect(p3.olderCursor).toBeNull();

  const back = await page({ guildId, after: p3.newerCursor! });
  expect(back.items.map((i) => i.sourceMessageId)).toEqual(p2.items.map((i) => i.sourceMessageId));
  expect(back.range).toEqual({ start: 21, end: 40 });
});

test('a tie on clippedAt is broken by sourceMessageId, descending, with no row lost or repeated', async () => {
  const guildId = trackedGuildId();
  const ids = ['a1', 'a2', 'a3'].map((p) => p + fakeSnowflake().slice(0, 8));
  for (const sourceMessageId of ids) {
    await prisma.clip.create({
      data: {
        guildId, sourceMessageId, sourceChannelId: 'c1', authorUserId: 'u', status: 'ACTIVE',
        archiveProvenanceMessageId: 'p', archiveForwardMessageId: 'f', createdAt: new Date(T0),
      },
    });
  }
  await seedActive(guildId, 19, { startMs: T0 + 10_000 });
  const p1 = await page({ guildId });
  const p2 = await page({ guildId, before: p1.olderCursor! });
  const seen = [...p1.items, ...p2.items].map((i) => i.sourceMessageId);
  expect(new Set(seen).size).toBe(22);
  expect(p2.items.map((i) => i.sourceMessageId)).toEqual([...ids].sort().reverse().slice(1));
});

test('a clip inserted between page loads does not shift an older page', async () => {
  const guildId = trackedGuildId();
  await seedActive(guildId, 30);
  const p1 = await page({ guildId });
  await seedActive(guildId, 1, { startMs: T0 + 999_000 });
  const p2 = await page({ guildId, before: p1.olderCursor! });
  expect(p2.items).toHaveLength(10);
  expect(p2.range).toEqual({ start: 22, end: 31 });
});

test('the channel filter narrows items and total; channelIds lists every ACTIVE source channel', async () => {
  const guildId = trackedGuildId();
  const a = await seedActive(guildId, 3);
  const b = await seedActive(guildId, 2);
  const filtered = await page({ guildId, sourceChannelId: b });
  expect(filtered.total).toBe(2);
  expect(filtered.items.every((i) => i.sourceChannelId === b)).toBe(true);
  expect(filtered.channelIds.sort()).toEqual([a, b].sort());
});

test('only ACTIVE clips of this guild are listed and counted', async () => {
  const guildId = trackedGuildId();
  await seedActive(guildId, 2);
  await seedActive(trackedGuildId(), 3);
  await prisma.clip.create({ data: { guildId, sourceMessageId: fakeSnowflake(), sourceChannelId: 'c', authorUserId: 'u', status: 'PENDING' } });
  await prisma.clip.create({
    data: { guildId, sourceMessageId: fakeSnowflake(), sourceChannelId: 'c', authorUserId: 'u', status: 'REMOVED_BY_ADMIN', removedAt: new Date() },
  });
  const p = await page({ guildId });
  expect(p.total).toBe(2);
  expect(p.items).toHaveLength(2);
});

test('an empty archive has no range and no cursors', async () => {
  expect(await page({ guildId: trackedGuildId() })).toEqual({
    items: [], total: 0, range: null, newerCursor: null, olderCursor: null, channelIds: [],
  });
});

test('a cursor whose row was removed still pages from its position', async () => {
  const guildId = trackedGuildId();
  await seedActive(guildId, 25);
  const p1 = await page({ guildId });
  const last = p1.items[19];
  await prisma.clip.delete({ where: { guildId_sourceMessageId: { guildId, sourceMessageId: last.sourceMessageId } } });
  const p2 = await page({ guildId, before: p1.olderCursor! });
  expect(p2.items).toHaveLength(5);
});

test.each([
  [{ before: 'nonsense' }],
  [{ after: '123' }],
  [{ before: `${T0}.abc`, after: `${T0}.abc` }],
  [{ sourceChannelId: "1' OR 1=1" }],
  [{ before: `${T0}.${'x'.repeat(40)}` }],
])('rejects malformed query %o', async (query) => {
  expect(await getClipPage({ guildId: 'g', ...query })).toEqual({ kind: 'INVALID' });
});
```

- [ ] **Step 2: Run it and confirm RED.**

Run: `pnpm vitest run tests/archive/reader.test.ts`
Expected: FAIL. `@/lib/archive/reader` cannot be resolved.

- [ ] **Step 3: Implement `lib/archive/reader.ts`.**

```ts
import { Prisma } from '@/generated/prisma/client';
import { getPrismaClient } from '@/lib/db';

export const ARCHIVE_PAGE_SIZE = 20;

export type ArchiveItem = {
  sourceMessageId: string;
  sourceChannelId: string;
  authorUserId: string;
  /** ISO 8601, UTC. */
  clippedAt: string;
};

export type ClipPage = {
  items: ArchiveItem[];
  total: number;
  range: { start: number; end: number } | null;
  newerCursor: string | null;
  olderCursor: string | null;
  channelIds: string[];
};

export type ClipPageQuery = {
  guildId: string;
  sourceChannelId?: string;
  before?: string;
  after?: string;
};

type Cursor = { clippedAt: string; sourceMessageId: string };

// Snowflakes are decimal, and the test suites use hex: accept both, nothing else.
const ID = /^[0-9A-Za-z]{1,32}$/;
const CURSOR = /^(\d{1,15})\.([0-9A-Za-z]{1,32})$/;

/**
 * A cursor is the boundary row's `(clippedAt ms, sourceMessageId)`, the
 * same pair the ordering uses. It is a value, not a row reference, so a
 * cursor stays valid after its row is removed.
 */
export function encodeCursor(item: Pick<ArchiveItem, 'clippedAt' | 'sourceMessageId'>): string {
  return `${Date.parse(item.clippedAt)}.${item.sourceMessageId}`;
}

function decodeCursor(value: string): Cursor | null {
  const match = CURSOR.exec(value);
  if (!match) {
    return null;
  }
  const ms = Number(match[1]);
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : { clippedAt: date.toISOString(), sourceMessageId: match[2] };
}

type Row = { source_message_id: string; source_channel_id: string; author_user_id: string; created_at_iso: string };

function itemOf(row: Row): ArchiveItem {
  return {
    sourceMessageId: row.source_message_id,
    sourceChannelId: row.source_channel_id,
    authorUserId: row.author_user_id,
    clippedAt: row.created_at_iso,
  };
}

// `created_at` is `timestamp(3)` holding UTC. Comparisons cast the ISO string
// to `timestamp` (which ignores the zone suffix), and reads format it back as
// ISO, so no session time zone ever touches a cursor.
function after(cursor: Cursor) {
  return Prisma.sql`(created_at, source_message_id) > (${cursor.clippedAt}::timestamp, ${cursor.sourceMessageId})`;
}
function before(cursor: Cursor) {
  return Prisma.sql`(created_at, source_message_id) < (${cursor.clippedAt}::timestamp, ${cursor.sourceMessageId})`;
}

/**
 * One page of the guild's ACTIVE Clips, newest first (spec "Listing
 * contract"). Items, total, range and cursors come from one REPEATABLE READ
 * snapshot, so the counts always describe the rows shown. Only ACTIVE rows
 * are browseable; a Clip whose Discord copy vanished is still ACTIVE and
 * still listed.
 */
export async function getClipPage(
  query: ClipPageQuery,
): Promise<{ kind: 'OK'; page: ClipPage } | { kind: 'INVALID' }> {
  if (query.before !== undefined && query.after !== undefined) {
    return { kind: 'INVALID' };
  }
  if (query.sourceChannelId !== undefined && !ID.test(query.sourceChannelId)) {
    return { kind: 'INVALID' };
  }
  const beforeCursor = query.before === undefined ? null : decodeCursor(query.before);
  const afterCursor = query.after === undefined ? null : decodeCursor(query.after);
  if ((query.before !== undefined && !beforeCursor) || (query.after !== undefined && !afterCursor)) {
    return { kind: 'INVALID' };
  }

  const scope = Prisma.sql`guild_id = ${query.guildId} AND status = 'ACTIVE'`;
  const filter =
    query.sourceChannelId === undefined ? Prisma.empty : Prisma.sql`AND source_channel_id = ${query.sourceChannelId}`;
  const columns = Prisma.sql`source_message_id, source_channel_id, author_user_id,
    to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso`;

  const page = await getPrismaClient().$transaction(
    async (tx) => {
      const [{ total }] = await tx.$queryRaw<Array<{ total: number }>>`
        SELECT count(*)::int AS total FROM clips WHERE ${scope} ${filter}`;

      let rows: Row[];
      if (afterCursor) {
        rows = await tx.$queryRaw<Row[]>`
          SELECT ${columns} FROM clips WHERE ${scope} ${filter} AND ${after(afterCursor)}
          ORDER BY created_at ASC, source_message_id ASC LIMIT ${ARCHIVE_PAGE_SIZE}`;
        rows.reverse();
      } else {
        const boundary = beforeCursor ? Prisma.sql`AND ${before(beforeCursor)}` : Prisma.empty;
        rows = await tx.$queryRaw<Row[]>`
          SELECT ${columns} FROM clips WHERE ${scope} ${filter} ${boundary}
          ORDER BY created_at DESC, source_message_id DESC LIMIT ${ARCHIVE_PAGE_SIZE}`;
      }
      const items = rows.map(itemOf);

      const channelRows = await tx.$queryRaw<Array<{ source_channel_id: string }>>`
        SELECT DISTINCT source_channel_id FROM clips WHERE ${scope} ORDER BY source_channel_id`;
      const channelIds = channelRows.map((row) => row.source_channel_id);

      if (items.length === 0) {
        return { items, total, range: null, newerCursor: null, olderCursor: null, channelIds };
      }
      const first = decodeCursor(encodeCursor(items[0]))!;
      const [{ newer }] = await tx.$queryRaw<Array<{ newer: number }>>`
        SELECT count(*)::int AS newer FROM clips WHERE ${scope} ${filter} AND ${after(first)}`;
      const start = newer + 1;
      const end = newer + items.length;
      return {
        items,
        total,
        range: { start, end },
        newerCursor: start > 1 ? encodeCursor(items[0]) : null,
        olderCursor: end < total ? encodeCursor(items[items.length - 1]) : null,
        channelIds,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return { kind: 'OK', page };
}
```

- [ ] **Step 4: Run GREEN.**

Run: `pnpm vitest run tests/archive/reader.test.ts`
Expected: PASS (all tests).
  - If `to_char` drifts by a time zone, the stored values are not UTC in this column. Stop and verify with `SELECT created_at, now() AT TIME ZONE 'UTC'` before changing anything.
  - If `LIMIT ${ARCHIVE_PAGE_SIZE}` is rejected as a parameter, use `LIMIT ${Prisma.raw(String(ARCHIVE_PAGE_SIZE))}`.

- [ ] **Step 5: Confirm the index is used.**

Run:

```bash
docker exec clip-pg psql -U clip -d clip_dev -c "EXPLAIN SELECT 1 FROM clips WHERE guild_id='g' AND status='ACTIVE' ORDER BY created_at DESC, source_message_id DESC LIMIT 20"
```

Expected: the plan names `clips_guild_status_created_idx` (an Index Scan, possibly Backward). On a near-empty table a Seq Scan is acceptable. Record what you saw in the ledger rather than forcing the plan.

- [ ] **Step 6: Commit.**

```bash
git add lib/archive/reader.ts tests/archive/reader.test.ts
git commit -m "feat(archive): add the cursor-paginated ACTIVE clip reader"
```

---

### Task 9: Live Discord content, view model and batch route (5.2)

**Files:**
- Create: `lib/archive/content.ts`, `app/api/admin/guilds/[guildId]/archive/content/route.ts`
- Modify: `lib/discord/guild-lookup.ts` (`getGuildChannelNames`)
- Test: `tests/archive/content.test.ts` (real DB plus a stub REST client), `tests/archive/content-route.test.ts`, `tests/discord/guild-lookup.test.ts`

**Interfaces:**
- Consumes: `DiscordRestClient`, `DiscordApiError` and `DISCORD_ERROR` (rest-client); `findGuildArchiveConfig`; and Task 6's auth helpers.
- Produces:

```ts
export type BodySegment = { kind: 'text'; text: string } | { kind: 'code'; text: string };
export type SafeAttachment = { filename: string; url: string; isImage: boolean };
export type SafeEmbed = { title: string | null; description: string | null; url: string | null };
export type OriginalStatus = 'available' | 'unavailable' | 'unknown';
type RowBase = { sourceMessageId: string; authorName: string | null; originalAt: string | null; original: OriginalStatus };
export type ArchiveRowContent =
  | (RowBase & { state: 'ready'; body: BodySegment[]; attachments: SafeAttachment[]; embeds: SafeEmbed[]; replyToAuthorName: string | null })
  | (RowBase & { state: 'missing' })
  | (RowBase & { state: 'error'; reason: 'access' | 'transient' });
export const MAX_CONTENT_BATCH = 20;
export const CONTENT_FETCH_CONCURRENCY = 4;
export function loadArchiveContent(input: {
  guildId: string;
  sourceMessageIds: readonly string[];
  client: DiscordRestClient;
  lookupUserName: (userId: string) => Promise<string | null>;
}): Promise<{ kind: 'OK'; items: ArchiveRowContent[] } | { kind: 'INVALID' }>;
export function snowflakeTime(id: string): string | null; // ISO
```

In `guild-lookup.ts`: `getGuildChannelNames(guildId: string): Promise<Record<string, string>>` returns every channel type (display only) and `{}` on any failure.

**Route:** `POST /api/admin/guilds/:guildId/archive/content`, body `{ "sourceMessageIds": string[] }` (1–20). It returns 200 `{ items }`, or 400, 401, 403 or 415.

**Discord reads per row.** These run sequentially inside one concurrency slot, with at most 4 slots at a time:
1. `GET /channels/{archiveChannelId}/messages/{archiveForwardMessageId}` reads the snapshot for content.
2. `GET /channels/{sourceChannelId}/messages/{sourceMessageId}` reads the reply author and whether the original is still available. Only `message_reference.message_id` presence and `referenced_message.author.username` are read; the parent body is never touched or returned (decision D4).

**Forward result classification:**

| Forward GET result | Row state |
|---|---|
| A valid `message_snapshots[0].message` | `ready` |
| `DiscordApiError` with code 10008 or 10003 | `missing` |
| Code 50001 or 50013, or status 403 | `error` with `access` |
| Anything else: a timeout `DOMException`/`TypeError`, a 429 that exhausted its retries, 5xx, a 404 without a code, or a payload with no or malformed snapshot | `error` with `transient` |

**Original availability (source GET):**

| Source GET result | `original` |
|---|---|
| Succeeded | `available` |
| Code 10008 or 10003 | `unavailable` |
| Anything else | `unknown` |

**`originalAt`:** the snapshot `timestamp` when the row is ready; otherwise `snowflakeTime(sourceMessageId)`.

- [ ] **Step 1: Write the failing pure-function tests.** In `tests/archive/content.test.ts`, start with a `describe('pure helpers')`:

```ts
import { DiscordApiError } from '@/lib/discord/rest-client';

test('snowflakeTime derives the creation instant', () => {
  // Discord's documented example: 175928847299117063 → 2016-04-30T11:18:25.796Z
  expect(snowflakeTime('175928847299117063')).toBe('2016-04-30T11:18:25.796Z');
  expect(snowflakeTime('not-a-snowflake')).toBeNull();
});
```

Then a `describe('loadArchiveContent')` against real Postgres, using the env-stub and cleanup pattern. Seed one config row and ACTIVE clips with `prisma.clip.create`. The stub client:

```ts
type Handler = (path: string) => unknown;
function stubClient(handler: Handler) {
  let inFlight = 0;
  let maxInFlight = 0;
  const request = vi.fn(async (_method: string, path: string) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    const result = handler(path);
    if (result instanceof Error) throw result;
    return result;
  });
  return { client: { request }, request, maxInFlight: () => maxInFlight };
}
const unknownMessage = () => new DiscordApiError('x', { status: 404, code: 10008 });
const missingAccess = () => new DiscordApiError('x', { status: 403, code: 50001 });

function snapshot(message: Record<string, unknown>) {
  return { id: 'fwd', message_snapshots: [{ message: { timestamp: '2026-10-01T09:00:00.000Z', ...message } }] };
}
```

Write these tests. Each seeds its own guild and rows, and builds the handler by matching `path` against the forward and source paths:

1. **A ready row.**
   - Content: `'hello\n```ts\nconst a = 1;\n```\nbye'` gives segments `[text 'hello\n', code 'const a = 1;\n', text '\nbye']`.
   - Attachments: an `image/png` at `https://cdn.discordapp.com/a.png` (`isImage: true`) and a `text/plain` at `https://cdn.discordapp.com/b.txt` (`isImage: false`).
   - Embed: `{title:'T', description:'D', url:'https://example.com'}`.
   - `originalAt` is the snapshot timestamp.
   - The source GET returns `{ message_reference: { message_id: 'p1' }, referenced_message: { author: { username: 'parent' }, content: 'PARENT-SECRET-BODY' } }`, so `replyToAuthorName` is `'parent'` and `original` is `'available'`.
   - Assert `JSON.stringify(result)` does **not** contain `'PARENT-SECRET-BODY'`.
2. **Missing.** The forward returns 10008, so the state is `missing` and `originalAt === snowflakeTime(sourceMessageId)`. The source returns 10008, so `original` is `'unavailable'`.
3. **Access.** The forward returns 50001, so the state is `error` with reason `access`.
4. **Transient, timeout.** The forward throws `new DOMException('timed out', 'TimeoutError')`, so the reason is `transient`.
5. **Transient, bad payload (Review Focus 2).** The forward returns `{ id: 'fwd' }` with no snapshots, so the reason is `transient`, never `missing`. The same holds for `message_snapshots: [{}]`.
6. **Unsafe URLs (Review Focus 3).**
   - The attachment `url` is `'javascript:alert(1)'` and an embed has `url: 'http://insecure.example'`. The attachment is dropped, the embed's `url` becomes `null`, and the row is still `ready`.
   - A content string containing `<script>` comes back as plain text inside a segment. This test only asserts that it is text: escaping is React's job, and Task 10 pins it.
7. **Author names.**
   - Three rows by one author call `lookupUserName` exactly once.
   - Another author's lookup returning `null` gives `authorName: null`.
8. **Concurrency.** 20 rows give `maxInFlight() <= 4` and `request` is called 40 times.
9. **Refusal before any fetch.** An id that is another guild's ACTIVE clip, a PENDING clip of this guild, or a removed clip each give `{ kind: 'INVALID' }` with `request` never called. So do 21 ids, 0 ids, and duplicate ids.
10. **Unconfigured guild.** Everything else valid, but no config row, gives `INVALID`.

- [ ] **Step 2: Run them and confirm RED.**

Run: `pnpm vitest run tests/archive/content.test.ts`
Expected: FAIL. `@/lib/archive/content` cannot be resolved.

- [ ] **Step 3: Implement `lib/archive/content.ts`.**

```ts
import { getPrismaClient } from '@/lib/db';
import { findGuildArchiveConfig } from '@/lib/clip/repository';
import { DiscordApiError, DISCORD_ERROR, type DiscordRestClient } from '@/lib/discord/rest-client';

export type BodySegment = { kind: 'text'; text: string } | { kind: 'code'; text: string };
export type SafeAttachment = { filename: string; url: string; isImage: boolean };
export type SafeEmbed = { title: string | null; description: string | null; url: string | null };
export type OriginalStatus = 'available' | 'unavailable' | 'unknown';
type RowBase = { sourceMessageId: string; authorName: string | null; originalAt: string | null; original: OriginalStatus };
export type ArchiveRowContent =
  | (RowBase & { state: 'ready'; body: BodySegment[]; attachments: SafeAttachment[]; embeds: SafeEmbed[]; replyToAuthorName: string | null })
  | (RowBase & { state: 'missing' })
  | (RowBase & { state: 'error'; reason: 'access' | 'transient' });

export const MAX_CONTENT_BATCH = 20;
export const CONTENT_FETCH_CONCURRENCY = 4;
const DISCORD_EPOCH_MS = 1420070400000n;
const SNOWFLAKE = /^\d{1,20}$/;

export function snowflakeTime(id: string): string | null {
  if (!SNOWFLAKE.test(id)) {
    return null;
  }
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS)).toISOString();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Only `https:` URLs ever reach an `href` or `src`. */
function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** Splits Discord's ``` fences into text and code; an unclosed fence stays text. */
function splitCodeBlocks(content: string): BodySegment[] {
  const segments: BodySegment[] = [];
  const fence = /```(?:[^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  for (let match = fence.exec(content); match; match = fence.exec(content)) {
    if (match.index > cursor) {
      segments.push({ kind: 'text', text: content.slice(cursor, match.index) });
    }
    segments.push({ kind: 'code', text: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) {
    segments.push({ kind: 'text', text: content.slice(cursor) });
  }
  return segments;
}

type Snapshot = { body: BodySegment[]; attachments: SafeAttachment[]; embeds: SafeEmbed[]; timestamp: string | null };

/** The forward's snapshot, or null when the payload is not one (an invalid payload, not a missing copy). */
function parseSnapshot(body: unknown): Snapshot | null {
  const snapshots = record(body)?.message_snapshots;
  const message = Array.isArray(snapshots) ? record(record(snapshots[0])?.message) : null;
  if (!message) {
    return null;
  }
  const content = typeof message.content === 'string' ? message.content : '';
  const attachments: SafeAttachment[] = [];
  for (const item of Array.isArray(message.attachments) ? message.attachments : []) {
    const attachment = record(item);
    const url = safeHttpsUrl(attachment?.url);
    const filename = text(attachment?.filename);
    if (url && filename) {
      attachments.push({ filename, url, isImage: /^image\//.test(String(attachment?.content_type ?? '')) });
    }
  }
  const embeds: SafeEmbed[] = [];
  for (const item of Array.isArray(message.embeds) ? message.embeds : []) {
    const embed = record(item);
    const title = text(embed?.title);
    const description = text(embed?.description);
    if (title || description) {
      embeds.push({ title, description, url: safeHttpsUrl(embed?.url) });
    }
  }
  return { body: content ? splitCodeBlocks(content) : [], attachments, embeds, timestamp: text(message.timestamp) };
}

function discordCode(error: unknown): number | null {
  return error instanceof DiscordApiError ? error.code : null;
}

function isUnknownTarget(error: unknown): boolean {
  const code = discordCode(error);
  return code === DISCORD_ERROR.UNKNOWN_MESSAGE || code === DISCORD_ERROR.UNKNOWN_CHANNEL;
}

function isAccessDenied(error: unknown): boolean {
  if (!(error instanceof DiscordApiError)) {
    return false;
  }
  return error.code === DISCORD_ERROR.MISSING_ACCESS || error.code === DISCORD_ERROR.MISSING_PERMISSIONS || error.status === 403;
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Live content for the displayed page's rows (spec "Content contract").
 * Every id is resolved against this guild's ACTIVE rows before any Discord
 * call. The Discord channel and message ids come from Postgres, never from
 * the caller, so this cannot be used as a general bot-authenticated proxy.
 * Nothing read here is stored or logged.
 */
export async function loadArchiveContent(input: {
  guildId: string;
  sourceMessageIds: readonly string[];
  client: DiscordRestClient;
  lookupUserName: (userId: string) => Promise<string | null>;
}): Promise<{ kind: 'OK'; items: ArchiveRowContent[] } | { kind: 'INVALID' }> {
  const ids = input.sourceMessageIds;
  if (ids.length === 0 || ids.length > MAX_CONTENT_BATCH || new Set(ids).size !== ids.length) {
    return { kind: 'INVALID' };
  }
  const [config, rows] = await Promise.all([
    findGuildArchiveConfig(input.guildId),
    getPrismaClient().clip.findMany({
      where: { guildId: input.guildId, status: 'ACTIVE', sourceMessageId: { in: [...ids] } },
      select: { sourceMessageId: true, sourceChannelId: true, authorUserId: true, archiveForwardMessageId: true },
    }),
  ]);
  if (config === null || rows.length !== ids.length) {
    return { kind: 'INVALID' };
  }
  const byId = new Map(rows.map((row) => [row.sourceMessageId, row]));

  // Deduplicated only within this request; there is no cache (spec).
  const names = new Map<string, Promise<string | null>>();
  function authorName(userId: string) {
    let name = names.get(userId);
    if (!name) {
      name = input.lookupUserName(userId).catch(() => null);
      names.set(userId, name);
    }
    return name;
  }

  const items = await mapWithConcurrency(ids, CONTENT_FETCH_CONCURRENCY, async (sourceMessageId) => {
    const row = byId.get(sourceMessageId)!;
    let forward: unknown;
    let forwardError: unknown = null;
    try {
      forward = await input.client.request(
        'GET',
        `/channels/${config.archiveChannelId}/messages/${row.archiveForwardMessageId}`,
      );
    } catch (error) {
      forwardError = error;
    }

    let original: OriginalStatus = 'unknown';
    let replyToAuthorName: string | null = null;
    try {
      const source = record(await input.client.request('GET', `/channels/${row.sourceChannelId}/messages/${sourceMessageId}`));
      original = 'available';
      if (record(source?.message_reference)?.message_id) {
        replyToAuthorName = text(record(record(source?.referenced_message)?.author)?.username);
      }
    } catch (error) {
      original = isUnknownTarget(error) ? 'unavailable' : 'unknown';
    }

    const base = {
      sourceMessageId,
      authorName: await authorName(row.authorUserId),
      originalAt: snowflakeTime(sourceMessageId),
      original,
    };
    if (forwardError !== null) {
      if (isUnknownTarget(forwardError)) {
        return { ...base, state: 'missing' as const };
      }
      return { ...base, state: 'error' as const, reason: isAccessDenied(forwardError) ? ('access' as const) : ('transient' as const) };
    }
    const snapshot = parseSnapshot(forward);
    if (!snapshot) {
      return { ...base, state: 'error' as const, reason: 'transient' as const };
    }
    return {
      ...base,
      originalAt: snapshot.timestamp ?? base.originalAt,
      state: 'ready' as const,
      body: snapshot.body,
      attachments: snapshot.attachments,
      embeds: snapshot.embeds,
      replyToAuthorName,
    };
  });
  return { kind: 'OK', items };
}
```

`archiveForwardMessageId` is non-null on every ACTIVE row; the `clips_active_requires_archive` CHECK guarantees it.

- [ ] **Step 4: Run GREEN.**

Run: `pnpm vitest run tests/archive/content.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `getGuildChannelNames`, test-first.**
  - In `tests/discord/guild-lookup.test.ts`, add one test: for a channel list containing types 0, 2 and 5, it returns all three as an `id → name` record. Add a second: a thrown request gives `{}`.
  - Run it and confirm RED: the method does not exist.
  - Implement it in the returned object:

```ts
    async getGuildChannelNames(guildId: string): Promise<Record<string, string>> {
      const body = await fetchOrNull(`/guilds/${guildId}/channels`);
      const names: Record<string, string> = {};
      for (const item of Array.isArray(body) ? body : []) {
        const channel = item as { id?: unknown; name?: unknown };
        if (typeof channel?.id === 'string' && typeof channel.name === 'string') {
          names[channel.id] = channel.name;
        }
      }
      return names;
    },
```

  - Add the signature to the `DiscordGuildLookup` type, with the doc comment `/** Display only: every channel type, {} on any failure. Threads are absent; callers fall back to the id. */`.
  - Run GREEN.

- [ ] **Step 6: Write the failing route test.** Create `tests/archive/content-route.test.ts`. Mock `@/lib/admin/auth`'s `authenticateAdminRequest` (keeping the real `rejectUnsafeMutation` via `importOriginal`), and mock `@/lib/archive/content`'s `loadArchiveContent`. Tests:
  - 401 without a session for this guild.
  - 400 for a body that isn't `{ sourceMessageIds: string[] }`, and for `loadArchiveContent` returning `INVALID`.
  - 415 for a `text/plain` POST.
  - 200 with `{ items }` and the header `Cache-Control: private, no-store`.
  - `loadArchiveContent` is called with `guildId` taken from the route, not from the body.

- [ ] **Step 7: Run it and confirm RED.** Expected: the module is not found.

- [ ] **Step 8: Implement the route.**

```ts
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticateAdminRequest, PRIVATE_NO_STORE, rejectUnsafeMutation } from '@/lib/admin/auth';
import { loadArchiveContent, MAX_CONTENT_BATCH } from '@/lib/archive/content';
import { createDiscordGuildLookup } from '@/lib/discord/guild-lookup';
import { createDiscordRestClient } from '@/lib/discord/rest-client';
import { parseEnv } from '@/lib/env';

const ContentRequestSchema = z.object({
  sourceMessageIds: z.array(z.string().min(1).max(32)).min(1).max(MAX_CONTENT_BATCH),
});

/** Screen D's per-page content read. A POST only to carry the id list; it changes nothing. */
export async function POST(request: NextRequest, context: RouteContext<'/api/admin/guilds/[guildId]/archive/content'>) {
  const unsafe = rejectUnsafeMutation(request);
  if (unsafe) {
    return unsafe;
  }
  const { guildId } = await context.params;
  if (!(await authenticateAdminRequest(request, guildId))) {
    return new Response(null, { status: 401, headers: PRIVATE_NO_STORE });
  }
  const parsed = ContentRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new Response(null, { status: 400, headers: PRIVATE_NO_STORE });
  }
  const env = parseEnv(process.env);
  const options = { botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch };
  const lookup = createDiscordGuildLookup(options);
  const result = await loadArchiveContent({
    guildId,
    sourceMessageIds: parsed.data.sourceMessageIds,
    client: createDiscordRestClient(options),
    lookupUserName: (userId) => lookup.getUserHandle(userId),
  });
  if (result.kind === 'INVALID') {
    return new Response(null, { status: 400, headers: PRIVATE_NO_STORE });
  }
  return Response.json({ items: result.items }, { headers: PRIVATE_NO_STORE });
}
```

- [ ] **Step 9: Run GREEN, then commit.**

Run: `pnpm vitest run tests/archive tests/discord/guild-lookup.test.ts && pnpm lint`
Expected: PASS; lint exit 0.

```bash
git add lib/archive/content.ts lib/discord/guild-lookup.ts app/api/admin/guilds tests/archive tests/discord/guild-lookup.test.ts
git commit -m "feat(archive): read live archive content with bounded, guild-scoped Discord fetches"
```

---

### Task 10: Clip card (F.5)

**Files:**
- Create: `components/archive/ClipCard.tsx`, `components/archive/ClipCard.module.css`, `lib/ui/format.ts`
- Test: `tests/ui/clip-card.test.tsx`, `tests/ui/format.test.ts`

**Interfaces:**
- Consumes: `ArchiveRowContent` (Task 9) and the Task 1 copy and tokens.
- Produces:
  - `formatTimestamp(iso: string): string` gives `'2026-10-09 21:04'` in `Asia/Seoul`.
  - `formatDate(iso: string): string` gives `'2026-10-09'` in `Asia/Seoul`.
  - The card component:

```ts
export type ClipCardContent = ArchiveRowContent | { state: 'loading' };
export interface ClipCardProps {
  authorUserId: string;
  /** Channel name without `#`, or the id when the name is unknown. */
  sourceChannelLabel: string;
  clippedAt: string; // ISO
  /** https://discord.com/channels/{guild}/{channel}/{message} */
  originalUrl: string;
  content: ClipCardContent;
  onRetry?: () => void;
}
export function ClipCard(props: ClipCardProps): JSX.Element;
```

**Ruling D8:** timestamps render in `Asia/Seoul`. The product, its copy and its admins are Korean, and the handoff shows times without a zone. The cost if this is wrong is a one-line change of time zone.

- [ ] **Step 1: Write the failing format test.** Create `tests/ui/format.test.ts`:

```ts
import { expect, test } from 'vitest';
import { formatDate, formatTimestamp } from '@/lib/ui/format';

test('formats in Asia/Seoul', () => {
  expect(formatTimestamp('2026-10-09T12:04:00.000Z')).toBe('2026-10-09 21:04');
  expect(formatDate('2026-10-09T16:30:00.000Z')).toBe('2026-10-10');
});
```

- [ ] **Step 2: Write the failing card test.** Create `tests/ui/clip-card.test.tsx`, starting with `// @vitest-environment jsdom`. Copy the env annotation and imports from `tests/ui/role-multi-select.test.tsx`.

```tsx
const base = {
  authorUserId: '111',
  sourceChannelLabel: 'general',
  clippedAt: '2026-10-09T12:04:00.000Z',
  originalUrl: 'https://discord.com/channels/1/2/3',
};
const meta = { sourceMessageId: '3', authorName: 'ori', originalAt: '2026-10-01T00:00:00.000Z', original: 'available' as const };

test('loading shows the literal loading line', () => {
  render(<ClipCard {...base} content={{ state: 'loading' }} />);
  expect(screen.getByText('Discord에서 내용을 불러오는 중…')).toBeInTheDocument();
});

test('ready renders the hierarchy, code, attachments, the reply line, and the original link', () => {
  render(
    <ClipCard
      {...base}
      content={{
        ...meta,
        state: 'ready',
        body: [{ kind: 'text', text: '<script>alert(1)</script> hi' }, { kind: 'code', text: 'const a = 1;' }],
        attachments: [
          { filename: 'a.png', url: 'https://cdn.discordapp.com/a.png', isImage: true },
          { filename: 'b.txt', url: 'https://cdn.discordapp.com/b.txt', isImage: false },
        ],
        embeds: [{ title: 'T', description: 'D', url: 'https://example.com' }],
        replyToAuthorName: 'parent',
      }}
    />,
  );
  expect(screen.getByText('ori')).toBeInTheDocument();
  expect(screen.getByText('#general')).toBeInTheDocument();
  expect(screen.getByText('<script>alert(1)</script> hi')).toBeInTheDocument(); // text, not markup
  expect(document.querySelector('script')).toBeNull();
  expect(screen.getByText('const a = 1;').tagName).toBe('CODE');
  expect(screen.getByText('답장 → @parent')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'a.png' })).toHaveAttribute('src', 'https://cdn.discordapp.com/a.png');
  expect(screen.getByRole('link', { name: 'b.txt' })).toHaveAttribute('href', 'https://cdn.discordapp.com/b.txt');
  expect(screen.getByRole('link', { name: '원본 보기' })).toHaveAttribute('href', base.originalUrl);
  expect(screen.getByText('클립 2026-10-09')).toBeInTheDocument();
});

test('missing keeps the metadata under the 누락 tag and approved copy', () => {
  render(<ClipCard {...base} content={{ ...meta, state: 'missing' }} />);
  expect(screen.getByText('누락')).toBeInTheDocument();
  expect(screen.getByText('보관된 사본을 Discord에서 찾을 수 없습니다')).toBeInTheDocument();
  expect(screen.getByText('ori')).toBeInTheDocument();
});

test('an unavailable original replaces the link with the approved text', () => {
  render(<ClipCard {...base} content={{ ...meta, original: 'unavailable', state: 'missing' }} />);
  expect(screen.queryByRole('link', { name: '원본 보기' })).toBeNull();
  expect(screen.getByText('원본 메시지를 찾을 수 없습니다.')).toBeInTheDocument();
});

test('error rows separate access from transient, keep metadata, and offer retry', async () => {
  const onRetry = vi.fn();
  const { rerender } = render(<ClipCard {...base} content={{ ...meta, state: 'error', reason: 'access' }} onRetry={onRetry} />);
  expect(screen.getByText('아카이브 채널에 접근할 수 없습니다. Discord에서 Clip의 채널 권한을 확인해 주세요.')).toBeInTheDocument();
  rerender(<ClipCard {...base} content={{ ...meta, state: 'error', reason: 'transient' }} onRetry={onRetry} />);
  expect(screen.getByText('보관된 내용을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  expect(onRetry).toHaveBeenCalledOnce();
  expect(screen.getByText('ori')).toBeInTheDocument();
});

test('an unknown author shows the user id', () => {
  render(<ClipCard {...base} content={{ ...meta, authorName: null, state: 'missing' }} />);
  expect(screen.getByText('111')).toBeInTheDocument();
});
```

- [ ] **Step 3: Run them and confirm RED.**

Run: `pnpm vitest run tests/ui/format.test.ts tests/ui/clip-card.test.tsx`
Expected: FAIL, because neither module exists.

- [ ] **Step 4: Implement `lib/ui/format.ts`.**

```ts
// 'sv-SE' formats as YYYY-MM-DD HH:mm; the zone is fixed (ruling D8).
const timestamp = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

export function formatTimestamp(iso: string): string {
  return timestamp.format(new Date(iso));
}

export function formatDate(iso: string): string {
  return date.format(new Date(iso));
}
```

- [ ] **Step 5: Implement `components/archive/ClipCard.tsx`.**

```tsx
import type { ArchiveRowContent } from '@/lib/archive/content';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { TextTag } from '@/components/ui/TextTag';
import { formatDate, formatTimestamp } from '@/lib/ui/format';
import { WEB_COPY, WEB_COPY_AUTHORED, WEB_COPY_TEMPLATES } from '@/lib/ui/copy';
import styles from './ClipCard.module.css';

export type ClipCardContent = ArchiveRowContent | { state: 'loading' };

export interface ClipCardProps {
  authorUserId: string;
  sourceChannelLabel: string;
  clippedAt: string;
  originalUrl: string;
  content: ClipCardContent;
  onRetry?: () => void;
}

/**
 * One archive row (F.5; handoff "Clip card"). The hierarchy is fixed: source
 * line, reply, body, code, attachment, footer. Text is rendered as React text,
 * never as markup, and URLs come from `lib/archive/content.ts`, which allows
 * only `https:`. No reaction, vote or rank counts anywhere.
 */
export function ClipCard({ authorUserId, sourceChannelLabel, clippedAt, originalUrl, content, onRetry }: ClipCardProps) {
  if (content.state === 'loading') {
    return (
      <article className={styles.card} aria-busy="true">
        <div className={styles.skeleton} aria-hidden="true">
          <span className={styles.barStrong} />
          <span className={styles.barWeak} />
        </div>
        <p className={styles.loading}>{WEB_COPY.archive.loadingFromDiscord}</p>
      </article>
    );
  }

  const authorName = content.authorName;
  const sourceLine = (
    <div className={styles.source}>
      <span className={styles.avatar} aria-hidden="true">
        {authorName ? Array.from(authorName)[0]!.toUpperCase() : ''}
      </span>
      {authorName ? <span className={styles.author}>{authorName}</span> : <span className={`${styles.author} ${styles.mono}`}>{authorUserId}</span>}
      <span className={styles.channel}>{`#${sourceChannelLabel}`}</span>
      {content.originalAt && <span className={styles.time}>{formatTimestamp(content.originalAt)}</span>}
    </div>
  );
  const footer = (
    <div className={styles.footer}>
      <span className={styles.clipped}>{WEB_COPY_TEMPLATES.clippedOn.replace('{date}', formatDate(clippedAt))}</span>
      {content.original === 'unavailable' ? (
        <span className={styles.unavailable}>{WEB_COPY_AUTHORED.originalUnavailable}</span>
      ) : (
        <a className={styles.action} href={originalUrl} target="_blank" rel="noopener noreferrer">
          {WEB_COPY.clipCard.viewOriginal}
        </a>
      )}
    </div>
  );

  if (content.state === 'missing') {
    return (
      <article className={`${styles.card} ${styles.missing}`}>
        <div className={styles.missingHeading}>
          <TextTag>{WEB_COPY.tags.missing}</TextTag>
          <span className={styles.missingTitle}>{WEB_COPY.archive.missingCopyTitle}</span>
        </div>
        <p className={styles.body}>{WEB_COPY.archive.missingCopyExplanation}</p>
        {sourceLine}
        {footer}
      </article>
    );
  }

  if (content.state === 'error') {
    return (
      <article className={styles.card}>
        {sourceLine}
        <Callout variant="error">
          {content.reason === 'access' ? WEB_COPY_AUTHORED.archiveAccessDenied : WEB_COPY_AUTHORED.archiveFetchFailed}
        </Callout>
        <div>
          <Button variant="secondary" onClick={onRetry}>
            {WEB_COPY_AUTHORED.retry}
          </Button>
        </div>
        {footer}
      </article>
    );
  }

  return (
    <article className={styles.card}>
      {sourceLine}
      {content.replyToAuthorName && (
        <p className={styles.reply}>{`${WEB_COPY.clipCard.replyPrefix}@${content.replyToAuthorName}`}</p>
      )}
      {content.body.map((segment, index) =>
        segment.kind === 'code' ? (
          <pre key={index} className={styles.code}>
            <code>{segment.text}</code>
          </pre>
        ) : (
          <p key={index} className={styles.body}>
            {segment.text}
          </p>
        ),
      )}
      {content.embeds.map((embed, index) => (
        <div key={`embed-${index}`} className={styles.embed}>
          {embed.title &&
            (embed.url ? (
              <a href={embed.url} target="_blank" rel="noopener noreferrer">
                {embed.title}
              </a>
            ) : (
              <span>{embed.title}</span>
            ))}
          {embed.description && <p className={styles.body}>{embed.description}</p>}
        </div>
      ))}
      {content.attachments.map((attachment) =>
        attachment.isImage ? (
          <div key={attachment.url} className={styles.attachment}>
            {/* Plain <img>: the fresh Discord URL, no optimizer or cache (ruling D6). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={attachment.url} alt={attachment.filename} loading="lazy" referrerPolicy="no-referrer" />
          </div>
        ) : (
          <a key={attachment.url} className={styles.file} href={attachment.url} target="_blank" rel="noopener noreferrer">
            {attachment.filename}
          </a>
        ),
      )}
      {footer}
    </article>
  );
}
```

- [ ] **Step 6: Write `ClipCard.module.css`.** Every value is a token. Put the source line in a comment at the top: `docs/06_DESIGN_HANDOFF.md "Clip card", Screen D loading/missing rows`.

| Class | Rules |
|---|---|
| `.card` | `display:flex; flex-direction:column; gap:var(--sp-inline-gap)` (10px); `padding: var(--sp-4) var(--card-pad-x)`; `border-bottom: var(--hairline) solid var(--divider)`. Under `@media (max-width: 640px)`: `padding: var(--card-pad-x-narrow)`. |
| `.source` | Flex row, wraps, `align-items:center`, `gap: var(--sp-2)`. |
| `.avatar` | `width/height: var(--avatar-size)`, `border-radius: var(--radius)`, `background: var(--avatar-surface)`, `font: 600 var(--fs-meta) var(--font-ui)`, `color: var(--text-2)`, grid centered. |
| `.author` | `font: 600 13px var(--font-ui)`; `color: var(--text)`. `13px` has no token; add `--fs-author: 13px;` to `tokens.css` in this step and use it. |
| `.channel` | `font: var(--fs-meta) var(--font-mono)`; `color: var(--channel-text)`. |
| `.time` | `font: var(--fs-meta) var(--font-mono)`; `color: var(--muted)`. |
| `.reply` | `margin:0`; `font-size: var(--fs-meta)`; `color: var(--muted)`; `border-left: 2px solid var(--border-strong)`; `padding-left: var(--sp-2)`. |
| `.body` | `margin:0`; `font: var(--fs-body)/var(--lh-body) var(--font-ui)`; `color: var(--text-2)`; `white-space: pre-wrap`; `text-wrap: pretty`; `overflow-wrap: anywhere`. |
| `.code` | `margin:0`; `background: var(--code-surface)`; `border: var(--hairline) solid var(--code-border)`; `border-radius: var(--radius)`; `padding: var(--sp-2) var(--sp-3)`; `font: var(--fs-small)/1.6 var(--font-mono)`; `color: var(--code-text)`; `overflow-x: auto`; `max-width: 100%`. |
| `.attachment` | `height: var(--attachment-size)`; `max-width: 100%`; `border: var(--hairline) solid var(--code-border)`; `border-radius: var(--radius)`; `overflow: hidden`; `background: repeating-linear-gradient(...)` for the 6px diagonal stripe placeholder. |
| `.attachment img` | `height: 100%`; `max-width: 100%`; `object-fit: contain`; `display: block`. |
| `.file`, `.embed a` | `color: var(--accent-text)`; `overflow-wrap: anywhere`. |
| `.embed` | `border-left: 2px solid var(--border-strong)`; `padding-left: var(--sp-2)`. |
| `.footer` | Flex, `justify-content: space-between`, `align-items: center`. |
| `.clipped` | `font: var(--fs-micro) var(--font-mono)`; `text-transform: uppercase`; `letter-spacing: .08em`; `color: var(--muted)`. |
| `.action` | Styled like the secondary button: `border: var(--hairline) solid var(--border-strong)`; `border-radius: var(--radius)`; `padding: var(--sp-2) var(--sp-btn-x)`; `font: 500 var(--fs-small) var(--font-ui)`; `color: var(--text-2)`; `text-decoration: none`. On hover, `background: var(--hover-surface)` with the 120ms color transition. |
| `.unavailable` | `font-size: var(--fs-small)`; `color: var(--muted)`. |
| `.missing` | `background: var(--missing-surface)`. |
| `.missingHeading` | Flex, `gap: var(--sp-inline-gap)`. |
| `.missingTitle` | `font: 600 var(--fs-label) var(--font-ui)`; `color: var(--text)`. |
| `.skeleton` | Flex column, `gap: var(--sp-2)`. |
| `.barStrong`, `.barWeak` | `display:block`; `height: var(--skeleton-height)`; `border-radius: var(--radius-chip)`; backgrounds `var(--skeleton-strong)` and `var(--skeleton-weak)`; widths 60% and 85%. |
| `.loading` | `margin:0`; `font: var(--fs-micro) var(--font-mono)`; `color: var(--muted)`. |
| `.mono` | `font-family: var(--font-mono)`. |

The stripe pattern is the handoff's own "diagonal 6px stripe pattern" placeholder, so a gradient is allowed only for it. Write the stripes with the tokens `--code-border` and `--code-surface`. Ledger this as a ruling, because CLAUDE.md design rule 4 says "no gradients". The handoff specifies this one pattern, and the cost if that's wrong is a solid placeholder.

- [ ] **Step 7: Run GREEN.**

Run: `pnpm vitest run tests/ui && pnpm lint`
Expected: PASS. The `--faint` guard in `primitives.test.tsx` stays green, because this CSS uses no `--faint`. Lint exits 0, and the `no-img-element` disable is the only suppression.

- [ ] **Step 8: Commit.**

```bash
git add components/archive lib/ui/format.ts tokens.css tests/ui/clip-card.test.tsx tests/ui/format.test.ts
git commit -m "feat(ui): add the clip card with loading, ready, missing and error states"
```

---

### Task 11: Screen D — the archive page (5.3)

**Files:**
- Create:
  - `components/admin/AdminHeader.tsx` + `.module.css`
  - `components/admin/SessionExpired.tsx`
  - `app/admin/[guildId]/archive/page.tsx`
  - `app/admin/[guildId]/archive/ArchiveScreen.tsx` + `.module.css`
  - `lib/admin/archive-href.ts`
- Test: `tests/ui/archive-screen.test.tsx`, `tests/admin/archive-href.test.ts`

**Interfaces:**
- Consumes: `getClipPage`, `encodeCursor` (Task 8); `ClipCard` (Task 10); `authenticateAdminPage` (Task 6); `getGuildName` and `getGuildChannelNames`.
- Produces:
  - `archiveHref(guildId: string, query: { channel?: string; before?: string; after?: string }): string`
  - `<AdminHeader guildLabel={string} active="archive" | "settings" guildId={string} />`
  - `<SessionExpired />`. It reuses Screen A's layout: the `adminSessionExpiredTitle` title, the `/setup` recovery callout from `WEB_COPY.expiredSetupLink.recovery`, and the footnote `WEB_COPY.expiredSetupLink.archiveStillWorks`.
  - `ArchiveScreen` client props:

```ts
type ArchiveScreenProps = {
  guildId: string;
  guildLabel: string;
  items: ArchiveItem[];
  total: number;
  range: { start: number; end: number } | null;
  newerHref: string | null;
  olderHref: string | null;
  channelOptions: { id: string; label: string }[];
  selectedChannel: string | null;
};
```

- [ ] **Step 1: Write the failing href test.** Create `tests/admin/archive-href.test.ts`:

```ts
test('builds linkable archive URLs; the filter alone resets paging', () => {
  expect(archiveHref('g1', {})).toBe('/admin/g1/archive');
  expect(archiveHref('g1', { channel: 'c1' })).toBe('/admin/g1/archive?channel=c1');
  expect(archiveHref('g1', { channel: 'c1', before: '1.a' })).toBe('/admin/g1/archive?channel=c1&before=1.a');
});
```

Implement it in `lib/admin/archive-href.ts` with `URLSearchParams`, adding only the defined keys in the order `channel`, `before`, `after`, and appending `?…` only when there are params. Run it, see it fail (module missing), implement, and run it GREEN.

- [ ] **Step 2: Write the failing screen test.** Create `tests/ui/archive-screen.test.tsx` (jsdom):
  - Mock `next/navigation`: `useRouter: () => ({ push })`.
  - Stub `fetch` with `vi.stubGlobal`, controlling resolution through `Promise.withResolvers`.
  - Build `items` with three rows.
  - Tests:
    1. **Shell first.** Before the content fetch resolves, three loading rows show `Discord에서 내용을 불러오는 중…` and the count `3개`. The fetch was called once, with `POST /api/admin/guilds/g1/archive/content` and a body containing exactly the three ids.
    2. **Content arrives.** Once the fetch resolves `{ items: [...] }`, the ready text appears and the list region's `aria-busy` becomes `false`.
    3. **Session lost mid-load.** A 401 replaces the page with `관리자 세션이 만료되었습니다`, and no row content stays visible.
    4. **Load failure.** A 500 or a network rejection turns every row into the transient `오류` callout. Clicking one row's `다시 시도` POSTs only that row's id.
    5. **Stale responses.** Unmounting before the fetch resolves aborts it (the `AbortSignal` passed to fetch has `aborted === true`), and no state update warning appears.
    6. **Filter.** Changing the channel select calls `push('/admin/g1/archive?channel=c2')`, and `전체` calls `push('/admin/g1/archive')`.
    7. **Pagination.** `이전` and `다음` render as links to `newerHref`/`olderHref` when present. When absent they render as `aria-disabled="true"` spans, not links. The range text is `1–3 / 3`.
    8. **Empty states.** No items and no filter shows `아직 보관된 메시지가 없습니다.`; no items with a filter shows `이 채널에서 보관된 메시지가 없습니다.`.
    9. **Header.** The tabs are links: `아카이브` has `aria-current="page"`, and `설정` links to `/admin/g1/settings`.

- [ ] **Step 3: Run it and confirm RED.**

Run: `pnpm vitest run tests/ui/archive-screen.test.tsx`
Expected: FAIL, modules missing.

- [ ] **Step 4: Implement `AdminHeader` and `SessionExpired`.**
  - **`AdminHeader`:** a `<header>` laid out like Screen B's identity bar, with a 720px container on `--surface`. Read `app/setup/[token]/ScreenB.tsx`'s identity bar and `Wordmark.tsx`, and reuse `Wordmark`.
    - Left side: `<Wordmark />`, the divider, and `guildLabel`.
    - Right side: a `<nav aria-label={WEB_COPY.archive.archiveTab + ' / ' + WEB_COPY.archive.settingsTab}>`. Don't invent an aria-label: reuse the two tab labels. It holds two `next/link` `Link`s, `/admin/{g}/archive` and `/admin/{g}/settings`, and the active one carries `aria-current="page"`.
  - **`SessionExpired`:** copy `ScreenA.tsx`'s structure, swapping only the title for `WEB_COPY_AUTHORED.adminSessionExpiredTitle` and omitting the token-specific explanation.
  - Move `Wordmark.tsx` to `components/admin/Wordmark.tsx` only if importing it across `app/` folders fails lint. Otherwise import it from `@/app/setup/[token]/Wordmark`.

- [ ] **Step 5: Implement `ArchiveScreen.tsx`.**

```tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ClipCard, type ClipCardContent } from '@/components/archive/ClipCard';
import { AdminHeader } from '@/components/admin/AdminHeader';
import { SessionExpired } from '@/components/admin/SessionExpired';
import { archiveHref } from '@/lib/admin/archive-href';
import type { ArchiveRowContent } from '@/lib/archive/content';
import type { ArchiveItem } from '@/lib/archive/reader';
import { WEB_COPY, WEB_COPY_AUTHORED, WEB_COPY_TEMPLATES } from '@/lib/ui/copy';
import styles from './ArchiveScreen.module.css';

export type ArchiveScreenProps = {
  guildId: string;
  guildLabel: string;
  items: ArchiveItem[];
  total: number;
  range: { start: number; end: number } | null;
  newerHref: string | null;
  olderHref: string | null;
  channelOptions: { id: string; label: string }[];
  selectedChannel: string | null;
};

type FetchResult = { kind: 'ok'; items: ArchiveRowContent[] } | { kind: 'expired' } | { kind: 'failed' };

async function fetchContent(guildId: string, ids: string[], signal: AbortSignal): Promise<FetchResult> {
  try {
    const response = await fetch(`/api/admin/guilds/${guildId}/archive/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceMessageIds: ids }),
      signal,
    });
    if (response.status === 401) return { kind: 'expired' };
    if (!response.ok) return { kind: 'failed' };
    const body = (await response.json()) as { items?: ArchiveRowContent[] };
    return Array.isArray(body.items) ? { kind: 'ok', items: body.items } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * Screen D. The page shell and metadata are server-rendered; row bodies are
 * fetched from Discord afterwards for this page's ids only (handoff
 * "Archive list"). The page is remounted on every URL change (see `key` in
 * page.tsx), and unmounting aborts the in-flight read, so a stale page's
 * content can never overwrite a newer one.
 */
export function ArchiveScreen(props: ArchiveScreenProps) {
  const { guildId, items } = props;
  const router = useRouter();
  const [contents, setContents] = useState<Record<string, ClipCardContent>>(() =>
    Object.fromEntries(items.map((item) => [item.sourceMessageId, { state: 'loading' }])),
  );
  const [expired, setExpired] = useState(false);

  const load = useCallback(
    async (ids: string[], signal: AbortSignal) => {
      const result = await fetchContent(guildId, ids, signal);
      if (signal.aborted) return;
      if (result.kind === 'expired') {
        setExpired(true);
        return;
      }
      setContents((previous) => {
        const next = { ...previous };
        for (const id of ids) {
          const found = result.kind === 'ok' ? result.items.find((item) => item.sourceMessageId === id) : undefined;
          next[id] = found ?? { ...errorPlaceholder(id) };
        }
        return next;
      });
    },
    [guildId],
  );

  useEffect(() => {
    if (items.length === 0) return;
    const controller = new AbortController();
    void load(items.map((item) => item.sourceMessageId), controller.signal);
    return () => controller.abort();
  }, [items, load]);

  if (expired) {
    return <SessionExpired />;
  }

  const busy = Object.values(contents).some((content) => content.state === 'loading');
  const channelLabel = (id: string) => props.channelOptions.find((option) => option.id === id)?.label ?? id;

  return (
    <div className={styles.page}>
      <AdminHeader guildId={guildId} guildLabel={props.guildLabel} active="archive" />
      <section className={styles.panel}>
        <div className={styles.filterBar}>
          <label className={styles.filterLabel} htmlFor="archive-channel">
            {WEB_COPY.archive.channelFilterLabel}
          </label>
          <select
            id="archive-channel"
            className={styles.select}
            value={props.selectedChannel ?? ''}
            onChange={(event) =>
              router.push(archiveHref(guildId, event.target.value ? { channel: event.target.value } : {}))
            }
          >
            <option value="">{WEB_COPY.archive.channelFilterAll}</option>
            {props.channelOptions.map((option) => (
              <option key={option.id} value={option.id}>{`#${option.label}`}</option>
            ))}
          </select>
          <span className={styles.count}>{WEB_COPY_TEMPLATES.clipCount.replace('{count}', String(props.total))}</span>
          <span className={styles.sort}>{WEB_COPY.archive.sortNewestFirst}</span>
        </div>

        <div className={styles.list} aria-live="polite" aria-busy={busy}>
          {items.length === 0 ? (
            <p className={styles.empty}>
              {props.selectedChannel ? WEB_COPY_AUTHORED.archiveFilterEmpty : WEB_COPY_AUTHORED.archiveEmpty}
            </p>
          ) : (
            items.map((item) => (
              <ClipCard
                key={item.sourceMessageId}
                authorUserId={item.authorUserId}
                sourceChannelLabel={channelLabel(item.sourceChannelId)}
                clippedAt={item.clippedAt}
                originalUrl={`https://discord.com/channels/${guildId}/${item.sourceChannelId}/${item.sourceMessageId}`}
                content={contents[item.sourceMessageId] ?? { state: 'loading' }}
                onRetry={() => {
                  setContents((previous) => ({ ...previous, [item.sourceMessageId]: { state: 'loading' } }));
                  void load([item.sourceMessageId], new AbortController().signal);
                }}
              />
            ))
          )}
        </div>

        {props.range && (
          <nav className={styles.pager} aria-label={`${WEB_COPY.archive.previousPage} / ${WEB_COPY.archive.nextPage}`}>
            <span className={styles.range}>
              {WEB_COPY_TEMPLATES.pageRange
                .replace('{start}', String(props.range.start))
                .replace('{end}', String(props.range.end))
                .replace('{total}', String(props.total))}
            </span>
            <PagerLink href={props.newerHref} label={WEB_COPY.archive.previousPage} />
            <PagerLink href={props.olderHref} label={WEB_COPY.archive.nextPage} />
          </nav>
        )}
      </section>
    </div>
  );
}

function PagerLink({ href, label }: { href: string | null; label: string }) {
  return href ? (
    <Link className={styles.pagerButton} href={href}>{label}</Link>
  ) : (
    <span className={styles.pagerButton} aria-disabled="true">{label}</span>
  );
}

function errorPlaceholder(sourceMessageId: string): ArchiveRowContent {
  return { sourceMessageId, state: 'error', reason: 'transient', authorName: null, originalAt: null, original: 'unknown' };
}
```

A per-row retry is not aborted on unmount. That's harmless, because `load` ignores the result after an abort only when the signal is aborted. If the reviewer flags it, ledger it; don't widen the scope.

- [ ] **Step 6: Write `ArchiveScreen.module.css`.** Every value is a token.

| Class | Rules |
|---|---|
| `.page` | Column, centered, `gap: var(--sp-3)`, `padding: var(--sp-12) var(--sp-6)`. |
| `.panel` | `width: min(var(--w-archive), 100%)`; `--surface`; 1px `--border`; radius. |
| `.filterBar` | `background: var(--raised)`; flex; `align-items: center`; `gap: var(--sp-3)`; `padding: var(--sp-3) var(--card-pad-x)`; bottom divider. `.sort` uses `margin-left: auto`. |
| `.filterLabel` | `--fs-micro` mono uppercase `--muted`. |
| `.count`, `.sort` | `--fs-meta` mono `--muted`. |
| `.pager` | Flex, `align-items: center`, `gap: var(--sp-2)`, `padding: var(--sp-3) var(--card-pad-x)`; `.range` uses `margin-right: auto`. |
| `.pagerButton` | Secondary-button styling. |
| `.pagerButton[aria-disabled="true"]` | `color: var(--pager-disabled-fg)`; `border-color: var(--pager-disabled-border)`; `pointer-events: none`. |
| `.empty` | `padding: var(--sp-8) var(--card-pad-x)`; `--muted`; `--fs-body`. |

  - Under `@media (max-width: 640px)`, `.filterBar` and `.pager` switch to `flex-direction: column; align-items: stretch`, and `.sort`/`.range` reset their auto margins.
  - Confirm `ArchiveScreen.module.css` holds no `--faint`.

- [ ] **Step 7: Implement the server page `app/admin/[guildId]/archive/page.tsx`.**

```tsx
import { redirect } from 'next/navigation';
import { SessionExpired } from '@/components/admin/SessionExpired';
import { archiveHref } from '@/lib/admin/archive-href';
import { authenticateAdminPage } from '@/lib/admin/auth';
import { getClipPage } from '@/lib/archive/reader';
import { createDiscordGuildLookup } from '@/lib/discord/guild-lookup';
import { parseEnv } from '@/lib/env';
import { ArchiveScreen } from './ArchiveScreen';

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Screen D. Reading cookies makes this page dynamic, so Next sends private, no-store. */
export default async function ArchivePage({ params, searchParams }: PageProps<'/admin/[guildId]/archive'>) {
  const { guildId } = await params;
  if (!(await authenticateAdminPage(guildId))) {
    return <SessionExpired />;
  }
  const query = await searchParams;
  const channel = single(query.channel);
  const before = single(query.before);
  const after = single(query.after);

  const lookup = createDiscordGuildLookup({ botToken: parseEnv(process.env).DISCORD_BOT_TOKEN, fetchImpl: fetch });
  const [result, guildName, channelNames] = await Promise.all([
    getClipPage({ guildId, sourceChannelId: channel, before, after }),
    lookup.getGuildName(guildId),
    lookup.getGuildChannelNames(guildId),
  ]);
  if (result.kind === 'INVALID') {
    // A malformed or hand-edited URL: recover to the first page, never an unbounded query.
    redirect(archiveHref(guildId, {}));
  }
  const { page } = result;
  return (
    <ArchiveScreen
      key={`${channel ?? ''}|${before ?? ''}|${after ?? ''}`}
      guildId={guildId}
      guildLabel={guildName ?? guildId}
      items={page.items}
      total={page.total}
      range={page.range}
      newerHref={page.newerCursor ? archiveHref(guildId, { channel, after: page.newerCursor }) : null}
      olderHref={page.olderCursor ? archiveHref(guildId, { channel, before: page.olderCursor }) : null}
      channelOptions={page.channelIds.map((id) => ({ id, label: channelNames[id] ?? id }))}
      selectedChannel={channel ?? null}
    />
  );
}
```

`channelIds` come from this guild's ACTIVE records, so a deleted channel is still offered, shown by its id (Review Focus 5). Selecting a channel that has no ACTIVE rows is still a valid filter, with an empty result.

- [ ] **Step 8: Run GREEN, then commit.**

Run: `pnpm vitest run tests/ui tests/admin && pnpm lint && pnpm build`
Expected: PASS; lint exit 0; the build compiles the new routes. The build prints them as `ƒ` (dynamic).

```bash
git add components/admin app/admin lib/admin/archive-href.ts tests/ui/archive-screen.test.tsx tests/admin/archive-href.test.ts
git commit -m "feat(archive): add Screen D with server-rendered metadata and live row content"
```

---

### Task 12: Screen E — current settings and the deletion flow (5.4 UI)

**Files:**
- Create:
  - `components/admin/ConfigTable.tsx` + `.module.css`
  - `app/admin/[guildId]/settings/page.tsx`
  - `app/admin/[guildId]/settings/SettingsScreen.tsx` + `.module.css`
- Modify: `app/setup/[token]/ScreenC.tsx` and `ScreenC.module.css`, which move the key/value table into `ConfigTable`
- Test: `tests/ui/settings-screen.test.tsx`, plus the existing `tests/ui/setup-form.test.tsx` Screen C tests, which must stay green

**Interfaces:**
- Consumes:
  - Task 7's route
  - Task 11's `AdminHeader` and `SessionExpired`
  - `findGuildArchiveConfig` and `countArchivedClips`
  - The guild lookup's `getGuildName`, `getGuildChannelNames` and `getGuildRoles`
- Produces:
  - `<ConfigTable archiveChannelLabel={string} allowedRoles={{id,name}[]} clipCount={number} />`, the four Screen C rows
  - `SettingsScreen` props:

```ts
type SettingsScreenProps = {
  guildId: string;
  guildLabel: string;
  archiveChannelLabel: string; // name, or the id when Discord has no such channel
  archiveChannelMissing: boolean; // used by Task 13 (#58)
  allowedRoles: { id: string; name: string }[];
  clipCount: number;
  saved: boolean; // ?saved=1 → the 설정을 저장했습니다. toast
};
```

- [ ] **Step 1: Extract `ConfigTable`, refactor-safe.**
  - Move the `.summary`/`.row`/`.key`/`.value`/`.mono` rules and the four rows from `ScreenC.tsx` into `components/admin/ConfigTable.tsx` and its module.
  - In ScreenC, render `<ConfigTable archiveChannelLabel={archiveChannelName} allowedRoles={allowedRoles} clipCount={clipCount} />`.
  - Keep the "role row only when non-empty" behaviour, and keep the existing comments with the code they describe.

Run: `pnpm vitest run tests/ui/setup-form.test.tsx`
Expected: PASS, with no test changes. This is a pure refactor.

Commit: `refactor(ui): share the setup summary table between Screen C and Screen E`.

- [ ] **Step 2: Write the failing Screen E test.** Create `tests/ui/settings-screen.test.tsx` (jsdom), stubbing `fetch` and rendering `SettingsScreen` with `guildId: 'g1'`, `guildLabel: 'testa'`, `archiveChannelLabel: 'clip-archive'`, `allowedRoles: [{ id: 'r1', name: 'clip-test' }]`, `clipCount: 3`, and `saved: false`.

```tsx
test('shows the current configuration and the edit link', () => {
  render(<SettingsScreen {...props} />);
  expect(screen.getByText('현재 설정')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'testa' })).toBeInTheDocument();
  expect(screen.getByText('#clip-archive')).toBeInTheDocument();
  expect(screen.getByText('@clip-test')).toBeInTheDocument();
  expect(screen.getByText('3개')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '설정 변경' })).toHaveAttribute('href', '/admin/g1/setup');
});

test('deletion is two steps with consequence copy, and the second step needs the acknowledgement', async () => {
  render(<SettingsScreen {...props} />);
  expect(screen.queryByText('Clip 데이터를 삭제하면')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Clip 데이터 삭제' }));
  expect(screen.getByText('Clip 데이터를 삭제하면')).toBeInTheDocument();
  expect(screen.getByText('아카이브 위치·허용 역할 설정')).toBeInTheDocument();
  expect(screen.getByText('보관 기록과 누가 언제 클립했는지에 대한 정보')).toBeInTheDocument();
  expect(screen.getByText('Discord의 #clip-archive 채널과 그 안의 모든 메시지')).toBeInTheDocument();
  expect(screen.getByText('원본 채널의 메시지 (영향 없음)')).toBeInTheDocument();
  expect(screen.getByText(/보관 기록과 삭제 차단 기록이 사라집니다/)).toBeInTheDocument();
  const confirm = screen.getByRole('button', { name: '삭제 실행' });
  expect(confirm).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox', { name: '위 내용을 이해했으며 되돌릴 수 없다는 것을 알고 있습니다.' }));
  expect(confirm).toBeEnabled();
});

test('a confirmed deletion posts the acknowledgement and shows completion with /setup recovery', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
  render(<SettingsScreen {...props} />);
  await openAndAcknowledge();
  await userEvent.click(screen.getByRole('button', { name: '삭제 실행' }));
  expect(fetchMock).toHaveBeenCalledWith('/api/admin/guilds/g1/delete-data', expect.objectContaining({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acknowledged: true }),
  }));
  expect(await screen.findByText(/이 서버의 Clip 데이터를 삭제했습니다/)).toBeInTheDocument();
  expect(screen.getByText('/setup')).toBeInTheDocument();
});

test('a failed deletion keeps the panel and lets the admin retry', async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
  render(<SettingsScreen {...props} />);
  await openAndAcknowledge();
  await userEvent.click(screen.getByRole('button', { name: '삭제 실행' }));
  expect(await screen.findByText('Clip 데이터를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '삭제 실행' })).toBeEnabled();
});

test('a 401 replaces the page with the session-expired screen', async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
  render(<SettingsScreen {...props} />);
  await openAndAcknowledge();
  await userEvent.click(screen.getByRole('button', { name: '삭제 실행' }));
  expect(await screen.findByText('관리자 세션이 만료되었습니다')).toBeInTheDocument();
});

test('취소 closes the confirm panel and clears the acknowledgement', async () => {
  render(<SettingsScreen {...props} />);
  await openAndAcknowledge();
  await userEvent.click(screen.getByRole('button', { name: '취소' }));
  expect(screen.queryByText('Clip 데이터를 삭제하면')).toBeNull();
});

test('a saved edit shows the toast in a live region', () => {
  render(<SettingsScreen {...props} saved />);
  const toast = screen.getByText('설정을 저장했습니다.');
  expect(toast.closest('[aria-live="polite"]')).not.toBeNull();
});
```

`openAndAcknowledge()` clicks `Clip 데이터 삭제`, then the checkbox. Check against `lib/ui/copy.ts` that the danger zone has exactly one `취소` (`deleteData.cancel`). If the role query finds two buttons named `취소`, scope it with `within(panel)`.

- [ ] **Step 3: Run it and confirm RED.**

Run: `pnpm vitest run tests/ui/settings-screen.test.tsx`
Expected: FAIL; the module is missing.

- [ ] **Step 4: Implement `SettingsScreen.tsx`.**

```tsx
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AdminHeader } from '@/components/admin/AdminHeader';
import { ConfigTable } from '@/components/admin/ConfigTable';
import { SessionExpired } from '@/components/admin/SessionExpired';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { MonoChip } from '@/components/ui/MonoChip';
import { TextTag } from '@/components/ui/TextTag';
import { WEB_COPY, WEB_COPY_AUTHORED, WEB_COPY_TEMPLATES } from '@/lib/ui/copy';
import styles from './SettingsScreen.module.css';

const RETRY_COMMAND = '/setup';
const [RECOVERY_BEFORE, RECOVERY_AFTER] = WEB_COPY.expiredSetupLink.recovery.split(RETRY_COMMAND);

type DeleteFlow = 'idle' | 'confirming' | 'deleting' | 'failed' | 'deleted' | 'expired';

export type SettingsScreenProps = {
  guildId: string;
  guildLabel: string;
  archiveChannelLabel: string;
  archiveChannelMissing: boolean;
  allowedRoles: { id: string; name: string }[];
  clipCount: number;
  saved: boolean;
};

/**
 * Screen E. Kept separate from Screen B by design: repeat-visit
 * configuration with a destructive action has a different purpose from
 * first-run setup. Deletion is always two steps (handoff "Deletion"), and
 * the server enforces the acknowledgement as well.
 */
export function SettingsScreen(props: SettingsScreenProps) {
  const copy = WEB_COPY.deleteData;
  const [flow, setFlow] = useState<DeleteFlow>('idle');
  const [acknowledged, setAcknowledged] = useState(false);

  if (flow === 'expired') {
    return <SessionExpired />;
  }

  async function confirmDeletion() {
    setFlow('deleting');
    try {
      const response = await fetch(`/api/admin/guilds/${props.guildId}/delete-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledged: true }),
      });
      setFlow(response.ok ? 'deleted' : response.status === 401 ? 'expired' : 'failed');
    } catch {
      setFlow('failed');
    }
  }

  function cancel() {
    setFlow('idle');
    setAcknowledged(false);
  }

  const panelOpen = flow === 'confirming' || flow === 'deleting' || flow === 'failed';

  return (
    <div className={styles.page}>
      <AdminHeader guildId={props.guildId} guildLabel={props.guildLabel} active="settings" />
      <div aria-live="polite" className={styles.toast}>
        {props.saved && flow === 'idle' && <Callout variant="ok">{WEB_COPY.setup.saved}</Callout>}
      </div>
      {flow === 'deleted' ? (
        <section className={styles.main}>
          <Callout variant="ok">{WEB_COPY_AUTHORED.deletionCompleted}</Callout>
          <Callout variant="note">
            {RECOVERY_BEFORE}
            <MonoChip>{RETRY_COMMAND}</MonoChip>
            {RECOVERY_AFTER}
          </Callout>
        </section>
      ) : (
        <div className={styles.columns}>
          <section className={styles.main}>
            <span className={styles.label}>{copy.currentSettingsLabel}</span>
            <h1 className={styles.title}>{props.guildLabel}</h1>
            <ConfigTable
              archiveChannelLabel={props.archiveChannelLabel}
              allowedRoles={props.allowedRoles}
              clipCount={props.clipCount}
            />
            <div>
              <Link className={styles.secondaryLink} href={`/admin/${props.guildId}/setup`}>
                {copy.editSettings}
              </Link>
            </div>
            <fieldset className={styles.danger}>
              <legend className={styles.dangerLegend}>{copy.dangerZoneLegend}</legend>
              <p className={styles.dangerText}>{copy.dangerZoneExplanation}</p>
              <Button variant="danger" onClick={() => setFlow('confirming')} disabled={panelOpen}>
                {copy.startDeletion}
              </Button>
            </fieldset>
          </section>

          {panelOpen && (
            <section className={styles.confirm} aria-labelledby="delete-confirm-title">
              <h2 id="delete-confirm-title" className={styles.confirmTitle}>
                {copy.confirmTitle}
              </h2>
              <ul className={styles.consequences}>
                {[
                  [copy.removedMark, copy.removedConfiguration],
                  [copy.removedMark, copy.removedClipRecords],
                  [copy.keptMark, WEB_COPY_TEMPLATES.keptArchiveChannel.replace('{channel}', props.archiveChannelLabel)],
                  [copy.keptMark, copy.keptSourceMessages],
                ].map(([mark, text]) => (
                  <li key={text} className={styles.consequence}>
                    <TextTag color={mark === copy.removedMark ? 'var(--error-text)' : 'var(--success-text)'}>{mark}</TextTag>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
              <p className={styles.dangerText}>{WEB_COPY_AUTHORED.deletionLosesControlState}</p>
              <label className={styles.acknowledge}>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                {copy.acknowledgement}
              </label>
              <div aria-live="polite">
                {flow === 'failed' && <Callout variant="error">{WEB_COPY_AUTHORED.deletionFailed}</Callout>}
              </div>
              <div className={styles.actions}>
                <Button variant="danger" onClick={confirmDeletion} disabled={!acknowledged || flow === 'deleting'}>
                  {copy.confirmDeletion}
                </Button>
                <Button variant="secondary" onClick={cancel}>
                  {copy.cancel}
                </Button>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
```

"One primary button per screen" (CLAUDE.md design rule 7): Screen E has none, and the two danger buttons are the two steps that rule 7 itself requires.

- [ ] **Step 5: Write `SettingsScreen.module.css`.**

| Class | Rules |
|---|---|
| `.columns` | `display: grid; grid-template-columns: var(--w-settings-main) var(--w-settings-confirm); gap: var(--sp-6); align-items: start`. Under `@media (max-width: 960px)`: `grid-template-columns: minmax(0, 1fr)`. |
| `.page` | Column, centered, `gap: var(--sp-3)`, `padding: var(--sp-12) var(--sp-6)`. |
| `.main` | Column, `gap: var(--sp-4)`. |
| `.confirm` | Column, `gap: var(--sp-4)`; `--surface`; `border: var(--hairline) solid var(--error-border)`; radius; `padding: var(--sp-5)`. |
| `.danger` | `border: var(--hairline) solid var(--border)`; radius; `padding: var(--sp-4)`; `margin: 0`. |
| `.dangerLegend` | Micro mono uppercase, `--error-text`. |
| `.label` | Micro mono uppercase, `--muted`. |
| `.title` | `600 var(--fs-title)`, `--text`. |
| `.dangerText` | `margin: 0`; `--fs-small`; `--text-2`. |
| `.consequences` | Plain list, no bullets. |
| `.consequence` | Flex, `gap: var(--sp-inline-gap)`, `--fs-small`, `--text-2`. |
| `.acknowledge` | Flex, `gap: var(--sp-2)`, `--fs-label`, `--text`. |
| `.secondaryLink` | Secondary-button look, the same as `ClipCard`'s `.action`. |

  - No `--faint` anywhere.
  - Every container has `max-width: 100%`, so nothing overflows sideways at 390px.

- [ ] **Step 6: Implement the server page `app/admin/[guildId]/settings/page.tsx`.**

```tsx
import { redirect } from 'next/navigation';
import { SessionExpired } from '@/components/admin/SessionExpired';
import { authenticateAdminPage } from '@/lib/admin/auth';
import { countArchivedClips, findGuildArchiveConfig } from '@/lib/clip/repository';
import { createDiscordGuildLookup } from '@/lib/discord/guild-lookup';
import { parseEnv } from '@/lib/env';
import { SettingsScreen } from './SettingsScreen';

/** Screen E. Dynamic (reads cookies), so Next sends private, no-store. */
export default async function SettingsPage({ params, searchParams }: PageProps<'/admin/[guildId]/settings'>) {
  const { guildId } = await params;
  if (!(await authenticateAdminPage(guildId))) {
    return <SessionExpired />;
  }
  const config = await findGuildArchiveConfig(guildId);
  if (config === null) {
    // A live session for a guild with no configuration (first setup not
    // finished): the prefilled form is also the first-setup form.
    redirect(`/admin/${guildId}/setup`);
  }
  const lookup = createDiscordGuildLookup({ botToken: parseEnv(process.env).DISCORD_BOT_TOKEN, fetchImpl: fetch });
  const [guildName, channelNames, roles, clipCount] = await Promise.all([
    lookup.getGuildName(guildId),
    lookup.getGuildChannelNames(guildId),
    lookup.getGuildRoles(guildId).catch(() => []),
    countArchivedClips(guildId),
  ]);
  const roleNames = new Map(roles.map((role) => [role.id, role.name]));
  const known = Object.keys(channelNames).length > 0;
  const query = await searchParams;
  return (
    <SettingsScreen
      guildId={guildId}
      guildLabel={guildName ?? guildId}
      archiveChannelLabel={channelNames[config.archiveChannelId] ?? config.archiveChannelId}
      // Only claim "missing" when the channel list actually loaded.
      archiveChannelMissing={known && !(config.archiveChannelId in channelNames)}
      allowedRoles={config.allowedRoleIds.map((id) => ({ id, name: roleNames.get(id) ?? id }))}
      clipCount={clipCount}
      saved={query.saved === '1'}
    />
  );
}
```

- [ ] **Step 7: Run GREEN, then commit.**

Run: `pnpm vitest run tests/ui && pnpm lint && pnpm build`
Expected: PASS; lint exit 0; the build succeeds.

```bash
git add components/admin app/admin/[guildId]/settings tests/ui/settings-screen.test.tsx
git commit -m "feat(admin): add Screen E with two-step guild-data deletion"
```

---

### Task 13: Routing (D1), the settings edit page, #59 and #58

**Files:**
- Create:
  - `app/setup/[token]/setup-client.ts`, a shared client helper that `SetupFlow` and the edit page both need
  - `app/admin/[guildId]/setup/page.tsx`
  - `app/admin/[guildId]/setup/AdminSetupEdit.tsx`
- Modify:
  - `app/setup/[token]/SetupFlow.tsx`, `ScreenB.tsx`, `ScreenC.tsx`
  - `app/setup/data/route.ts`
  - `app/admin/[guildId]/settings/SettingsScreen.tsx`
  - `lib/ui/copy.ts`, `docs/DESIGN_RATIONALE_APPEND.md`
- Test:
  - `tests/ui/setup-form.test.tsx` (updated)
  - `tests/ui/admin-setup-edit.test.tsx` (new)
  - `tests/setup/data-route.test.ts`
  - `tests/ui/settings-screen.test.tsx`

**Interfaces:**
- Produces:
  - `setup-client.ts` exports `SetupData` (gains `archiveChannelMissing: boolean`), `SaveResult`, `parseSetupData`, `parseSaveResult`, `saveOutcomeOf` and `fetchSetupData`, all moved unchanged from `SetupFlow.tsx`.
  - `ScreenB` gains two optional props:
    - `archiveHref?: string` (#59)
    - `archiveChannelMissing?: boolean` (#58)
  - `ScreenC` drops `onReviewSettings`; its actions become links.
  - `/setup/data` adds `archiveChannelMissing`.

- [ ] **Step 1: Copy gate (#58).** Ori supplies the Korean string for "the configured archive channel no longer exists in Discord; choose a channel or create one".
  - Record it in `docs/DESIGN_RATIONALE_APPEND.md` as a new numbered section. Follow the format of the last section: the date, the condition, "supplied by Ori", and the issue (#58).
  - Add it as `WEB_COPY_AUTHORED.archiveChannelMissing` with attribution, and pin it in `tests/ui/copy.test.ts`.
  - **If Ori has not supplied it when execution reaches this step, stop and ask. This is the plan's one hard copy gate; never draft it yourself.**

- [ ] **Step 2: Move the client helpers (refactor).**
  - Move `SaveResult`, `SetupData`, `isSetupChannel`, `isSetupRole`, `isStringArray`, `parseConfig`, `isNullableString`, `parseSetupData`, `isNamedRole`, `parseSaveResult`, `saveOutcomeOf` and `fetchSetupData` verbatim from `SetupFlow.tsx` into `setup-client.ts`, keeping their comments.
  - Export the ones listed above, and import them back into `SetupFlow`.

Run: `pnpm vitest run tests/ui/setup-form.test.tsx`
Expected: PASS, unchanged.

Commit: `refactor(setup): share the setup data and save parsers`.

- [ ] **Step 3: Write the failing tests.**

In `tests/setup/data-route.test.ts`:
  - `archiveChannelMissing` is `true` when `config.archiveChannelId` is not among the returned channels.
  - It is `false` when it is among them, and `false` when `config` is null.

In `tests/ui/setup-form.test.tsx`:
  - Mock `next/navigation` (`useRouter: () => ({ replace, push })`) at the top.
  - **Replace** the tests at the current lines 322 ("아카이브 열기" is a real link to the Discord archive channel), 330 ("설정 다시 보기" invokes the review-settings callback), 1057 ("설정 다시 보기" on Screen C returns to Screen B…) and 1250 ("after auto-creating the channel, 설정 다시 보기 shows the new channel selected") with:

```tsx
it('Screen C opens the web archive and Screen E', () => {
  render(<ScreenC guildId="g1" archiveChannelId="c1" archiveChannelName="clip-archive" autoCreated={false} clipCount={0} allowedRoles={[]} />);
  expect(screen.getByRole('link', { name: '아카이브 열기' })).toHaveAttribute('href', '/admin/g1/archive');
  expect(screen.getByRole('link', { name: '설정 다시 보기' })).toHaveAttribute('href', '/admin/g1/settings');
});

it('a fresh link for a configured guild goes to Screen E', async () => {
  stubSetupData({ ...setupDataBody(), config: { archiveChannelId: '111', allowedRoleIds: [] } }); // existing helpers
  render(<SetupFlow token="tok" />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/<guildId from setupDataBody>/settings'));
});
```

  - **Move** the assertions of "SetupFlow prefills a configured guild and maps a 422 MISSING_PERMISSIONS body to the refusal" (line 1185) and "SetupFlow maps a 409 to the live-Clips explanation" (line 1217) into the new `tests/ui/admin-setup-edit.test.tsx` against `AdminSetupEdit`. They are the same assertions with the same fetch stubs; only the component under test changes.
  - Add these ScreenB tests:

```tsx
it('the live-clips refusal links to the web archive (#59)', async () => {
  // Render ScreenB with archiveHref="/admin/g1/archive" and an onSubmit resolving { kind: 'live-clips' }; submit.
  expect(await screen.findByRole('link', { name: '아카이브 열기' })).toHaveAttribute('href', '/admin/g1/archive');
});

it('a deleted configured channel is called out with 누락 (#58)', () => {
  render(<ScreenB channels={CHANNELS} initial={{ archiveChannelId: 'gone', allowedRoleIds: [] }} archiveChannelMissing onSubmit={vi.fn()} />);
  expect(screen.getByText('누락')).toBeInTheDocument();
  expect(screen.getByText(WEB_COPY_AUTHORED.archiveChannelMissing)).toBeInTheDocument();
});
```

In `tests/ui/admin-setup-edit.test.tsx`, besides the two moved tests, add:
  - A successful save calls `push('/admin/g1/settings?saved=1')`.
  - `취소` calls `push('/admin/g1/settings')`.
  - A `/setup/data` 401 renders `관리자 세션이 만료되었습니다`.

In `tests/ui/settings-screen.test.tsx`, add: `archiveChannelMissing` renders the `누락` callout with the #58 copy.

- [ ] **Step 4: Run them and confirm RED.**

Run: `pnpm vitest run tests/ui tests/setup`
Expected: FAIL.
  - No `archiveChannelMissing` field exists yet.
  - ScreenC renders the Discord URL and a button, not a link.
  - There is no redirect.
  - `AdminSetupEdit` is missing.
  - ScreenB has no link and no callout.

- [ ] **Step 5: Implement the changes.**
  - **`app/setup/data/route.ts`:** add `archiveChannelMissing: config !== null && !channels.some((channel) => channel.id === config.archiveChannelId)` to the body, and add the field to `parseSetupData` in `setup-client.ts`, defaulting to `false` when it is absent.
  - **`ScreenC.tsx`:**
    - Replace the `<a href={archiveUrl}…>` with `<Link className={styles.primaryLink} href={`/admin/${guildId}/archive`}>`, and the `<Button onClick={onReviewSettings}>` with `<Link className={styles.secondaryLink} href={`/admin/${guildId}/settings`}>`.
    - Add a `.secondaryLink` rule in `ScreenC.module.css` that mirrors the secondary button.
    - Remove the `onReviewSettings` prop, the `archiveUrl` constant, and the doc comment that says the web archive is cut. That comment is now false, so removing it is allowed.
  - **`SetupFlow.tsx`:**
    - Import `useRouter`.
    - In the two places that set `{ status: 'ready', … }` after a successful data load, first check `data.config !== null`. If it is set, call `router.replace(`/admin/${data.guildId}/settings`)` and return, leaving state `loading`. Comment the check: `// A configured guild's fresh link opens Screen E (decision D1); the setup form is reached from there.`
    - Delete the `onReviewSettings` handler block passed to `ScreenC`. ScreenC no longer takes it, and the edit page reloads fresh channels, which the Wave 4 auto-created-channel fix is now about.
  - **`ScreenB.tsx`:**
    - Add the optional props `archiveHref?: string` and `archiveChannelMissing?: boolean`.
    - Under the live-clips callout, when `archiveHref` is set, render `<Link className={styles.inlineLink} href={archiveHref}>{WEB_COPY.setupComplete.openArchive}</Link>`.
    - When `archiveChannelMissing`, render `<Callout variant="missing">{WEB_COPY_AUTHORED.archiveChannelMissing}</Callout>` directly above the channel select, inside the existing-channel reveal. Leave the select at its placeholder.
    - Add `.inlineLink` (`color: var(--accent-text)`).
  - **`SettingsScreen.tsx`:** when `archiveChannelMissing`, render the same `missing` callout above `ConfigTable`.
  - **`AdminSetupEdit.tsx`:**

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SessionExpired } from '@/components/admin/SessionExpired';
import { ScreenB, type SaveOutcome, type SetupSubmission } from '@/app/setup/[token]/ScreenB';
import { ScreenLoadError } from '@/app/setup/[token]/ScreenLoadError';
import { fetchSetupData, parseSaveResult, saveOutcomeOf, type SetupData } from '@/app/setup/[token]/setup-client';

type State = { status: 'loading' } | { status: 'expired' } | { status: 'failed' } | { status: 'ready'; data: SetupData };

/**
 * The explicit edit reached from Screen E's 설정 변경 (decision D1): the
 * prefilled Screen B on the existing session, with no setup token involved.
 * A successful save returns to Screen E, which shows the 설정을 저장했습니다.
 * toast.
 */
export function AdminSetupEdit({ guildId }: { guildId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const settingsHref = `/admin/${guildId}/settings`;

  useEffect(() => {
    let cancelled = false;
    fetchSetupData().then((result) => {
      if (cancelled) return;
      if (result.status === 'ready') setState({ status: 'ready', data: result.data });
      else setState({ status: result.status === 'unauthenticated' ? 'expired' : 'failed' });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (state.status === 'loading') return null;
  if (state.status === 'expired') return <SessionExpired />;
  if (state.status === 'failed') {
    return <ScreenLoadError onRetry={() => { setState({ status: 'loading' }); setAttempt((n) => n + 1); }} />;
  }

  const { data } = state;
  async function handleSubmit(submission: SetupSubmission): Promise<SaveOutcome> {
    try {
      const response = await fetch('/setup/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      });
      if (!response.ok) return saveOutcomeOf(response);
      if (!parseSaveResult(await response.json())) return { kind: 'failed' };
      router.push(`${settingsHref}?saved=1`);
      return { kind: 'saved' };
    } catch {
      return { kind: 'failed' };
    }
  }

  return (
    <ScreenB
      channels={data.channels}
      roles={data.roles}
      initial={data.config}
      archiveChannelMissing={data.archiveChannelMissing}
      archiveHref={`/admin/${guildId}/archive`}
      guildName={data.guildName ?? data.guildId}
      adminHandle={data.adminHandle ?? undefined}
      onSubmit={handleSubmit}
      onCancel={() => router.push(settingsHref)}
    />
  );
}
```

Match the identity-bar prop names to the ones `ScreenB` actually takes (read `ScreenBProps`). The names shown above follow the Wave 4 summary. When `SetupFlow` renders Screen B for a first setup, also pass `archiveHref={`/admin/${setup.guildId}/archive`}` (a first setup can't hit `LIVE_CLIPS`, but the prop is harmless) and `archiveChannelMissing={setup.archiveChannelMissing}`.

  - **`app/admin/[guildId]/setup/page.tsx`:**

```tsx
import { SessionExpired } from '@/components/admin/SessionExpired';
import { authenticateAdminPage } from '@/lib/admin/auth';
import { AdminSetupEdit } from './AdminSetupEdit';

export default async function AdminSetupPage({ params }: PageProps<'/admin/[guildId]/setup'>) {
  const { guildId } = await params;
  return (await authenticateAdminPage(guildId)) ? <AdminSetupEdit guildId={guildId} /> : <SessionExpired />;
}
```

- [ ] **Step 6: Run GREEN, then commit.**

Run: `pnpm vitest run && pnpm lint && pnpm build`
Expected: the full suite passes with no `Errors` line; lint exit 0; build OK.

```bash
git add app components lib/ui/copy.ts docs/DESIGN_RATIONALE_APPEND.md tests
git commit -m "feat(setup): route configured guilds through Screen E, link refusals to the archive, flag a deleted archive channel"
```

---

### Task 14: Recreate rollout for the boundary release

**Files:**
- Modify: `k8s/deployment.yaml`
- Test: `tests/scripts/render-k8s-deployment.test.ts`

- [ ] **Step 1: Write the failing test.** Add to the existing `describe` in `tests/scripts/render-k8s-deployment.test.ts`, using the same render setup as its first test:

```ts
it('replaces pods with Recreate, so old and new writers never overlap', () => {
  // render as the first test does, into `manifest`
  expect(manifest).toMatch(/^\s{2}strategy:\n\s{4}type: Recreate$/m);
});
```

- [ ] **Step 2: Run it and confirm RED.**

Run: `pnpm vitest run tests/scripts/render-k8s-deployment.test.ts`
Expected: FAIL. The manifest has no `strategy`, so Kubernetes defaults to RollingUpdate. The 2026-10-08 rollout's "old replicas are pending termination" output showed that.

- [ ] **Step 3: Implement it.** In `k8s/deployment.yaml`, under `spec:` after `replicas: 1`, add:

```yaml
  # Recreate, not the default RollingUpdate: an old pod must never keep
  # writing while a new one runs. The guild lock and configurationId
  # boundary (lib/guild-lock.ts) only protect writers that know about them
  # (design: "Guild-data deletion and concurrent work"). One replica, so
  # the cost is a few seconds of downtime per deploy.
  strategy:
    type: Recreate
```

- [ ] **Step 4: Run GREEN, then commit.**

```bash
git add k8s/deployment.yaml tests/scripts/render-k8s-deployment.test.ts
git commit -m "chore(k8s): roll out with Recreate so old writers stop before new ones start"
```

---

### Task 15: Gate, review, PR, deploy and live checks

- [ ] **Step 1: Full gate.**

Run: `export DATABASE_URL=postgresql://clip:clip@localhost:5433/clip_dev && pnpm lint && pnpm test > /tmp/wave5-test.log 2>&1; tail -8 /tmp/wave5-test.log; pnpm build`
Expected:
  - lint exit 0
  - `Test Files N passed (N)` and `Tests M passed (M)`, with **no** `Errors` line
  - build OK, listing `/admin/[guildId]/archive`, `/admin/[guildId]/settings`, `/admin/[guildId]/setup`, and both new `/api/admin/...` routes as dynamic

- [ ] **Step 2: Responsive pass.** Run `pnpm dev` against local Postgres. Use the Playwright MCP browser with a seeded session cookie: insert an `admin_sessions` row with the HMAC of a known token, or exchange a token issued from a test script. Check Screens D and E at widths 1280, 960, 640 and 390.
  - There is no horizontal page scroll at any width.
  - Long URLs and code stay inside the card.
  - The Screen E columns stack below 960px.
  - The filter bar and pager stack at 640px or less.
  - Screen B's narrow-screen overflow was already recorded in the journal and is in scope (spec "Visual and accessibility contract"). Fix it here if it's still present, with a test-backed CSS change, or ledger it for Wave 6 with Ori's say-so.
  - Record the widths checked and the results in the journal.

- [ ] **Step 3: Journal entry.** Write `docs/journal/journal-2026-10.md`, section "2026-10-XX — Wave 5". It covers:
  - what shipped
  - every `Ruling:`, including D4–D8 and any made during execution
  - deviations and slips
  - deferred minors
  - the responsive results
  - the #58 copy

- [ ] **Step 4: Final review.** Run `superpowers:requesting-code-review` with a fresh reviewer on the most capable model. Give it the branch diff against `main`, this plan, the spec, and this plan's Review Focus section verbatim. Fix the Critical and Important findings test-first, in one pass, and ledger the minors.

- [ ] **Step 5: PR.** Push `wave/5-web-archive` and open the PR with the repo template.
  - **Title:** `Wave 5: web archive, settings and guild-data deletion`.
  - **Body:**
    - `Closes #12, #31, #32, #33, #34, #58, #59`
    - the decisions table (D1–D8)
    - the gate output
    - the responsive results
    - the deploy note: Recreate rollout, a migration that adds a column and an index, and confirming the deployment is healthy **before** any destructive check
    - the live checks below as the unchecked verification list

- [ ] **Step 6: After Ori merges.** Deploy with the documented procedure in `docs/02_CLIP_IMPLEMENTATION_PLAN.md`. **Ori runs it**, because the session's permission mode blocks production deploys.
  - Hand Ori the script pointed at the merge commit's `sha-<7>` image.
  - The rollout must show the old pod terminating before the new one starts, which is the Recreate behaviour.
  - Then confirm both containers run the new image, migrate shows one applied migration, and `/api/health` returns `{"ok":true}`.

- [ ] **Step 7: Live checks, with Ori in the test guild `testa`.** Confirm each against production rows.
  1. **Screen C links.** After `/setup` on a configured guild, the link lands on Screen E. On a fresh first setup in a new guild, Screen C's two links open Screen D and Screen E.
  2. **Screen D content.** It lists the ACTIVE clips with live content. Filtering by channel changes the count. With 21 or more clips, both pagination directions work. Seed them by clipping 21 messages, or skip this part and say so.
  3. **Missing copy.** Delete one archive forward message in Discord; its row shows `누락` with the metadata kept.
  4. **Access denied.** Deny the bot `READ_MESSAGE_HISTORY` on `#clip-archive`; rows show the access `오류`. Restore the permission afterwards.
  5. **Settings edit.** `설정 변경`, change roles, save. You land on Screen E with `설정을 저장했습니다.`
  6. **#59 link.** With a live clip, try changing the channel. The refusal shows `아카이브 열기`, linking to Screen D.
  7. **Deletion.** Note the archive channel's message count, then delete from Screen E with the acknowledgement.
     - The completion screen appears.
     - Production has zero rows for `testa` in every table.
     - The archive channel and its messages are still in Discord.
     - Running `/setup` again works, and a message that was tombstoned before can be clipped again.
  8. **Expired session.** After 30 minutes, or after deletion, any admin page shows `관리자 세션이 만료되었습니다` with the `/setup` recovery.

- [ ] **Step 8: Record and close.** Add the live results to the journal. Update the README's as-shipped rows: Screen D/E and deletion become 출시. Use identifiers and a journal pointer only; no new Korean prose (memory: Korean README prose needs Ori's review). Commit `docs: record Wave 5 as shipped` on a docs branch, open its PR, and close the issues the PR did not auto-close.
