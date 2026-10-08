# Wave 4 — Clipping roles and setup completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (Ori chose inline execution with one review before the PR). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can configure which roles may clip, see and edit the current configuration from a fresh `/setup` link, and is refused an existing archive channel the bot cannot actually use.

**Architecture:** Extend the deployed setup flow in place. `/setup/data` grows the current configuration, guild roles and identity details; `/setup/save` grows `allowedRoleIds`, a server-side effective-permission check for existing channels, and readable refusal bodies. Role replacement happens inside the same database transaction as the configuration write. A pure permission function in `lib/discord/permissions.ts` carries Discord's overwrite precedence.

**Tech Stack:** Next.js 16 App Router route handlers, React 19 client components with CSS modules, Prisma 7 on PostgreSQL 17, Zod 4, Vitest 4 with Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-05-p0-restoration-design.md` (sections "Admin access and navigation", "Roles and destination validation", "Korean copy drafts for review"). UI spec: `docs/06_DESIGN_HANDOFF.md` ("Role multi-select", "Screen B", "Screen C").

## Global Constraints

- Branch `wave/4-p0-restoration`, worktree `/Users/ori/repos/clip-wave4`. Never commit to `main`. Conventional Commits, one commit per task.
- Merge gate: `pnpm lint`, `pnpm test`, `pnpm build` green. Postgres tests run against the local container (`postgresql://clip:clip@localhost:5433/clip_dev`, start with `docker start clip-pg` if stopped).
- Korean copy comes only from `docs/06_DESIGN_HANDOFF.md` or Ori-approved entries in `WEB_COPY_AUTHORED`. Never paraphrase. Never invent a Korean string — including `aria-label`s.
- `tokens.css` is the only source of visual values; `--faint` only for disabled controls; radius 2px (chips 1px); no shadows/gradients/animation beyond the 120ms hover colour transition.
- Monospace only for machine values (channel, role, permission constant, ID).
- Clipping authority and Discord readership are separate: no role edit changes any Discord permission overwrite. `MANAGE_CHANNELS` stays bootstrap-only.
- Required archive-channel permissions for the bot: `VIEW_CHANNEL`, `SEND_MESSAGES`, `READ_MESSAGE_HISTORY`. Never `ADMINISTRATOR`, never `MANAGE_MESSAGES`.
- `@everyone` (role id == guild id) is shown but unselectable. Empty role selection is valid (admins only).
- Guild id always comes from the admin session, never a request body.
- Discord payload fields beyond those a caller needs are dropped at the parse boundary; `permission_overwrites` never reach the browser.
- Never log message bodies or Discord payloads. Log ids and error codes only, through `logClipEvent`.
- Out of scope for this wave (Wave 5): advisory lock, `configurationId`, Screen D/E, the archive web link from Screen C, the edit-success toast.

## Copy gate (blocks Tasks 1 and 7)

Three strings need Ori's sign-off before their tasks commit. The plan uses these keys; the values come from the design's draft table:

| Key | Status | Value |
|---|---|---|
| `WEB_COPY.setup.destinationCreateDescription` (replaces handoff line 148) | Approved 2026-10-07, **one word open**: Ori wrote `채널 관리 역할`; the intended meaning is the permission (`권한`) | `Clip이 #clip-archive를 비공개 채널로 만듭니다. 클립 가능 역할은 채널 열람 권한이 없습니다. 해당 권한은 서버 관리자가 설정합니다. (선택적) 생성이 끝나면 채널 관리 역할을 회수해 주세요.` |
| `WEB_COPY_AUTHORED.destinationMissingPermissions` | Draft, awaiting approval | `이 채널에서 Clip에 필요한 권한이 없습니다. Discord에서 아래 권한을 확인한 뒤 다시 시도해 주세요.` |
| `WEB_COPY_AUTHORED.destinationChangeBlocked` | Draft, awaiting approval | `보관 중인 메시지가 있어 아카이브 채널을 변경할 수 없습니다. 기존 메시지를 보관에서 제거한 뒤 다시 시도해 주세요.` |

Use exactly the text Ori finally approves. Also confirm whether `(선택적)` is meant to render in the UI.

## Interim behaviour until Wave 5 (accepted by Ori at plan review)

- A fresh `/setup` link on a configured guild opens a prefilled Screen B; the design's current-settings view (Screen E) arrives in Wave 5.
- A successful edit shows Screen C, not the handoff's `설정을 저장했습니다.` toast.
- A roles-only edit re-runs the destination permission check on the unchanged channel. A channel auto-created before this wave has no bot `READ_MESSAGE_HISTORY` overwrite, so roles cannot be edited until history reads are granted in Discord (guild-level or overwrite). That is a Discord-side fix, never a code bypass; live check 1 exercises it.
- A saved role that was later deleted in Discord appears as a chip by id; saving with it returns `INVALID_ROLE`, which the UI shows as the generic `saveFailed` callout unless Ori approves a specific string.

## Review Focus

1. **A configured guild re-saving only its roles must not create a second `#clip-archive`.** Screen B currently defaults to `create`; the edit path must prefill `existing` with the current channel. Pinned in Task 7.
2. **Overwrite precedence.** A role allow beats another role's deny; a member overwrite beats role overwrites; a denied `VIEW_CHANNEL` zeroes everything; `ADMINISTRATOR` short-circuits; the `@everyone` overwrite is keyed by the guild id. Pinned as a table test in Task 2.
3. **A stale or foreign role id in a save is refused (422), never silently dropped or granted.** Pinned in Task 5.
4. **First setup writes the config row and its roles atomically.** A role insert failure must leave no config row. Pinned in Task 4.
5. **Losing a clipping role still lets a member Unclip their own signal, and a role-only edit is allowed while Clips are live.** Pinned in Task 4.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/ui/copy.ts`, `docs/06_DESIGN_HANDOFF.md`, `docs/DESIGN_RATIONALE_APPEND.md` | Replaced auto-create sentence; two authored error strings | 1 |
| `lib/discord/permissions.ts` | All permission flags + `computeChannelPermissions` + `missingArchivePermissions` | 2 |
| `lib/discord/guild-lookup.ts` | Server-only Discord reads: roles, one channel's overwrites, bot member roles, guild name, user handle | 3 |
| `lib/clip/repository.ts` | `finalizeGuildArchiveConfig` replaces allowed roles transactionally | 4 |
| `app/setup/save/route.ts` | Validates roles, checks destination permissions, readable refusals | 5 |
| `app/setup/data/route.ts` | Returns current config, roles, identity | 6 |
| `components/ui/RoleMultiSelect.tsx` + `.module.css` | F.4 keyboard-operable role picker | 7 |
| `app/setup/[token]/ScreenB.tsx`, `SetupFlow.tsx` | Roles section, prefill, refusal callouts | 8 |
| `app/setup/[token]/ScreenC.tsx` | `허용 역할` row | 8 |
| `README.md`, journal | As-built status | 9 |

---

### Task 1: Copy — replace the auto-create sentence and add the two refusal strings

**Gate:** Do not start until the Copy gate table is resolved.

**Files:**
- Modify: `docs/06_DESIGN_HANDOFF.md:148`
- Modify: `lib/ui/copy.ts` (`WEB_COPY.setup.destinationCreateDescription`, `WEB_COPY_AUTHORED`)
- Modify: `docs/DESIGN_RATIONALE_APPEND.md` (append §13)
- Test: `tests/ui/copy.test.ts` (existing anti-drift test, unchanged)

**Interfaces:**
- Produces: `WEB_COPY_AUTHORED.destinationMissingPermissions: string`, `WEB_COPY_AUTHORED.destinationChangeBlocked: string`.

- [ ] **Step 1: Change only the string table first, and run the anti-drift test to see it fail**

In `lib/ui/copy.ts` set `destinationCreateDescription` to the approved sentence.

Run: `pnpm vitest run tests/ui/copy.test.ts`
Expected: FAIL — the quoted-verbatim check cannot find the new sentence in `docs/06_DESIGN_HANDOFF.md`.

- [ ] **Step 2: Update the handoff line 148 description to the same sentence, character for character**

Replace the backticked description after `비공개 아카이브 채널 새로 만들기 — 권장` + description: with the approved sentence.

- [ ] **Step 3: Add the authored strings**

```ts
  /**
   * Screen B refusal — the chosen existing channel denies Clip a permission
   * it needs; the missing constants render below as mono chips. Drafted in
   * docs/superpowers/specs/2026-10-05-p0-restoration-design.md, approved by
   * Ori on <date of approval>.
   */
  destinationMissingPermissions: '<approved text>',
  /**
   * Screen B refusal — `/setup/save` answered 409 because live Clips depend
   * on the current archive channel. Same provenance as above.
   */
  destinationChangeBlocked: '<approved text>',
