# Clip P0 Product / Behavioral Design Specification

**Status:** Approved design handoff  
**Date:** 2026-08-18 KST  
**Working name:** Clip  
**Deadline context:** Sweetbook project submission due 2026-08-20 23:59 KST

---

## 1. Product statement

### One sentence

Clip allows authorized Discord community members to preserve meaningful messages into a server-owned, cross-channel archive with approximately the effort of pinning, while leaving archived content inside Discord rather than copying it into a proprietary storage service.

### Core user problem

Discord pins are useful but are a bounded, channel-local shortlist and are normally managed through moderation permissions. The product was motivated by a real case where historical pins had to be removed to make room for new ones. The current official Discord limit is 250 pins per channel/DM; the product should not depend on an outdated “100 pins” claim.

The deeper problem is therefore not only pin count. It is that communities lack a low-friction primitive for saying:

> “This message is worth preserving for us.”

### Competitive semantic position

| Existing primitive | Semantic meaning |
|---|---|
| Discord Pin | Moderator/admin: important for this channel |
| Personal bookmark/read-later | Individual: I want to retrieve this later |
| Starboard/reaction threshold | Community popularity/endorsement |
| Pin archiver | Overflow/retention of already pinned messages |
| Bulk Discord logger/export | Capture everything, filter later |
| **Clip** | **Authorized human: deliberately preserve this message for shared community memory** |

Clip is not positioned as an unlimited-pin utility or Starboard replacement.

---

## 2. Design principles

1. **Human selects significance.** P0 never passively ingests a server or asks AI to decide what is important.
2. **Same place, low effort.** Capture occurs in Discord through a message context action.
3. **Server-owned content.** Archived message payload remains in the guild's Discord archive channel.
4. **Minimal proprietary data.** Clip stores control metadata, not copies of message bodies/attachments.
5. **Low-noise UX.** Normal clipping should not add public bot chatter.
6. **Consent has an enforceable escape hatch.** An original author can remove an archived copy of their own message.
7. **Moderated authority.** Clipping is role-gated; guild admins are implicitly authorized.
8. **Correctness over clever statelessness.** PostgreSQL is durable control-plane state; Discord is content plane.
9. **P0 proves the capture/archive primitive.** Search, AI, publication, and physical output are downstream possibilities, not core requirements.
10. **Deployment is part of the MVP.** The real Discord interaction path must be tested before final polish.

---

## 3. P0 user roles

### Guild administrator

A Discord member with `MANAGE_GUILD` (or equivalent administrator authority) is implicitly allowed to clip and may:

- run `/setup`;
- configure the archive destination;
- configure additional roles that may clip;
- inspect the read-only web archive/configuration;
- remove any archived clip;
- delete Clip control-plane data for the guild.

### Authorized clipper

A member who either:

- has guild administrator authority; or
- has at least one configured Clip role.

May:

- Clip a visible message;
- Unclip their own preservation signal.

### Original message author

May remove the canonical archived copy of their own message, regardless of how many users clipped it. This is distinct from `Unclip`.

### Ordinary guild member

Has no Clip mutation capability unless an administrator grants a Clip role. P0 does not add a member-facing web login/archive.

---

## 4. P0 interaction surfaces

### Discord

Owns all message-level mutations:

- `/setup`
- `Apps → Clip`
- `Apps → Unclip`
- `Apps → Remove from Clip Archive`
- author DM notification + remove button
- persistent archive-status marker reaction on source message

### Web

Owns:

- setup/configuration through short-lived admin session;
- archive destination choice;
- allowed role selection;
- read-only archive browsing;
- current configuration display;
- control-plane guild data deletion.

The web archive is admin-only in P0. Full Discord OAuth/member browsing is P1.

---

## 5. Setup flow

### 5.1 Bootstrap

1. Administrator installs Clip.
2. Administrator runs `/setup` in Discord.
3. Backend verifies administrator authority.
4. Backend issues a one-time setup token valid for approximately 15 minutes.
5. Discord returns an ephemeral `Configure Clip` link.
6. Browser exchanges the one-time token for a short-lived `Secure`, `HttpOnly`, `SameSite` admin session cookie.
7. Setup token becomes invalid after exchange.
8. Web session lasts approximately 30 minutes / a short fixed session window; no refresh token.
9. After expiration, administrator runs `/setup` again.

No permanent password/account system exists in P0.

### 5.2 Archive destination

Administrator chooses one:

#### Create private archive

- Clip creates a private `#clips`-style channel.
- Requires `MANAGE_CHANNELS` for the bootstrap operation.
- `MANAGE_CHANNELS` is not a steady-state product requirement after setup and may be revoked by the administrator.

#### Use existing channel

- Clip validates that required runtime permissions are present.
- Clip does **not** rewrite channel permission overwrites automatically.
- Missing permissions are reported clearly to the admin.

### 5.3 Default visibility

A newly created archive is private/admin-visible by default.

P0 does not attempt to mirror every source channel's permission graph. The administrator is responsible for any later widening of archive visibility.

P1 should investigate permission-aware clipping: reject or route a clip when the archive's audience is broader than the source audience.

### 5.4 Allowed clipping roles

Admin selects zero or more additional Discord roles.

Authorization rule:

```text
canClip = hasManageGuildPermission OR hasAnyConfiguredClipRole
```

An empty role list is valid: admins can still use the product.

---

## 6. Clip semantics

### 6.1 One selected message only

P0 clips exactly the message explicitly targeted by the context action.

If the message replies to another message:

- preserve provenance/reference to the parent where available;
- do not silently archive the parent message.

P1 may add explicit `include parent`, multi-message, or thread clipping.

### 6.2 Immutable snapshot

Chosen model: **immutable snapshot with author/admin removal rights**.

- Editing the original message does not modify the archived snapshot.
- Deleting the original message does not automatically delete the archived snapshot.
- Original author may remove the archived copy.
- Archive admin may remove any archived copy.

This preserves historical meaning while giving non-content-creator users a protection against abuse or accidental sensitive disclosure.

### 6.3 Discord archive representation

Use Discord's message-forward/snapshot capability (`message_reference` with `type: 1`) for the message payload.

Because forwarded snapshots do not preserve every desired piece of provenance — the snapshot object explicitly omits `author` — the archive must also carry human-readable metadata:

- original author;
- source channel;
- original timestamp;
- original message link where available;
- clip timestamp;
- optionally the first clipper if product copy chooses to expose it (not required in P0).

#### Two-message representation (amended 2026-08-18)

Discord **rejects a forward that carries any additional content**: sending `content`, `embeds` or `components` alongside a `FORWARD` message reference returns error `160011` (`Forward messages cannot have additional content`). The original single-post design is therefore not implementable.

An archive entry is consequently **two messages posted in order** into the archive channel:

1. a **provenance message** carrying the metadata listed above;
2. the **forward** carrying the snapshot payload.

Both identifiers are stored on the canonical Clip. Consequences:

- removal must delete both messages;
- posting the provenance message and failing to post the forward is a new recoverable partial-failure case (see §17);
- the web archive fetches only the forward for body content and renders provenance from PostgreSQL, since the control plane already holds author, channel and both timestamps.

#### Forwardable message types

Discord only forwards `DEFAULT`, `REPLY`, `CHAT_INPUT_COMMAND` and `CONTEXT_MENU_COMMAND` messages. Polls, calls, activities and system messages cannot be forwarded and must be rejected as invalid targets before any state is written.

P0 does not synchronize reaction counts or subsequent edits.

---

## 7. Deduplication and social preservation signal

### 7.1 Canonical clip

Exactly one canonical Clip exists per source message in a guild.

Unique identity:

```text
(guild_id, source_message_id)
```

### 7.2 Multiple clippers

Multiple authorized users may independently signal that the same source message should be preserved.

One Clipper row per:

```text
(guild_id, source_message_id, clipper_user_id)
```

Duplicate clicks by the same user are idempotent.

### 7.3 Unclip

`Unclip` retracts only the invoking user's preservation signal.