```

(Fill `<approved text>` and `<date of approval>` from the resolved Copy gate; nothing else.)

- [ ] **Step 4: Append the rationale entry**

Append to `docs/DESIGN_RATIONALE_APPEND.md`:

```markdown
## 13. 2026-10-07 — Auto-create description and setup refusal copy

The handoff's auto-create description promised that only configured roles could view the archive. §12 separated clipping authority from readership, so the sentence was replaced with Ori's approved text in the handoff and the string table together. Two refusal strings with no handoff source — missing destination permissions and a destination change blocked by live Clips — were added to `WEB_COPY_AUTHORED` from the restoration design's draft table after Ori's approval.
```

- [ ] **Step 5: Run the copy tests**

Run: `pnpm vitest run tests/ui`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/ui/copy.ts docs/06_DESIGN_HANDOFF.md docs/DESIGN_RATIONALE_APPEND.md
git commit -m "docs(copy): replace the role-visibility promise and add setup refusal copy"
```

---

### Task 2: Effective channel permissions (pure function)

**Files:**
- Modify: `lib/discord/permissions.ts`
- Modify: `app/setup/save/route.ts` (delete the local `VIEW_CHANNEL_PERMISSION`/`SEND_MESSAGES_PERMISSION` constants and their "stay local" comment; import from permissions)
- Test: `tests/discord/permissions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PERMISSION = { ADMINISTRATOR, VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY } // bigint flags
  export type PermissionOverwrite = { id: string; type: 0 | 1; allow: bigint; deny: bigint };
  export type ChannelPermissionInput = {
    guildId: string;                       // also the @everyone role id
    memberId: string;
    memberRoleIds: readonly string[];      // excludes @everyone
    rolePermissions: ReadonlyMap<string, bigint>; // role id -> guild-level permissions, includes @everyone
    overwrites: readonly PermissionOverwrite[];
  };
  export function computeChannelPermissions(input: ChannelPermissionInput): bigint;
  export const ARCHIVE_CHANNEL_PERMISSIONS: readonly ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'];
  export function missingArchivePermissions(permissions: bigint): Array<'VIEW_CHANNEL' | 'SEND_MESSAGES' | 'READ_MESSAGE_HISTORY'>;
  ```

- [ ] **Step 1: Write the failing table test**

Append to `tests/discord/permissions.test.ts`:

```ts
import {
  computeChannelPermissions,
  missingArchivePermissions,
  PERMISSION,
  type ChannelPermissionInput,
} from '@/lib/discord/permissions';

const GUILD = '100';
const BOT = '200';
const ROLE_A = '300';
const ROLE_B = '301';
const { ADMINISTRATOR, VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY } = PERMISSION;
const ARCHIVE = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY;

function input(over: Partial<ChannelPermissionInput>): ChannelPermissionInput {
  return {
    guildId: GUILD,
    memberId: BOT,
    memberRoleIds: [ROLE_A, ROLE_B],
    rolePermissions: new Map([[GUILD, 0n], [ROLE_A, 0n], [ROLE_B, 0n]]),
    overwrites: [],
    ...over,
  };
}

describe('computeChannelPermissions', () => {
  test.each([
    ['guild-level role grants apply with no overwrites',
      input({ rolePermissions: new Map([[GUILD, VIEW_CHANNEL], [ROLE_A, SEND_MESSAGES | READ_MESSAGE_HISTORY], [ROLE_B, 0n]]) }),
      ARCHIVE],
    ['@everyone overwrite is keyed by the guild id',
      input({ rolePermissions: new Map([[GUILD, ARCHIVE], [ROLE_A, 0n], [ROLE_B, 0n]]),
        overwrites: [{ id: GUILD, type: 0, allow: 0n, deny: VIEW_CHANNEL }] }),
      0n],
    ['a role allow beats another role deny',
      input({ rolePermissions: new Map([[GUILD, ARCHIVE], [ROLE_A, 0n], [ROLE_B, 0n]]),
        // Allow listed first: applying role overwrites one by one in array
        // order would let the later deny win, so this order catches it.
        overwrites: [
          { id: ROLE_B, type: 0, allow: SEND_MESSAGES, deny: 0n },
          { id: ROLE_A, type: 0, allow: 0n, deny: SEND_MESSAGES },
        ] }),
      ARCHIVE],
    ['a role deny with no counter-allow removes the permission',
      input({ rolePermissions: new Map([[GUILD, ARCHIVE], [ROLE_A, 0n], [ROLE_B, 0n]]),
        overwrites: [{ id: ROLE_A, type: 0, allow: 0n, deny: READ_MESSAGE_HISTORY }] }),
      VIEW_CHANNEL | SEND_MESSAGES],
    ['a role allow restores VIEW_CHANNEL denied to @everyone (the usual private channel)',
      input({ rolePermissions: new Map([[GUILD, ARCHIVE], [ROLE_A, 0n], [ROLE_B, 0n]]),
        overwrites: [
          { id: ROLE_A, type: 0, allow: VIEW_CHANNEL, deny: 0n },
          { id: GUILD, type: 0, allow: 0n, deny: VIEW_CHANNEL },
        ] }),
      ARCHIVE],
    ['a member overwrite beats role overwrites',
      input({ rolePermissions: new Map([[GUILD, ARCHIVE], [ROLE_A, 0n], [ROLE_B, 0n]]),
        // Member overwrite listed first, so an implementation that ignores
        // `type` and applies in array order lets the role allow win.
        overwrites: [
          { id: BOT, type: 1, allow: 0n, deny: READ_MESSAGE_HISTORY },
          { id: ROLE_A, type: 0, allow: READ_MESSAGE_HISTORY, deny: 0n },
        ] }),
      VIEW_CHANNEL | SEND_MESSAGES],
    ['a denied VIEW_CHANNEL leaves nothing',
      input({ rolePermissions: new Map([[GUILD, ARCHIVE], [ROLE_A, 0n], [ROLE_B, 0n]]),
        overwrites: [{ id: BOT, type: 1, allow: 0n, deny: VIEW_CHANNEL }] }),
      0n],
    ['ADMINISTRATOR short-circuits every overwrite',
      input({ rolePermissions: new Map([[GUILD, 0n], [ROLE_A, ADMINISTRATOR], [ROLE_B, 0n]]),
        overwrites: [{ id: BOT, type: 1, allow: 0n, deny: VIEW_CHANNEL }] }),
      'all'],
    ['an overwrite for a role the member lacks is ignored',
      input({ memberRoleIds: [ROLE_A], rolePermissions: new Map([[GUILD, ARCHIVE], [ROLE_A, 0n]]),
        overwrites: [{ id: ROLE_B, type: 0, allow: 0n, deny: VIEW_CHANNEL }] }),
      ARCHIVE],
  ])('%s', (_name, permissionInput, expected) => {
    const result = computeChannelPermissions(permissionInput);
    if (expected === 'all') {
      expect(missingArchivePermissions(result)).toEqual([]);
      expect(result & ADMINISTRATOR).toBe(ADMINISTRATOR);
    } else {
      expect(result).toBe(expected);
    }
  });
});

describe('missingArchivePermissions', () => {
  test('names each missing archive permission in a fixed order', () => {
    expect(missingArchivePermissions(VIEW_CHANNEL)).toEqual(['SEND_MESSAGES', 'READ_MESSAGE_HISTORY']);
    expect(missingArchivePermissions(ARCHIVE)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/discord/permissions.test.ts`