- If other clippers remain, canonical archive stays.
- If no clippers remain, ordinary deletion begins.

Example:

```text
Alex clips -> 1 signal, archive created
Mina clips -> 2 signals, same archive
Alex unclips -> 1 signal, archive remains
Mina unclips -> 0 signals, archive removed
```

### 7.4 Author/admin removal

`Remove from Clip Archive` is not `Unclip`.

- Author/admin removal overrides all Clipper signals.
- Archive is deleted.
- A removal tombstone is retained in PostgreSQL.
- Subsequent clip attempts are rejected while tombstone is retained.

This prevents a harassment loop where an author repeatedly removes a clip and other users immediately recreate it.

---

## 8. Control-plane data model

### 8.1 Ownership boundary

**Discord is authoritative for:**

- archived message body;
- embeds;
- attachments;
- media payload;
- snapshot rendering;
- Discord user/channel display details that can be fetched at render time.

**PostgreSQL is authoritative for:**

- guild configuration;
- allowed clipping roles;
- Clip identity;
- Clipper preservation decisions;
- Clip state-machine status;
- author/admin removal tombstones;
- notification/idempotency state;
- admin setup/session state.

### 8.2 Explicit non-storage

P0 does not persist:

- raw message body;
- attachment binary;
- embed JSON as an archive payload;
- avatars;
- full Discord channel/server history;
- full-text search corpus;
- embeddings.

### 8.3 Recommended relational schema

```text
GuildConfig
- guild_id (PK)
- archive_channel_id
- configured_by_user_id
- created_at
- updated_at

GuildAllowedRole
- guild_id (FK)
- role_id
- PK(guild_id, role_id)

Clip
- guild_id
- source_message_id
- source_channel_id
- archive_provenance_message_id nullable
- archive_forward_message_id nullable
- author_user_id
- status
- author_notification_status
- created_at
- updated_at
- removed_at nullable
- PK/UNIQUE(guild_id, source_message_id)

Clipper
- guild_id
- source_message_id
- clipper_user_id
- clipped_at
- PK(guild_id, source_message_id, clipper_user_id)

AdminSession
- session_id / token hash
- guild_id
- user_id
- expires_at
- revoked_at nullable

SetupToken (if server-side one-time token persistence is used)
- token_hash / nonce
- guild_id
- user_id
- expires_at
- used_at nullable
```

Recommended enums:

```text
ClipStatus:
- PENDING
- ACTIVE
- DELETING
- FAILED
- REMOVED_BY_AUTHOR
- REMOVED_BY_ADMIN

AuthorNotificationStatus:
- PENDING
- DELIVERED
- UNDELIVERABLE
```

Implementation may use more compact internal states if all approved semantics remain testable.

---

## 9. Concurrency and idempotency invariants

These are product requirements, not optional implementation polish.

1. One canonical Clip per `(guild, source_message)`.
2. One preservation signal per `(clip, user)`.
3. Duplicate requests are idempotent.
4. Only the request that successfully claims a new Clip may create the first Discord archive message.
5. Clip mutations serialize around the canonical Clip row / equivalent lock boundary.
6. An ordinary ACTIVE archive should have at least one preservation signal.
7. When last preservation signal disappears, ordinary deletion begins.
8. A new Clip during ordinary deletion may revive preservation; the system must converge to an active archive if a valid signal remains.
9. Author/admin removal overrides preservation signals and cannot be resurrected by normal Clip requests.
10. Cross-system partial failures between PostgreSQL and Discord must be recoverable rather than creating permanent duplicate/missing state.

### 9.1 Simultaneous Clip

Use DB uniqueness/upsert rather than check-then-insert.

### 9.2 Simultaneous Unclip

Use a transaction/row lock or equivalent serialization to avoid both users observing stale clipper counts.

### 9.3 Cross-system delete race

If ordinary deletion is in-flight and a new preservation signal arrives, the finalizer must re-check DB state. If Discord deletion succeeded but Clip has been revived, recreate/reconcile the archive rather than leaving an ACTIVE row pointing to missing content.

### 9.4 Tombstones

Author/admin removal retains a durable row/state to block accidental recreation.

---

## 10. Interaction feedback

### 10.1 Principle

- Successful normal actions receive a minimal private acknowledgement.
- Duplicate clipping is not styled as an error.
- Failures requiring user action receive a private explanation.
- No interaction chatter is posted publicly into the source channel.

### 10.2 Clip outcomes

Internal semantic outcomes should distinguish at least:

```text
CREATED
ALREADY_CLIPPED_BY_USER
CLIPPER_ADDED
NOT_AUTHORIZED
REMOVED_BY_AUTHOR_OR_ADMIN
SOURCE_UNAVAILABLE
FAILED
```

Possible user copy:

- success: `✓ Clipped`
- duplicate: `Already clipped` or same low-key success treatment
- unauthorized: private explanation
- tombstoned: `This message can't be clipped.`
- infrastructure error: `Couldn't clip this message. Try again.`

### 10.3 Unclip outcomes

- signal removed, others remain: `✓ Unclipped`
- signal removed, last clipper: `✓ Unclipped`
- user had no signal: `You haven't clipped this message.`

Users should not need to understand the canonical Clip state machine.

---

## 11. Author notification and discovery

### 11.1 First-clip DM

On first canonical archival:

- attempt one best-effort private DM to the original author;
- include source context and a `Remove from archive` action;
- DM failure does not roll back clipping;
- record notification status so retries/restarts do not spam the author.

### 11.2 Persistent marker

Bot adds a persistent status reaction (working symbol: `📎`) to the source message while an active archive exists.

P0 semantics:

> The bot-owned marker means an archive exists. User-added reactions with the same emoji have no Clip-domain meaning.

Known P0 limitation: users may click the same reaction, causing the visible reaction count to resemble a Starboard-style metric. Clip ignores those reactions. When an archive is removed, the bot can remove its own reaction, but user-added copies may remain visually. Therefore reaction count is not authoritative and should not be presented as such.

P1 may test:

- reaction as shortcut to Clip;
- reaction as lightweight endorsement only;
- threshold/community mode.

These are explicitly out of P0 because they change the semantic position toward Starboard/popularity.

### 11.3 Independent removal path

Author-removal must not depend on DM delivery.

Author can invoke `Apps → Remove from Clip Archive` on the original message. Server-side authorization checks the source author ID.

---

## 12. Privacy / abuse model

### P0 protections

- clipping restricted to configured roles/admins;
- archive private by default;
- human-selected target only; no bulk monitoring;
- message content not copied into Clip DB;
- first-clip author notification is attempted;
- original author can remove archive;
- admin can remove archive;
- removal tombstone prevents immediate recreation;
- operational logs must not dump message bodies/attachments.

### Deferred P1 protections

- per-user “do not allow my messages to be clipped” preference;
- per-guild author preferences;
- per-channel admin denylist;
- permission-aware source/archive visibility comparison;
- dedicated archive destinations per permission domain;
- richer author “My archived messages” view.

Reason for deferral: these create a durable preference/policy plane and permission-graph complexity beyond the minimal capture MVP.

---

## 13. Web archive P0

### Access

Admin-only short-lived session. No public or member-facing URL.

### Read path

1. Query PostgreSQL for Clip metadata/page.
2. Fetch archived Discord messages live using `archive_message_id`.
3. Render server-side/browser view.

P0 does not persist/cache the message payload.

### Scope

- reverse-chronological list;
- pagination;
- source-channel filter;
- author/source channel/original timestamp/clipped timestamp;
- open-original link where still valid;
- graceful `Original unavailable` state;
- read-only clip content.

### Explicit exclusions

- full-text search;
- tags;
- collections;
- semantic search;
- author filter;
- clipper ranking;
- editing/annotation;
- content deletion from web.

P1 performance polish: add short-lived server-side cache. Cache is never authoritative; miss falls back to Discord.

---

## 14. Web / setup authentication P0

No full Discord OAuth/member account system.

Flow:

```text
Discord /setup
-> verify admin
-> ~15 min one-time token
-> browser URL
-> exchange for Secure/HttpOnly/SameSite session
-> ~30 min short admin session
-> setup/archive/config access
-> expiration
-> run /setup again when needed
```

Admin session/token state is durable enough to enforce expiry/revocation but intentionally short-lived.

P1: Discord OAuth + member permission checks + proper shared archive browsing.

---

## 15. Discord permissions principle

Clip never requests Discord `Administrator`.

### Runtime capabilities

Request only permissions demonstrated necessary for:

- viewing target/archive channels as required;
- sending/forwarding archive content;
- reading required message history for specific target/archive operations;
- adding/removing bot-owned status reaction;
- command interactions.

Exact minimum permission set must be validated against a fresh test guild before submission.

#### `VIEW_CHANNEL` on source channels is a steady-state requirement (amended 2026-08-18)

Discord refuses to create a forward of a message the application cannot read, returning error `160014`. `VIEW_CHANNEL` on every channel a member may clip from is therefore an ongoing runtime requirement, not an incidental one, and must be stated plainly to administrators during setup. A clip attempt in a channel the bot cannot see fails as an invalid target rather than silently producing an empty archive entry.

### Optional bootstrap capability

`MANAGE_CHANNELS` only when administrator chooses automatic private archive creation.

If an existing channel is selected, Clip validates permissions and does not “helpfully” rewrite channel permissions.

After automatic setup, the product no longer needs to use `MANAGE_CHANNELS` for normal operation. Admin may revoke it.

---

## 16. Data lifecycle

### Guild configured

Control-plane metadata persists.

### Delete Clip data

Admin can explicitly delete Clip data for the guild:

- GuildConfig;
- role config;
- Clip rows;
- Clipper rows;
- tombstones;
- notification/session control data as applicable.

Discord archive messages/channel are left untouched. Deleting our service data must not silently destroy community-owned Discord content.

### Bot uninstall

P0 does not require a Gateway listener solely to detect uninstall and purge data. Automatic uninstall cleanup/grace-period policy is P1.

### Tombstone retention

Retain author/admin tombstones while guild remains configured, rather than inventing an arbitrary expiration that could allow unwanted re-clipping.

---

## 17. Failure and operational cases

P0 must define/test these behaviors:

1. Discord interaction signature invalid -> reject.
2. Setup token expired/used -> deny; tell admin to rerun `/setup`.
3. Admin session expired -> deny; tell admin to rerun `/setup`.
4. User lacks Clip role/admin -> private denial.
5. Source message unavailable before processing -> fail without DB corruption.
6. First creator loses DB race -> do not create second Discord archive message.
7. Discord archive creation fails -> Clip remains recoverable (`FAILED`/retry path), no false ACTIVE state.
8. Discord request times out ambiguously -> avoid blind duplicate side effects; reconcile before retry where possible.
9. Author DM fails -> mark `UNDELIVERABLE`; Clip stays valid.
10. Status reaction fails -> Clip may remain valid; marker is auxiliary.
11. Archive message manually deleted -> DB may become stale; surface missing state and support later reconciliation.
12. Archive channel deleted -> clipping fails safely until admin reconfigures; do not silently create a new channel.
13. Bot removed/reinstalled -> existing Discord archive remains; admin may point setup back to it.
14. Original message deleted -> archived snapshot stays; original link may become unavailable.
15. Source edited -> snapshot remains point-in-time.
16. Multiple clip/unclip requests -> converge according to invariants.
17. Rate limiting -> state remains recoverable; do not fan out uncontrolled retries.
18. Logs -> record IDs/state transitions/errors, never message content/attachments.
19. Provenance message posted but forward creation fails -> Clip must not reach ACTIVE. Either retry the forward or delete the orphaned provenance message; never leave a provenance line pointing at a snapshot that does not exist. (Added 2026-08-18 with the two-message representation, §6.3.)
20. Target message is not forwardable (poll, call, activity, system message) or lives in a channel the bot cannot view -> reject as an invalid target before writing any state; surface `이 메시지는 보관할 수 없습니다`.

### P1 reconciliation / WAL-style recovery