Expected: FAIL — `computeChannelPermissions` is not exported.

- [ ] **Step 3: Implement**

Add to `lib/discord/permissions.ts` (keep `hasManageGuild` and its comments; move `MANAGE_GUILD` into the object only if it reads cleanly, otherwise leave it):

```ts
export const PERMISSION = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  READ_MESSAGE_HISTORY: 1n << 16n,
} as const;

const ALL_PERMISSIONS = (1n << 64n) - 1n;

export type PermissionOverwrite = { id: string; type: 0 | 1; allow: bigint; deny: bigint };

export type ChannelPermissionInput = {
  /** Also the id of the guild's `@everyone` role. */
  guildId: string;
  memberId: string;
  /** The member's roles, not including `@everyone`. */
  memberRoleIds: readonly string[];
  /** Guild-level permissions per role id, including `@everyone`. */
  rolePermissions: ReadonlyMap<string, bigint>;
  overwrites: readonly PermissionOverwrite[];
};

/**
 * A member's effective permissions in one channel, following Discord's
 * documented order (developers.discord.com/docs/topics/permissions#permission-overwrites):
 * guild-level role permissions, ADMINISTRATOR short-circuit, the `@everyone`
 * overwrite, all role overwrites combined (every deny, then every allow),
 * then the member overwrite. Without VIEW_CHANNEL nothing else applies.
 * Guild ownership is not modelled: the bot is never the owner.
 */
export function computeChannelPermissions(input: ChannelPermissionInput): bigint {
  let permissions = input.rolePermissions.get(input.guildId) ?? 0n;
  for (const roleId of input.memberRoleIds) {
    permissions |= input.rolePermissions.get(roleId) ?? 0n;
  }
  if ((permissions & PERMISSION.ADMINISTRATOR) === PERMISSION.ADMINISTRATOR) {
    return ALL_PERMISSIONS;
  }

  const everyone = input.overwrites.find((o) => o.type === 0 && o.id === input.guildId);
  if (everyone) {
    permissions = (permissions & ~everyone.deny) | everyone.allow;
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of input.overwrites) {
    if (overwrite.type === 0 && input.memberRoleIds.includes(overwrite.id)) {
      roleAllow |= overwrite.allow;
      roleDeny |= overwrite.deny;
    }
  }
  permissions = (permissions & ~roleDeny) | roleAllow;

  const member = input.overwrites.find((o) => o.type === 1 && o.id === input.memberId);
  if (member) {
    permissions = (permissions & ~member.deny) | member.allow;
  }

  if ((permissions & PERMISSION.VIEW_CHANNEL) !== PERMISSION.VIEW_CHANNEL) {
    return 0n;
  }
  return permissions;
}

export const ARCHIVE_CHANNEL_PERMISSIONS = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'] as const;
export type ArchiveChannelPermission = (typeof ARCHIVE_CHANNEL_PERMISSIONS)[number];

/** The archive-channel permissions `permissions` lacks, in a fixed order. */
export function missingArchivePermissions(permissions: bigint): ArchiveChannelPermission[] {
  return ARCHIVE_CHANNEL_PERMISSIONS.filter(
    (name) => (permissions & PERMISSION[name]) !== PERMISSION[name],
  );
}
```

In `app/setup/save/route.ts`, delete `VIEW_CHANNEL_PERMISSION`/`SEND_MESSAGES_PERMISSION` and the comment block above them (it is now false: there is a second caller), import `PERMISSION`, and use `PERMISSION.VIEW_CHANNEL` / `PERMISSION.SEND_MESSAGES`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/discord/permissions.test.ts tests/setup/save-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/discord/permissions.ts app/setup/save/route.ts tests/discord/permissions.test.ts
git commit -m "feat(discord): compute a member's effective channel permissions"
```

---

### Task 3: Server-only Discord reads for roles, overwrites and identity

**Files:**
- Modify: `lib/discord/guild-lookup.ts`
- Test: `tests/discord/guild-lookup.test.ts`

**Interfaces:**
- Consumes: `PermissionOverwrite` from Task 2.
- Produces (added to `DiscordGuildLookup`):
  ```ts
  export type GuildRole = { id: string; name: string; permissions: bigint };
  getGuildRoles(guildId: string): Promise<GuildRole[]>;            // includes @everyone (id === guildId)
  getChannelOverwrites(channelId: string): Promise<PermissionOverwrite[]>;
  getMemberRoleIds(guildId: string, userId: string): Promise<string[]>;
  getGuildName(guildId: string): Promise<string | null>;          // null on any failure — display only, the id is the fallback
  getUserHandle(userId: string): Promise<string | null>;           // null on any failure — display only
  ```
  All but `getGuildName` and `getUserHandle` throw `GuildUnavailableError` / `GuildLookupFailedError` exactly as `getGuildSetupChannels` does.

- [ ] **Step 1: Write failing tests** — follow the file's existing stub-fetch style (`json()`, recorded `Call`s). One test per method:
  - `getGuildRoles` calls `GET /guilds/{id}/roles`, returns `{id,name,permissions: BigInt(...)}` and drops `color`, `icon`, `tags`, etc.; skips entries whose `permissions` is not a decimal string.
  - `getChannelOverwrites` calls `GET /channels/{id}`, returns only `permission_overwrites` parsed to bigint `allow`/`deny`, and only `type` 0 or 1.
  - `getMemberRoleIds` calls `GET /guilds/{g}/members/{u}` and returns `roles`.
  - `getGuildName` calls `GET /guilds/{id}` and returns `name`; any failure returns `null`.
  - `getUserHandle` calls `GET /users/{id}` and returns `username`; a 404 returns `null` instead of throwing.
  - A 404 with code `10004` from `getGuildRoles` throws `GuildUnavailableError`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/discord/guild-lookup.test.ts`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement** — generalise the private `fetchGuildChannels` into `fetchOrThrow(path)` with the same error mapping, and add narrow parsers:

```ts
function parseRoles(body: unknown): GuildRole[] {
  if (!Array.isArray(body)) return [];
  const roles: GuildRole[] = [];
  for (const item of body) {
    const { id, name, permissions } = (item ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof permissions !== 'string' || !/^\d+$/.test(permissions)) continue;
    roles.push({ id, name, permissions: BigInt(permissions) });
  }
  return roles;
}

function parseOverwrites(body: unknown): PermissionOverwrite[] {
  const raw = (body as { permission_overwrites?: unknown } | null)?.permission_overwrites;
  if (!Array.isArray(raw)) return [];
  const overwrites: PermissionOverwrite[] = [];
  for (const item of raw) {
    const { id, type, allow, deny } = (item ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || (type !== 0 && type !== 1)) continue;
    if (typeof allow !== 'string' || typeof deny !== 'string' || !/^\d+$/.test(allow) || !/^\d+$/.test(deny)) continue;
    overwrites.push({ id, type, allow: BigInt(allow), deny: BigInt(deny) });
  }
  return overwrites;
}
```

`getMemberRoleIds` returns `roles` filtered to strings; `getGuildName` and `getUserHandle` wrap their request in `try { … } catch { return null; }` and return `null` for a non-string field.

Keep the module comment that says `GET /guilds/{id}/channels` does not return effective permissions; add one line pointing to `computeChannelPermissions` as where that check now lives.

- [ ] **Step 4: Run tests** — `pnpm vitest run tests/discord/guild-lookup.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/discord/guild-lookup.ts tests/discord/guild-lookup.test.ts
git commit -m "feat(discord): read guild roles, channel overwrites and display names for setup"
```

---

### Task 4: Replace allowed roles in the configuration transaction

**Files:**
- Modify: `lib/clip/repository.ts` (`UpsertGuildArchiveConfigInput`, `upsertGuildArchiveConfigWithClient`, `finalizeGuildArchiveConfig`)
- Test: `tests/clip/repository.test.ts`, `tests/clip/service.test.ts`