The archive channel can assist repair because archive posts contain source provenance. P1 may add a reconciliation process to compare DB and Discord and repair missing mappings. Do not contort P0 into encoding the entire control plane inside Discord merely to make PostgreSQL disposable.

---

## 18. Hosting / runtime architecture

### P0 transport

Use Discord HTTP interactions. P0 does **not** need a persistent Gateway WebSocket because product inputs are explicit commands/buttons rather than ambient reaction/message events.

### Recommended deployable

Single stateless web/API application:

```text
Discord HTTP interactions ----\
                              -> Next.js web/API -> PostgreSQL
Browser setup/archive --------/
                              -> Discord REST API
```

Suggested stack assumption for planning:

- Next.js App Router
- TypeScript
- React
- PostgreSQL
- Prisma or equivalent relational ORM
- Discord interactions signature verification
- Discord REST calls
- containerized deployment

The implementer may choose equivalent libraries but should preserve interfaces/semantics and record meaningful deviations in the cumulative snapshot.

### Available self-hosting environment

- Intel N100
- 16 GB RAM
- existing k3s
- existing PostgreSQL cluster
- existing Traefik ingress
- observed CPU load ~1.6 at planning time
- observed memory use ~5% at planning time

Initial resource request may be small (for example ~100m CPU / 256 MiB memory), but actual deployment should be observed rather than asserting guaranteed requirements.

### Cost documentation

Do not call self-hosting free.

Document:

- domain registration/renewal;
- incremental compute largely absorbed by existing hardware;
- electricity/network/hardware depreciation/operator effort as real economic costs even if treated as sunk/existing for the assignment;
- indicative cloud alternative separately if useful.

---

## 19. Deployment-first requirement

Deployment is P0 work, not a final task.

Early production checkpoint must establish:

- DNS/domain;
- HTTPS through Traefik;
- deployed interaction endpoint;
- Discord endpoint verification;
- Postgres connectivity/migration;
- application secrets;
- installable test Discord application;
- ability to run at least one real interaction against deployed infrastructure.

The remaining implementation should be validated repeatedly against this real environment.

---

## 20. P0 acceptance criteria

A fresh evaluator can:

1. install the Discord application;
2. run `/setup` as an admin;
3. open a short-lived web configuration link;
4. choose/create archive destination;
5. choose allowed roles;
6. Clip a message through the context menu;
7. receive low-noise private success feedback;
8. see one canonical archive entry in Discord;
9. see the source status marker;
10. see duplicate clipping remain canonical while recording multiple clippers;
11. Unclip one user's signal without deleting if another signal remains;
12. delete when final normal signal disappears;
13. author/admin remove a clip and block recreation;
14. author receive best-effort first-clip DM or still have a native removal path if DM fails;
15. admin open read-only web archive with pagination/channel filter;
16. archive content be fetched from Discord rather than persisted in app DB;
17. deploy successfully in the intended environment.

---

## 21. Explicit P1 roadmap

P1 candidates, not promises:

- permission-aware clipping / archive visibility enforcement;
- per-channel denylist;
- per-user/per-guild opt-out settings;
- explicit parent/thread/multi-message clipping;
- reaction shortcut/endorsement experiments;
- member Discord OAuth + member web archive;
- search/tags/collections;
- short-lived content cache;
- Gateway worker for ambient events;
- reconciliation/WAL-like repair tooling;
- archive permission-domain routing;
- author “My archived messages” management;
- community recap/year-in-review;
- AI-assisted clustering/summarization only after a meaningful curated corpus exists;
- publishing/export/PDF/physical artifact adapters, potentially including Book Print API.

---

## 22. Non-goals

P0 does not attempt to:

- discover important messages automatically;
- read every Discord message;
- mirror the entire server;
- reproduce Discord permissions perfectly in the web app;
- provide member search across chat history;
- host user attachment payloads;
- act as knowledge-management replacement;
- generate AI summaries;
- create a community magazine/yearbook;
- integrate Sweetbook printing;
- monetize/bill users;
- support every chat platform.

These cuts are deliberate evidence of MVP judgment.