**Interfaces:**
- Produces: `finalizeGuildArchiveConfig(input: { guildId; archiveChannelId; configuredByUserId; allowedRoleIds: readonly string[] })` — same `SAVED | CONFLICT` result. `upsertGuildArchiveConfig` gains the same field.

- [ ] **Step 1: Write failing Postgres tests** in `tests/clip/repository.test.ts`, inside the existing `describe`, using `trackedGuildId()` and `fakeSnowflake()`:

```ts
test('first setup stores the configuration and its allowed roles', async () => {
  const guildId = trackedGuildId();
  const roles = [fakeSnowflake(), fakeSnowflake()];
  await finalizeGuildArchiveConfig({ guildId, archiveChannelId: fakeSnowflake(), configuredByUserId: fakeSnowflake(), allowedRoleIds: roles });
  expect((await findGuildArchiveConfig(guildId))?.allowedRoleIds.sort()).toEqual([...roles].sort());
});

test('a later save replaces the role set rather than merging it', async () => {
  const guildId = trackedGuildId();
  const channel = fakeSnowflake();
  const [kept, dropped, added] = [fakeSnowflake(), fakeSnowflake(), fakeSnowflake()];
  await finalizeGuildArchiveConfig({ guildId, archiveChannelId: channel, configuredByUserId: fakeSnowflake(), allowedRoleIds: [kept, dropped] });
  await finalizeGuildArchiveConfig({ guildId, archiveChannelId: channel, configuredByUserId: fakeSnowflake(), allowedRoleIds: [kept, added] });
  expect((await findGuildArchiveConfig(guildId))?.allowedRoleIds.sort()).toEqual([kept, added].sort());
});

test('an empty selection clears every allowed role', async () => {
  const guildId = trackedGuildId();
  const channel = fakeSnowflake();
  await finalizeGuildArchiveConfig({ guildId, archiveChannelId: channel, configuredByUserId: fakeSnowflake(), allowedRoleIds: [fakeSnowflake()] });
  await finalizeGuildArchiveConfig({ guildId, archiveChannelId: channel, configuredByUserId: fakeSnowflake(), allowedRoleIds: [] });
  expect((await findGuildArchiveConfig(guildId))?.allowedRoleIds).toEqual([]);
});

test('first setup leaves no configuration row when the role write fails', async () => {
  const guildId = trackedGuildId();
  // A duplicate id violates the (guild_id, role_id) primary key inside the
  // transaction; the route dedupes first, so only this test sends one.
  const duplicate = fakeSnowflake();
  await expect(
    finalizeGuildArchiveConfig({ guildId, archiveChannelId: fakeSnowflake(), configuredByUserId: fakeSnowflake(), allowedRoleIds: [duplicate, duplicate] }),
  ).rejects.toThrow();
  expect(await findGuildArchiveConfig(guildId)).toBeNull();
});
```

The implementation must call `createMany` **without** `skipDuplicates`, or this test cannot fail.

Add to `tests/clip/service.test.ts`:

```ts
test('a role-only edit with a live Clip is allowed and does not touch clippers', async () => {
  const fixture = await seedConfiguredGuild();
  const clipperUserId = fakeSnowflake();
  await service.clip(clipInput(fixture, clipperUserId));

  const result = await finalizeGuildArchiveConfig({
    guildId: fixture.guildId,
    archiveChannelId: fixture.archiveChannelId,
    configuredByUserId: fakeSnowflake(),
    allowedRoleIds: [],
  });

  expect(result).toEqual({ kind: 'SAVED' });
  expect(await countClipperRows(fixture)).toBe(1);
});

test('a member who lost their clipping role cannot clip again but can still unclip', async () => {
  const fixture = await seedConfiguredGuild();
  const clipperUserId = fakeSnowflake();
  await service.clip(clipInput(fixture, clipperUserId));
  await finalizeGuildArchiveConfig({
    guildId: fixture.guildId,
    archiveChannelId: fixture.archiveChannelId,
    configuredByUserId: fakeSnowflake(),
    allowedRoleIds: [],
  });

  const other = { ...clipInput(fixture, fakeSnowflake()) };
  expect(await service.clip(other)).toEqual({ kind: 'NOT_AUTHORIZED' });
  expect(
    await service.unclip({ guildId: fixture.guildId, sourceMessageId: fixture.sourceMessageId, clipperUserId }),
  ).toEqual({ kind: 'UNCLIPPED', remaining: 0 });
});
```

Import `finalizeGuildArchiveConfig` from `@/lib/clip/repository` in the service test.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/clip/repository.test.ts tests/clip/service.test.ts`
Expected: FAIL — TypeScript error / roles not stored (`allowedRoleIds` is not a field yet).

- [ ] **Step 3: Implement**

```ts
type UpsertGuildArchiveConfigInput = {
  guildId: string;
  archiveChannelId: string;
  configuredByUserId: string;
  /** Replaces the configured set. Callers dedupe and validate guild ownership first. */
  allowedRoleIds: readonly string[];
};

async function upsertGuildArchiveConfigWithClient(
  client: Pick<TxClient, 'guildConfig' | 'guildAllowedRole'>,
  input: UpsertGuildArchiveConfigInput,
): Promise<void> {
  const { guildId, archiveChannelId, configuredByUserId, allowedRoleIds } = input;
  await client.guildConfig.upsert({
    where: { guildId },
    create: { guildId, archiveChannelId, configuredByUserId },
    update: { archiveChannelId, configuredByUserId },
  });
  await client.guildAllowedRole.deleteMany({ where: { guildId } });
  if (allowedRoleIds.length > 0) {
    await client.guildAllowedRole.createMany({
      data: allowedRoleIds.map((roleId) => ({ guildId, roleId })),
    });
  }
}

export function upsertGuildArchiveConfig(input: UpsertGuildArchiveConfigInput): Promise<void> {
  return getPrismaClient().$transaction((tx) => upsertGuildArchiveConfigWithClient(tx, input));
}
```

`finalizeGuildArchiveConfig`'s locked branch already passes `tx`; its first-setup fallback keeps calling `upsertGuildArchiveConfig`, which is now transactional. Keep the "Simultaneous first setup is a separate problem" comment — it stays true until Wave 5's advisory lock.

Fix the other callers the compiler reports (`app/setup/save/route.ts` passes `allowedRoleIds: []` for now; Task 5 replaces it).

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/clip`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/clip/repository.ts app/setup/save/route.ts tests/clip
git commit -m "feat(clip): replace allowed clipping roles with the configuration write"
```

---

### Task 5: `/setup/save` — roles, destination permission check, readable refusals

**Files:**
- Modify: `app/setup/save/route.ts`
- Test: `tests/setup/save-route.test.ts`

**Interfaces:**
- Consumes: Task 2 `computeChannelPermissions`, `missingArchivePermissions`, `PERMISSION`; Task 3 lookup methods; Task 4 `finalizeGuildArchiveConfig({ …, allowedRoleIds })`.
- Produces (HTTP contract used by Task 8):
  - Request: `{ destination: 'create' | 'existing'; channelId: string | null; allowedRoleIds: string[] }` (max 250 entries, each a non-empty string).
  - `200`: `{ archiveChannelId, archiveChannelName, autoCreated, clipCount, allowedRoles: { id: string; name: string }[] }`.
  - `409`: `{ reason: 'LIVE_CLIPS' }` (both the pre-check and the finalize CONFLICT).
  - `422`: `{ reason: 'MISSING_PERMISSIONS', missingPermissions: ArchiveChannelPermission[] }` or `{ reason: 'INVALID_ROLE' }` or `{ reason: 'INVALID_CHANNEL' }`.
  - Other statuses unchanged (`400`, `401`, `403`, `404`, `502`), empty body.

- [ ] **Step 1: Write failing tests** — extend the mocked lookup in the test file:

```ts
const getGuildRoles = vi.hoisted(() => vi.fn());
const getChannelOverwrites = vi.hoisted(() => vi.fn());
const getMemberRoleIds = vi.hoisted(() => vi.fn());
const createDiscordGuildLookup = vi.hoisted(() =>
  vi.fn(() => ({ getGuildSetupChannels, getGuildRoles, getChannelOverwrites, getMemberRoleIds })),
);
```

In `beforeEach`, default to a bot that can use the channel:

```ts
const BOT_ROLE_ID = '1539212298600718777';
const MOD_ROLE_ID = '1539212298600718666';
getGuildRoles.mockResolvedValue([
  { id: GUILD_ID, name: '@everyone', permissions: 0n },
  { id: BOT_ROLE_ID, name: 'Clip', permissions: PERMISSION.VIEW_CHANNEL | PERMISSION.SEND_MESSAGES | PERMISSION.READ_MESSAGE_HISTORY },
  { id: MOD_ROLE_ID, name: 'moderator', permissions: 0n },
]);
getMemberRoleIds.mockResolvedValue([BOT_ROLE_ID]);
getChannelOverwrites.mockResolvedValue([]);
```

Update every existing request body in the file to include `allowedRoleIds: []`. Add tests:

```ts
test('saves deduplicated allowed roles and returns their names', async () => {
  stubEnv();
  // existing-channel happy path set up as in the file's current existing-channel test
  const response = await POST(postJson({ destination: 'existing', channelId: CHANNEL_ID, allowedRoleIds: [MOD_ROLE_ID, MOD_ROLE_ID] }));
  expect(response.status).toBe(200);
  expect(finalizeGuildArchiveConfig).toHaveBeenCalledWith(expect.objectContaining({ allowedRoleIds: [MOD_ROLE_ID] }));
  expect((await response.json()).allowedRoles).toEqual([{ id: MOD_ROLE_ID, name: 'moderator' }]);
});

test.each([
  ['@everyone', GUILD_ID],
  ['a role from no guild role list', '1539212298600718000'],
])('refuses %s as an allowed role without saving', async (_name, roleId) => {
  stubEnv();
  const response = await POST(postJson({ destination: 'existing', channelId: CHANNEL_ID, allowedRoleIds: [roleId] }));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ reason: 'INVALID_ROLE' });
  expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
});

test('role validation runs before the archive channel is created', async () => {
  stubEnv();
  const response = await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [GUILD_ID] }));
  expect(response.status).toBe(422);
  expect(discordRequest).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything());
});

test('refuses an existing channel the bot cannot read history in, naming the permission', async () => {
  stubEnv();
  getChannelOverwrites.mockResolvedValue([
    { id: BOT_ROLE_ID, type: 0, allow: 0n, deny: PERMISSION.READ_MESSAGE_HISTORY },
  ]);
  const response = await POST(postJson({ destination: 'existing', channelId: CHANNEL_ID, allowedRoleIds: [] }));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ reason: 'MISSING_PERMISSIONS', missingPermissions: ['READ_MESSAGE_HISTORY'] });
  expect(finalizeGuildArchiveConfig).not.toHaveBeenCalled();
  expect(discordRequest).not.toHaveBeenCalledWith('PATCH', expect.anything(), expect.anything());
  expect(discordRequest).not.toHaveBeenCalledWith('PUT', expect.anything(), expect.anything());
});

test('a destination change blocked by live Clips explains itself', async () => {
  stubEnv();
  findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: 'old-channel', allowedRoleIds: [] });
  hasLiveClips.mockResolvedValue(true);
  const response = await POST(postJson({ destination: 'existing', channelId: CHANNEL_ID, allowedRoleIds: [] }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ reason: 'LIVE_CLIPS' });
});

test('a role-only edit with live Clips is saved', async () => {
  stubEnv();
  findGuildArchiveConfig.mockResolvedValue({ archiveChannelId: CHANNEL_ID, allowedRoleIds: [] });
  hasLiveClips.mockResolvedValue(true);
  const response = await POST(postJson({ destination: 'existing', channelId: CHANNEL_ID, allowedRoleIds: [MOD_ROLE_ID] }));
  expect(response.status).toBe(200);
});

test('the auto-created channel grants the bot history reads', async () => {
  stubEnv();
  await POST(postJson({ destination: 'create', channelId: null, allowedRoleIds: [] }));
  const [, , body] = discordRequest.mock.calls.find(([method]) => method === 'POST')!;
  const botOverwrite = body.permission_overwrites.find((o: { id: string }) => o.id === BOT_USER_ID);
  expect(BigInt(botOverwrite.allow)).toBe(PERMISSION.VIEW_CHANNEL | PERMISSION.SEND_MESSAGES | PERMISSION.READ_MESSAGE_HISTORY);
});
```

Use the file's existing channel-id constant for `CHANNEL_ID` (whatever the current existing-channel test uses); do not invent a second one. Keep the existing `@everyone` deny mutation test unchanged — it must still fail if the deny is removed.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/setup/save-route.test.ts`
Expected: FAIL — 200 instead of 422, missing `allowedRoles`, empty 409 body.

- [ ] **Step 3: Implement**

Schema:

```ts
const SaveRequestSchema = z
  .object({
    destination: z.enum(['create', 'existing']),
    channelId: z.string().min(1).nullable(),
    allowedRoleIds: z.array(z.string().min(1)).max(250),
  })
  .refine((data) => data.destination !== 'existing' || data.channelId !== null, {
    message: 'channelId is required when destination is "existing"',
  });
```

Flow changes, in order, inside the existing `try`:

1. Fetch `roles = await lookup.getGuildRoles(guildId)` once (create the lookup before the destination branch).
2. `const allowedRoleIds = [...new Set(parsed.data.allowedRoleIds)]`; if any id equals `guildId` or is not in `roles` → `Response.json({ reason: 'INVALID_ROLE' }, { status: 422 })`.
3. Existing destination: after the eligible-channel check (now returning `{ reason: 'INVALID_CHANNEL' }` with 422), resolve the bot user id (`getDiscordBotUserId`, already used by the create branch — hoist it above the branch), then:
   ```ts
   const [memberRoleIds, overwrites] = await Promise.all([
     lookup.getMemberRoleIds(guildId, botUserId),
     lookup.getChannelOverwrites(eligible.id),
   ]);
   const missing = missingArchivePermissions(
     computeChannelPermissions({
       guildId,
       memberId: botUserId,
       memberRoleIds,
       rolePermissions: new Map(roles.map((role) => [role.id, role.permissions])),
       overwrites,
     }),
   );
   if (missing.length > 0) {
     return Response.json({ reason: 'MISSING_PERMISSIONS', missingPermissions: missing }, { status: 422 });
   }
   ```
4. Create destination: bot overwrite `allow` becomes `PERMISSION.VIEW_CHANNEL | PERMISSION.SEND_MESSAGES | PERMISSION.READ_MESSAGE_HISTORY`. Update the comment above it: history reads are what the archive page's content reads need.
5. Both 409 responses become `Response.json({ reason: 'LIVE_CLIPS' }, { status: 409 })`.
6. Pass `allowedRoleIds` to `finalizeGuildArchiveConfig`; add `allowedRoles: allowedRoleIds.map((id) => ({ id, name: roles.find((r) => r.id === id)!.name }))` to the 200 body.
7. Map `GuildLookupFailedError` from the new reads to 502 (add it to the existing catch alongside `DiscordApiError`).

Replace the doc-comment sentence "Allowed-role configuration is cut from P0 per the task brief; only the archive channel and who configured it are persisted here." with: "Allowed roles are validated against a fresh role list and replace the configured set in the same transaction as the destination."

- [ ] **Step 4: Run tests** — `pnpm vitest run tests/setup/save-route.test.ts` → PASS. Then mutation checks, each restored afterwards: (a) make the role step apply only `roleAllow` (drop `& ~roleDeny`) — "a role deny with no counter-allow removes the permission" must fail; (b) move the `@everyone` step after the role step — "a role allow restores VIEW_CHANNEL denied to @everyone" must fail. Read the failure reason, not the count.

- [ ] **Step 5: Commit**

```bash
git add app/setup/save/route.ts tests/setup/save-route.test.ts
git commit -m "feat(setup): save allowed roles and refuse archive channels the bot cannot use"
```

---

### Task 6: `/setup/data` — current configuration, roles and identity

**Files:**
- Modify: `app/setup/data/route.ts`
- Create: `tests/setup/data-route.test.ts`

**Interfaces:**
- Produces (HTTP contract used by Task 8):
  ```ts
  type SetupRole = { id: string; name: string; selectable: boolean }; // selectable === false only for @everyone
  type SetupData = {
    guildId: string;
    guildName: string | null;   // ScreenB falls back to guildId for the identity bar
    adminHandle: string | null;
    channels: SetupChannel[];
    roles: SetupRole[];
    config: { archiveChannelId: string; allowedRoleIds: string[] } | null;
  };
  ```
  Export `SetupRole` from `lib/discord/guild-lookup.ts`, next to `SetupChannel`, so client components import a type without importing a route.

- [ ] **Step 1: Write failing tests** — mock `authenticateAdminSession`, the lookup (`getGuildSetupChannels`, `getGuildRoles`, `getGuildName`, `getUserHandle`) and `findGuildArchiveConfig`, mirroring `save-route.test.ts`'s mocking style:
  - returns `config: null` for an unconfigured guild and the current `{ archiveChannelId, allowedRoleIds }` for a configured one;
  - lists `@everyone` with `selectable: false` and other roles `selectable: true`, and never includes a `permissions` field;
  - returns `guildName: null` / `adminHandle: null` when those lookups resolve null (request still 200);
  - still 401 without a session, 404 on `GuildUnavailableError`, 502 on other lookup errors;
  - sets `Cache-Control: private, no-store`.

- [ ] **Step 2: Run to verify they fail** — `pnpm vitest run tests/setup/data-route.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
const [channels, roles, guildName, adminHandle, config] = await Promise.all([
  lookup.getGuildSetupChannels(identity.guildId),
  lookup.getGuildRoles(identity.guildId),
  lookup.getGuildName(identity.guildId),
  lookup.getUserHandle(identity.userId),
  findGuildArchiveConfig(identity.guildId),
]);
return Response.json(
  {
    guildId: identity.guildId,
    guildName,
    adminHandle,
    channels,
    roles: roles.map(({ id, name }) => ({ id, name, selectable: id !== identity.guildId })),
    config,
  },
  { headers: { 'Cache-Control': 'private, no-store' } },
);
```

`findGuildArchiveConfig` already returns exactly `{ archiveChannelId, allowedRoleIds }`. Update the doc comment's description of the payload.

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Commit**

```bash
git add app/setup/data/route.ts lib/discord/guild-lookup.ts tests/setup/data-route.test.ts
git commit -m "feat(setup): return current configuration, roles and identity to the setup page"
```

---

### Task 7: F.4 — Role multi-select

**Files:**
- Create: `components/ui/RoleMultiSelect.tsx`, `components/ui/RoleMultiSelect.module.css`
- Modify: `tokens.css` (three named tokens)
- Test: `tests/ui/role-multi-select.test.tsx`

**Interfaces:**
- Consumes: `SetupRole` (Task 6).
- Produces:
  ```ts
  export interface RoleMultiSelectProps {
    legend: string;                 // WEB_COPY.setup.rolesLegend
    placeholder: string;            // WEB_COPY.setup.rolesPlaceholder
    roles: SetupRole[];
    value: string[];                // selected role ids, may include stale ids not in `roles`
    onChange: (next: string[]) => void;
  }
  ```

**Design decision (from the handoff's "Real `<fieldset>`/checkbox semantics" option):** a `<fieldset>` holding (a) selected chips as `<button type="button" aria-pressed="true">` whose accessible name is the role name — pressing removes it, so no new Korean `aria-label` is needed; (b) a disclosure `<button aria-expanded>` showing the placeholder; (c) when open, a list of `<label><input type="checkbox"></label>` rows. `@everyone` is a disabled checkbox. Stale selected ids (not in `roles`) render as chips labelled by the raw id in mono.

- [ ] **Step 1: Write failing tests** (`// @vitest-environment jsdom`, Testing Library + `user-event`, same setup as `tests/ui/primitives.test.tsx`):

```tsx
const ROLES = [
  { id: 'g', name: '@everyone', selectable: false },
  { id: 'm', name: 'moderator', selectable: true },
  { id: 'a', name: '기록관리', selectable: true },
];

function renderSelect(value: string[] = []) {
  const onChange = vi.fn();
  render(<RoleMultiSelect legend="클립 허용 역할" placeholder="역할 추가…" roles={ROLES} value={value} onChange={onChange} />);
  return { onChange, user: userEvent.setup() };
}

test('is a named group', () => {
  renderSelect();
  expect(screen.getByRole('group', { name: '클립 허용 역할' })).toBeInTheDocument();
});

test('opens with Enter, moves with arrows, toggles with Space, closes with Escape', async () => {
  const { onChange, user } = renderSelect();
  screen.getByRole('button', { name: '역할 추가…' }).focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('checkbox', { name: '@everyone' })).toBeDisabled();
  await user.keyboard('{ArrowDown}'); // first enabled option: moderator
  expect(screen.getByRole('checkbox', { name: 'moderator' })).toHaveFocus();
  await user.keyboard(' ');
  expect(onChange).toHaveBeenLastCalledWith(['m']);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('checkbox', { name: 'moderator' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '역할 추가…' })).toHaveFocus();
});

test('Enter on an option toggles it', async () => {
  const { onChange, user } = renderSelect(['m']);
  await user.click(screen.getByRole('button', { name: '역할 추가…' }));
  screen.getByRole('checkbox', { name: 'moderator' }).focus();
  await user.keyboard('{Enter}');
  expect(onChange).toHaveBeenLastCalledWith([]);
});

test('Backspace on the add button removes the last chip', async () => {
  const { onChange, user } = renderSelect(['m', 'a']);
  screen.getByRole('button', { name: '역할 추가…' }).focus();
  await user.keyboard('{Backspace}');
  expect(onChange).toHaveBeenLastCalledWith(['m']);
});

test('a chip is a pressed toggle that removes its role', async () => {
  const { onChange, user } = renderSelect(['m']);
  const chip = screen.getByRole('button', { name: 'moderator', pressed: true });
  await user.click(chip);
  expect(onChange).toHaveBeenLastCalledWith([]);
});

test('a stale selected id stays visible by id', () => {
  renderSelect(['999']);
  expect(screen.getByRole('button', { name: '999', pressed: true })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail** — `pnpm vitest run tests/ui/role-multi-select.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Implement**

```tsx
'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import type { SetupRole } from '@/lib/discord/guild-lookup';
import { Fieldset } from './Fieldset';
import styles from './RoleMultiSelect.module.css';

export interface RoleMultiSelectProps {
  legend: string;
  placeholder: string;
  roles: SetupRole[];
  value: string[];
  onChange: (next: string[]) => void;
}

/**
 * The handoff's role multi-select ("Role multi-select") built on its
 * permitted fieldset/checkbox semantics: chips are pressed toggle buttons
 * named by the role, the add control is a disclosure, options are real
 * checkboxes. Arrow keys move between enabled options, Enter/Space toggle,
 * Backspace on the add control removes the last chip, Escape closes.
 */
export function RoleMultiSelect({ legend, placeholder, roles, value, onChange }: RoleMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const nameOf = (id: string) => roles.find((role) => role.id === id)?.name ?? id;

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  function enabledBoxes(): HTMLInputElement[] {
    return Array.from(listRef.current?.querySelectorAll<HTMLInputElement>('input:not(:disabled)') ?? []);
  }

  function onToggleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Backspace' && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    } else if (event.key === 'ArrowDown' && open) {
      event.preventDefault();
      enabledBoxes()[0]?.focus();
    }
  }

  function onListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const boxes = enabledBoxes();
    const index = boxes.indexOf(document.activeElement as HTMLInputElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      boxes[(index + step + boxes.length) % boxes.length]?.focus();
    } else if (event.key === 'Enter' && index >= 0) {
      event.preventDefault();
      toggle(boxes[index].value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      toggleRef.current?.focus();
    }
  }

  return (
    <Fieldset legend={legend}>
      <div className={styles.field}>
        {value.map((id) => (
          <button key={id} type="button" aria-pressed="true" className={styles.chip} onClick={() => toggle(id)}>
            {nameOf(id)}
            <span className={styles.remove} aria-hidden="true">×</span>
          </button>
        ))}
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          className={styles.add}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={onToggleKeyDown}
          onKeyUp={(event) => {
            // Enter opens via click; move focus into the list once it renders.
            if (event.key === 'ArrowDown' && open) enabledBoxes()[0]?.focus();
          }}
        >
          {placeholder}
        </button>
      </div>
      {open && (
        <ul ref={listRef} className={styles.options} onKeyDown={onListKeyDown}>
          {roles.map((role) => (
            <li key={role.id} className={styles.option}>
              <label className={role.selectable ? styles.optionLabel : styles.optionDisabled}>
                <input
                  type="checkbox"
                  value={role.id}
                  checked={value.includes(role.id)}
                  disabled={!role.selectable}
                  onChange={() => toggle(role.id)}
                />
                <span className={styles.mono}>{role.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Fieldset>
  );
}
```

If the "moves with arrows" test shows focus does not reach the first option after `Enter` then `ArrowDown` (the list renders after the click), keep the `onKeyUp` fallback; otherwise delete it — do not keep both paths without a failing test for each.

Tokens first. `DESIGN_RATIONALE_APPEND.md` §10.7 rules that handoff component values off the 4px scale become **named tokens in `tokens.css`**, never literals in component CSS. Add, next to `--sp-chip-x`, with the same comment style:

```css
  --sp-role-chip-y: 5px;  /* role chip vertical padding (horizontal reuses --sp-chip-x). docs/06_DESIGN_HANDOFF.md "Role multi-select" */
  --sp-option-x: 10px;    /* role option row horizontal padding (vertical reuses --sp-2). docs/06_DESIGN_HANDOFF.md "Role multi-select" */
  --chip-surface: #1b1e22; /* role chip background. docs/06_DESIGN_HANDOFF.md "Role multi-select" */
```

`--chip-surface` also needs a light-theme value in each light block; use the light `--btn-disabled-bg` value (the dark values match) and say so in its comment. The highlighted row uses the existing `--hover-surface` (`#17191d` vs the handoff's `#16191d` — record that one-step difference in the Task 1 rationale entry rather than adding a near-duplicate token). Chip text uses `--fs-small` (11.5px). Disabled `@everyone` uses `--faint` (disabled control: allowed by rule 3).

CSS (`RoleMultiSelect.module.css`), reusing `components/ui/Fieldset` for the fieldset/legend — so the component renders `<Fieldset legend={legend}>…</Fieldset>` and drops its own `fieldset`/`legend` classes:

```css
.field {
  display: flex; flex-wrap: wrap; gap: var(--sp-1);
  padding: var(--sp-control-y) var(--sp-control-x);
  background: var(--sunken); border: var(--hairline) solid var(--border-strong); border-radius: var(--radius);
}
.chip {
  display: inline-flex; gap: var(--sp-1); align-items: center;
  padding: var(--sp-role-chip-y) var(--sp-chip-x);
  background: var(--chip-surface); border: var(--hairline) solid var(--border-strong); border-radius: var(--radius-chip);
  font: 400 var(--fs-small) / 1 var(--font-mono); color: var(--text);
}
.remove { color: var(--muted); }
.add { background: none; border: 0; padding: 0; font: 400 var(--fs-label) / 1 var(--font-ui); color: var(--muted); cursor: pointer; }
.chip:focus-visible, .add:focus-visible, .option input:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-offset); }
.options { list-style: none; margin: 0; padding: 0; border: var(--hairline) solid var(--border-strong); border-radius: var(--radius); }
.option + .option { border-top: var(--hairline) solid var(--divider); }
.optionLabel, .optionDisabled { display: flex; gap: var(--sp-2); align-items: center; padding: var(--sp-2) var(--sp-option-x); }
.optionLabel:hover, .optionLabel:focus-within { background: var(--hover-surface); }
.optionDisabled { color: var(--faint); cursor: not-allowed; }
.mono { font-family: var(--font-mono); }
```

Before committing, check how `components/ui/Button.module.css` writes `outline` for focus and match it exactly (the snippet above assumes `--focus-ring` is a full outline shorthand; if it is a colour, use `outline: 2px solid var(--focus-ring)` the way Button does).

- [ ] **Step 4: Run tests** — `pnpm vitest run tests/ui` → PASS.

- [ ] **Step 5: Commit**

```bash
git add tokens.css components/ui/RoleMultiSelect.tsx components/ui/RoleMultiSelect.module.css tests/ui/role-multi-select.test.tsx
git commit -m "feat(ui): add the keyboard-operable role multi-select"
```

---

### Task 8: Screens B and C — roles, prefill and refusal callouts

**Gate:** Task 1 committed (needs the two authored strings).

**Files:**
- Modify: `app/setup/[token]/SetupFlow.tsx`, `app/setup/[token]/ScreenB.tsx`, `app/setup/[token]/ScreenB.module.css`, `app/setup/[token]/ScreenC.tsx`
- Test: `tests/ui/setup-form.test.tsx`

**Interfaces:**
- Consumes: Task 5 save contract, Task 6 data contract, Task 7 `RoleMultiSelect`.
- Produces:
  ```ts
  export type SetupSubmission = { destination: Destination; channelId: string | null; allowedRoleIds: string[] };
  export type SaveOutcome =
    | { kind: 'saved' }
    | { kind: 'missing-permissions'; missingPermissions: string[] }
    | { kind: 'live-clips' }
    | { kind: 'failed' };
  // ScreenBProps.onSubmit: (submission: SetupSubmission) => Promise<SaveOutcome>
  // ScreenBProps gains: roles: SetupRole[]; initial: { archiveChannelId: string; allowedRoleIds: string[] } | null
  // ScreenCProps gains: allowedRoles: { id: string; name: string }[]
  ```

- [ ] **Step 1: Write failing tests** in `tests/ui/setup-form.test.tsx` (extend the file's existing ScreenB/SetupFlow helpers; update existing `onSubmit` mocks to resolve `{ kind: 'saved' }` / `{ kind: 'failed' }` instead of booleans):

```tsx
test('a configured guild opens with its current channel and roles, and a roles-only save posts existing', async () => {
  const onSubmit = vi.fn().mockResolvedValue({ kind: 'saved' });
  render(
    <ScreenB
      channels={[{ id: 'c1', name: 'clip-archive', type: 0 }]}
      roles={[{ id: 'g', name: '@everyone', selectable: false }, { id: 'm', name: 'moderator', selectable: true }]}
      initial={{ archiveChannelId: 'c1', allowedRoleIds: [] }}
      onSubmit={onSubmit}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '역할 추가…' }));
  await user.click(screen.getByRole('checkbox', { name: 'moderator' }));
  await user.click(screen.getByRole('button', { name: '설정 저장' }));
  expect(onSubmit).toHaveBeenCalledWith({ destination: 'existing', channelId: 'c1', allowedRoleIds: ['m'] });
});

test('missing permissions are named as machine values under the refusal copy', async () => {
  const onSubmit = vi.fn().mockResolvedValue({ kind: 'missing-permissions', missingPermissions: ['READ_MESSAGE_HISTORY'] });
  renderScreenB({ onSubmit, initial: { archiveChannelId: 'c1', allowedRoleIds: [] } });
  await userEvent.setup().click(screen.getByRole('button', { name: '설정 저장' }));
  expect(screen.getByText(WEB_COPY_AUTHORED.destinationMissingPermissions)).toBeInTheDocument();
  expect(screen.getByText('READ_MESSAGE_HISTORY')).toBeInTheDocument();
});

test('a blocked destination change shows its own explanation, not the generic failure', async () => {
  const onSubmit = vi.fn().mockResolvedValue({ kind: 'live-clips' });
  renderScreenB({ onSubmit });
  await userEvent.setup().click(screen.getByRole('button', { name: '설정 저장' }));
  expect(screen.getByText(WEB_COPY_AUTHORED.destinationChangeBlocked)).toBeInTheDocument();
});

test('Screen C lists the allowed roles', () => {
  render(<ScreenC guildId="g" archiveChannelId="c1" archiveChannelName="clip-archive" autoCreated={false} clipCount={0}
    allowedRoles={[{ id: 'm', name: 'moderator' }]} />);
  expect(screen.getByText('허용 역할')).toBeInTheDocument();
  expect(screen.getByText('@moderator')).toBeInTheDocument();
});

test('Screen C omits the role row when only admins can clip', () => {
  render(<ScreenC guildId="g" archiveChannelId="c1" archiveChannelName="clip-archive" autoCreated={false} clipCount={0}
    allowedRoles={[]} />);
  expect(screen.queryByText('허용 역할')).not.toBeInTheDocument();
});

it('SetupFlow maps a 422 MISSING_PERMISSIONS body to the refusal', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/setup/data')) {
      return Response.json(setupDataBody({ config: { archiveChannelId: 'c1', allowedRoleIds: [] } }));
    }
    if (url.endsWith('/setup/save')) {
      return Response.json({ reason: 'MISSING_PERMISSIONS', missingPermissions: ['SEND_MESSAGES'] }, { status: 422 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<SetupFlow token="live-token" />);
  await userEvent.setup().click(await screen.findByRole('button', { name: '설정 저장' }));

  expect(await screen.findByText('SEND_MESSAGES')).toBeInTheDocument();
  expect(screen.getByText(WEB_COPY_AUTHORED.destinationMissingPermissions)).toBeInTheDocument();
});
```

Add two local helpers at the top of the file:

```tsx
const ROLES = [
  { id: 'g', name: '@everyone', selectable: false },
  { id: 'm', name: 'moderator', selectable: true },
];

function setupDataBody(overrides: Record<string, unknown> = {}) {
  return { guildId: 'g1', guildName: 'Test guild', adminHandle: 'admin', channels: CHANNELS, roles: ROLES, config: null, ...overrides };
}

function renderScreenB(props: Partial<ScreenBProps> = {}) {
  return render(
    <ScreenB channels={[{ id: 'c1', name: 'clip-archive', type: 0 }]} roles={ROLES} initial={null}
      onSubmit={vi.fn().mockResolvedValue({ kind: 'saved' })} {...props} />,
  );
}
```

**Existing SetupFlow tests return `{ guildId: 'g1', channels: CHANNELS }` from `/setup/data`.** The stricter `parseSetupData` rejects that, so replace every such body with `setupDataBody()` (same file, same commit). Existing ScreenB tests that render without `roles` gain `roles={ROLES} initial={null}`; their `onSubmit` mocks change from booleans to `SaveOutcome`s.

- [ ] **Step 2: Run to verify they fail** — `pnpm vitest run tests/ui/setup-form.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

ScreenB:
- `useState<Destination>(initial ? 'existing' : 'create')`, `useState(initial?.archiveChannelId ?? '')`, `useState<string[]>(initial?.allowedRoleIds ?? [])`.
- Between the destination radio group and the consequences, render:
  ```tsx
  <div className={styles.roles}>
    <RoleMultiSelect legend={WEB_COPY.setup.rolesLegend} placeholder={WEB_COPY.setup.rolesPlaceholder}
      roles={roles} value={allowedRoleIds} onChange={setAllowedRoleIds} />
    <Callout variant="note">{WEB_COPY.setup.rolesNote}</Callout>
  </div>
  ```
- Replace `saveError: boolean` with `saveOutcome: SaveOutcome | null`. In the always-mounted `aria-live` region render:
  - `failed` → the existing `saveFailed` callout (unchanged);
  - `missing-permissions` → `<Callout variant="error">{WEB_COPY_AUTHORED.destinationMissingPermissions}</Callout>` followed by one `<MonoChip>` per permission constant;
  - `live-clips` → `<Callout variant="error">{WEB_COPY_AUTHORED.destinationChangeBlocked}</Callout>`.
- Replace the component doc comment's "Allowed-role configuration is cut from P0…" sentence with: "A configured guild opens prefilled with its current channel (as `existing`) and roles, so a roles-only edit never creates a second channel."
- Pass `guildName ?? guildId` and `adminHandle` from SetupFlow so the identity bar always renders (the id is the design's display fallback).

SetupFlow:
- `parseSetupData` validates the Task 6 shape (`roles` array of `{id,name,selectable}`, `config` null or `{archiveChannelId: string, allowedRoleIds: string[]}`, `guildName` string|null, `adminHandle` string|null).
- `parseSaveResult` also requires `allowedRoles: {id,name}[]`.
- `handleSubmit` returns `SaveOutcome`: `ok` → parse → `saved`; `422` with `reason === 'MISSING_PERMISSIONS'` and a string-array `missingPermissions` → `missing-permissions`; `409` → `live-clips`; everything else (including unparseable bodies and thrown fetches) → `failed`.
- After a successful save, carry `config: { archiveChannelId, allowedRoleIds }` into state so `onReviewSettings` returns to a prefilled Screen B.

ScreenC:
- Add the row between `아카이브 채널` and `관리자`:
  ```tsx
  <div className={styles.row}>
    <span className={styles.key}>{copy.allowedRolesKey}</span>
    <span className={`${styles.value} ${styles.mono}`}>
      {allowedRoles.map((role) => `@${role.name}`).join(' · ')}
    </span>
  </div>
  ```
  With no roles, render the row empty? No — omit the row when `allowedRoles` is empty; the `관리자` row already states who can clip, and the handoff has no empty-roles string.
- Replace the doc comment's "The 허용 역할 row from the mockup is omitted…" sentence with "The 허용 역할 row lists the configured roles and is omitted when none are configured." Keep the `아카이브 열기` paragraph as is (Wave 5 changes it).

- [ ] **Step 4: Run all tests and lint**

Run: `pnpm lint && pnpm test`
Expected: PASS with no new warnings.

- [ ] **Step 5: Commit**

```bash
git add app/setup components tests/ui
git commit -m "feat(setup): configure clipping roles and explain refused destinations"
```

---

### Task 9: Build, deploy, live check, docs

**Files:**
- Modify: `README.md` (as-shipped table: 4.3, F.4 move to shipped; destination check), `docs/journal/journal-2026-10.md` (create)

- [ ] **Step 1: Full gate**

Run: `pnpm lint && pnpm test && pnpm build`
Expected: all green; record the test count.

- [ ] **Step 2: Open the PR**

```bash
git push
gh pr create --base main --head wave/4-p0-restoration --title "Wave 4: clipping roles and setup completion" --body-file <file using .github PR template>
```

Body lists issues #11 and #29 as closed by the PR, links the design and this plan, and states which acceptance checks are automated vs pending live.

- [ ] **Step 3: Independent review** — dispatch one reviewer (`pr-review-toolkit:code-reviewer`) on the branch diff against `main`, with this plan and the design as context. Fix confirmed findings in follow-up commits.

- [ ] **Step 4: After merge, confirm the deployed image** — `kubectl -n clip get deploy clip -o jsonpath='{..image}'` shows the merge commit's `sha-` tag for both the app container and the migration initContainer; `curl https://clipendpoint.cc/api/health` → `200`.

- [ ] **Step 5: Live checks with Ori in the test guild** (record each observation in the journal):
  1. `/setup` → link → configured guild opens prefilled; add a role; save → Screen C lists it.
  2. Account without `MANAGE_GUILD` but with that role: `Apps → Clip` succeeds.
  3. Remove the role in setup; same account: `Clip` on another message is refused; `Unclip` on the first still works.
  4. Create a text channel where the bot's role is denied `READ_MESSAGE_HISTORY`; choose it as existing destination → refusal names `READ_MESSAGE_HISTORY`; the channel's overwrites are unchanged afterwards.

- [ ] **Step 6: Docs and journal** — update README's as-shipped table from `find app lib components tests`, not from issues; write the journal entry (what shipped, live-check results, anything deferred). Commit:

```bash
git add README.md docs/journal/journal-2026-10.md
git commit -m "docs: record Wave 4 as shipped"
```
