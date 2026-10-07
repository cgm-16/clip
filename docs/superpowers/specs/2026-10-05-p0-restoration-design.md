# Complete the approved Clip P0

Date: 2026-10-05. Status: design draft for Ori's review; no implementation or deployment is claimed.
Code baseline: `3e5e6133f9ce4f5f07af37a9488c4adac88d7b9f` (`main`).

## Outcome and approved decisions

Restore the approved P0 capabilities cut for the August submission deadline. An administrator can configure additional clippers, browse the cross-channel archive in a browser, inspect/edit configuration, and delete Clip's guild data. The restored product must pass the previously deferred verification work. Ori confirmed this scope, replaced the August deadline with a 2026-10-31 target, selected clipping-only role authority, and authorized Korean copy drafts for review.

Clipping authority and Discord readership are separate. An allowed role permits Clip commands; it does not grant archive-channel visibility. A newly created archive retains its private default and bot overwrite. Administrators manage readership in Discord. Clip never rewrites an existing channel's permissions, and `MANAGE_CHANNELS` remains bootstrap-only and revocable.

This decision supersedes the future role-readable direction in [design rationale §11.6](../../DESIGN_RATIONALE_APPEND.md). The earlier entry remains as history. The setup sentence promising role visibility must be replaced before roles ship.

The governing sources are the [product spec](../../01_CLIP_PRODUCT_SPEC.md), [design handoff](../../06_DESIGN_HANDOFF.md), and original task issues. This document resolves the approved visibility change and the engineering details required by the restored surfaces; it does not redefine the Discord capture/removal model.

## Scope and delivery boundaries

| Deliverable | Original work | Completion condition |
| --- | --- | --- |
| Role configuration and setup completion | `4.3`, `F.4`, remaining `4.1`/`4.4` details; [#29](https://github.com/cgm-16/clip/issues/29) | A non-admin with a configured role clips in a real guild; editing roles leaves existing preservation signals intact; missing destination permissions are refused |
| Admin archive and configuration/data deletion | `5.1`–`5.4`, `F.5`; [#31](https://github.com/cgm-16/clip/issues/31), [#32](https://github.com/cgm-16/clip/issues/32), [#33](https://github.com/cgm-16/clip/issues/33), [#34](https://github.com/cgm-16/clip/issues/34) | Screens D/E operate through real session-gated routes; archive content loads from Discord; guild-data deletion preserves Discord content |
| Complete P0 verification | `F.6`, `6.1`–`6.4`, `7.1`; [#38](https://github.com/cgm-16/clip/issues/38), [#39](https://github.com/cgm-16/clip/issues/39) | Design/copy guard, permission matrix, integrated races, all 17 original manual scenarios, deployed Playwright and accessibility/responsive checks are evidenced |

Follow the existing wave-based branches/PRs and original DAG dependencies. Reopen the relevant cut issues before implementation and keep their briefs as the task source. The executable implementation plan will specify task order, files and commands after this design is approved.

P1 remains deferred: member OAuth, search, tags/collections, AI, publication/export, content caching, Gateway events, ambient reconciliation, multi-message capture and automatic permission-domain routing. Single-message immutable capture, author/admin removal, tombstones and content ownership retain their approved semantics.

## Approach

| Approach | Implication |
| --- | --- |
| Extend the deployed setup flow and restore the designed admin pages — selected | Reuses the existing session, domain, Discord client, tokens and UI primitives; each deliverable can be verified and released separately |
| Replace the web flow in one pass | Rebuilds working setup and authentication while also adding archive/deletion behavior; enlarges the review and regression surface |

Keep one Next.js deployable and PostgreSQL control plane. Add page-specific components and focused repository/read functions. Existing interfaces grow only where a restored caller needs them. Use native controls, React and the installed libraries; Playwright is the originally required additional testing dependency.

## Admin access and navigation

- `/setup/:token` retains its one-time exchange: 15-minute setup token, 30-minute fixed admin session, secure HttpOnly cookie, no refresh token.
- For an unconfigured guild, show Screen B then Screen C. For a configured guild, a fresh `/setup` link opens current settings; an explicit edit action opens the prefilled setup form.
- Restore `/admin/:guildId/archive` (Screen D) and `/admin/:guildId/settings` (Screen E). Screen C's archive action opens the web archive; settings opens Screen E. The navigation has only archive/settings tabs.
- Every page and API independently checks the live session and matches its guild to the route. Guild IDs in paths or bodies never confer authority. Reuse the expired/recovery presentation when a session is absent or expires.
- Extend `/setup/data` with current configuration, roles and the guild/admin display details the handoff requires. Names are fetched from Discord; IDs remain usable fallbacks when a display lookup fails.
- Keep `/setup/save` as the configuration writer. Add `allowedRoleIds` to its validated request and response. New admin reads and deletion use `/api/admin/guilds/:guildId/...`; do not create another configuration writer.
- Authenticated metadata/content responses and pages use private, no-store behavior. Bot/session tokens never reach browser JavaScript. The setup token is used only by the existing one-time exchange; admin page data, logs and shared caches contain no bearer values.

Read the installed Next.js guides for pages, Route Handlers and cookies before implementation. The baseline package documents asynchronous page/route params and `cookies()`; follow those APIs and existing `NextRequest` cookie handling.

## Roles and destination validation

The role selector follows the handoff's chip/option layout and keyboard behavior using semantic controls. `@everyone` is shown but unselectable. Empty selection means admins only. Selected role IDs are deduplicated, validated against a fresh same-guild role lookup, and replaced transactionally with the configuration save. A deleted/stale role is visible by ID and must be removed from the submitted selection; it is never silently granted.

Use the existing `canClip` rule inside the locked claim transaction. A role-only edit is allowed while clips exist. Losing a clipping role prevents future Clip claims, retains existing preservation signals, and does not remove the member's ability to Unclip their own signal. No role edit changes Discord permission overwrites.

Destination changes keep the existing `hasLiveClips` refusal and locked final recheck. Readable UI explains a `409` instead of reporting it as an unspecified failure. Store no per-Clip archive routing in this restoration. If saving fails after automatic creation, retain the existing cleanup behavior for the unused channel.

The existing-channel path must check the bot's effective channel permissions before saving. Retrieve the bot member, guild roles and channel overwrites server-side, use BigInt permission flags, and follow Discord's overwrite precedence. Require `VIEW_CHANNEL`, `SEND_MESSAGES` and `READ_MESSAGE_HISTORY` for the restored archive operations. Refuse unknown/inaccessible permissions rather than assuming access. Show the actual missing permission constants; never request `Administrator` or change the selected channel's overwrites. Discord's [permission rules](https://docs.discord.com/developers/topics/permissions#permission-overwrites) define the computation.

Automatic creation retains the private default and grants the bot the permissions the archive operations require, including history reads. Verify `MANAGE_CHANNELS` can be revoked afterward. Check source read access and Message Content application settings in the live permission matrix; do not claim a destination check proves source access. The [Get Channel Message endpoint](https://docs.discord.com/developers/resources/message#get-channel-message) requires view/history access for text channels.

## Archive metadata and live content

### Listing contract

List only `ACTIVE` Clip records for the session's guild. A vanished Discord copy still has an ACTIVE metadata row and remains in the count. PENDING/FAILED/DELETING and author/admin tombstones are not browseable archive entries. Counts on setup, settings and archive use this same definition.

Use a fixed page size of 20 and stable descending `(createdAt, sourceMessageId)` ordering. Cursor boundaries contain both values; validate them rather than accepting SQL fragments or Discord destination IDs. Support previous/next navigation with before/after boundaries in the URL. The source-channel filter is also in the URL and resets pagination. Available filter channels come from this guild's ACTIVE records, including records for deleted channels.

Return items, filtered total, actual range and navigation cursors from one consistent metadata read. Calculate range from the same filtered ordering rather than trusting a client-supplied page offset. Fresh navigation reflects concurrent additions/removals; cursor ordering prevents a new clip from shifting every older page. Empty pages and invalid query values render an empty/recovery state or a clear `400`, never an unbounded query.

Use one supporting metadata index on `(guildId, status, createdAt, sourceMessageId)`. The current primary key identifies a canonical message but does not support the requested time ordering. Avoid a separate index per possible filter without measured need.

### Content contract

Render the metadata shell first with per-row loading states. A bounded batch content read accepts at most the displayed page's 20 source message IDs, resolves each against this guild's ACTIVE rows, and derives the Discord channel/forward ID server-side. It cannot be used as an arbitrary bot-authenticated Discord proxy. Fetch concurrency is capped at four per batch, using the existing REST client's timeout/rate-limit handling. Request cancellation and attempt ownership prevent stale page results from overwriting a newer filter/page.

Read the forward's snapshot for message content, code/plain text, safe embed previews and attachment links/previews. PostgreSQL supplies author ID, channel ID, source ID and clip time. Treat all Discord response data as untrusted: validate its shape, escape text, allow only safe link schemes, and never render payload HTML or interactive Discord components. Do not make a server fetch to arbitrary user-supplied attachment URLs. Browser previews use fresh Discord URLs with optimization disabled; no message/media proxy, Next image disk cache or other content copy is introduced.

The current Clip schema has no original-message timestamp. Use the snapshot timestamp when available and derive the source creation time from its Discord snowflake when the copy is missing. This recovers metadata without storing content or introducing a timestamp backfill. Discord documents the [snapshot fields](https://docs.discord.com/developers/resources/message#message-snapshot-object) and [snowflake timestamp](https://docs.discord.com/developers/reference#snowflakes).

Snapshots do not supply original authors or reply references. Use the stored author ID and live display lookups; never mistake the forward's bot author for the original author. For a reply, retrieve only source reference metadata when available, without including the parent body. If source/reply metadata is inaccessible, retain the archive and omit the unavailable reply detail. Offer the original link; mark it unavailable only when checked, not merely because the archived snapshot exists or a lookup timed out.

| Result | Row behavior |
| --- | --- |
| Valid snapshot | Ready content and control-plane provenance |
| Confirmed unknown message/channel | `누락`; retain author/channel/time metadata and the approved missing-copy explanation |
| Permission/access denial | `오류`; explain access could not be checked/read, preserve metadata, offer retry |
| Timeout, rate-limit exhaustion, network/5xx or invalid payload | `오류`; retain metadata and offer retry; never claim the Discord message was deleted |
| Session expired | Stop content loading, clear visible content and show `/setup` recovery |

Browsing never changes Clip status, removes control rows or performs reconciliation. No raw body, attachment, embed payload or response-bearing exception is persisted/logged. Discord display lookups are deduplicated only inside the current request; there is no persistent content cache.

## Guild-data deletion and concurrent work

Screen E shows current destination, allowed roles and ACTIVE count. Its danger action opens the handoff's consequence panel; submission remains disabled until acknowledgement is checked. A dedicated same-guild admin POST at `/api/admin/guilds/:guildId/delete-data` checks origin, content type, session and explicit acknowledgement server-side.

One transaction deletes this guild's configuration, allowed roles, clips, clippers, tombstones, notification state on Clip rows, setup tokens and admin sessions in foreign-key-safe order. A rollback retains all of them. Other guilds are untouched. Clear the current cookie after success and show completion with `/setup` recovery. A failed delete leaves the confirmation retryable without announcing success.

The deletion operation makes no Discord calls. The existing archive channel/messages and source messages survive; removing the control plane also removes Clip's ability to locate/manage those old copies and its recreation-blocking tombstones. State those consequences explicitly in confirmation copy.

Two concurrency cases need actual protection, not a pre-request authentication check:

1. A setup save/token exchange authenticated before deletion must not recreate configuration or credentials after the deletion commits.
2. A Clip completion from the deleted configuration must not update a newly configured guild's Clip with the same source message key.

Use a transaction-scoped guild advisory lock shared by setup credential issuance/exchange, configuration finalization, deletion and Clip control-state writes. Acquire it before guild/config/Clip row locks in a consistent order, and recheck session/token validity inside protected admin transactions. This covers first setup when there is no config row to lock. Retain short Clip row locks for count-dependent invariants; never hold these locks across Discord I/O. PostgreSQL [transaction-level advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS) release at transaction end.

Add a non-content `GuildConfig.configurationId` UUID generated only when a configuration row is created, including a populated value for existing guilds. Preserve it on ordinary configuration/role edits. Clip operations capture it and recheck it under the guild lock before each later control-state mutation. After deletion/re-setup, an old completion is discarded rather than applied to a new Clip with the same canonical key. Schema and service changes are limited to this lifecycle boundary and the archive query index.

Already-started Discord effects cannot be rolled back by a database transaction. Deletion itself neither starts cleanup nor deletes preserved archive messages. Separate, already-accepted Unclip/author-removal operations may finish their own Discord cleanup. A cancelled creation that produces an unreferenced new pair retains its existing safe cleanup behavior. Verify these interleavings with controlled pauses, including deletion followed by immediate re-setup, rather than claiming a cross-system atomic purge.

For the release introducing this boundary, stop old application writers before the new deletion endpoint becomes available: use a controlled recreate rollout, with migration and application containers on the same immutable release. Mixed old/new workers would bypass the new lifecycle checks. This is a deployment ordering requirement, not a permanent compatibility layer. Confirm the deployment is healthy before exercising the destructive test-guild scenario.

## Korean copy drafts for review

Ori authorized drafting, not approval of text that did not yet exist. These proposed strings are confined to this design until reviewed. Reuse all other approved handoff/authored strings. During implementation, update the handoff and quoted string table together for the replaced visibility sentence; add newly authored recovery strings with attribution and keep the existing anti-drift test intact.

| Condition | Proposed Korean copy |
| --- | --- |
| Replace auto-create description | Clip이 #clip-archive 를 비공개로 만듭니다. 클립 허용 역할은 채널 열람 권한을 부여하지 않습니다. 열람 권한은 서버 관리자가 Discord에서 설정합니다. 생성이 끝나면 채널 관리 권한은 회수해도 됩니다. |
| Destination missing runtime permissions | 이 채널에서 Clip에 필요한 권한이 없습니다. Discord에서 아래 권한을 확인한 뒤 다시 시도해 주세요. |
| Destination change blocked by live clips | 보관 중인 메시지가 있어 아카이브 채널을 변경할 수 없습니다. 기존 메시지를 보관에서 제거한 뒤 다시 시도해 주세요. |
| Archive fetch failed transiently | 보관된 내용을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. |
| Archive access denied | 아카이브 채널에 접근할 수 없습니다. Discord에서 Clip의 채널 권한을 확인해 주세요. |
| Archive empty | 아직 보관된 메시지가 없습니다. |
| No results for selected channel | 이 채널에서 보관된 메시지가 없습니다. |
| Original verified unavailable | 원본 메시지를 찾을 수 없습니다. |
| Session recovery title | 관리자 세션이 만료되었습니다 |
| Deletion consequence: lost control/removal state | 보관 기록과 삭제 차단 기록이 사라집니다. 남아 있는 Discord 사본은 Clip에서 관리할 수 없으며, 같은 원본 메시지가 다시 보관될 수 있습니다. |
| Deletion completed | 이 서버의 Clip 데이터를 삭제했습니다. Discord 아카이브 채널과 그 안의 메시지는 그대로 남아 있습니다. |
| Deletion failed | Clip 데이터를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요. |

Use existing `다시 시도`, text tags, acknowledgement, delete/keep labels, save/cancel labels and `/setup` recovery copy. Render missing permission constants and IDs as machine values. Expired sessions reuse the approved recovery instruction rather than pretending the one-time setup token is the resource that expired.

## Visual and accessibility contract

Recreate the approved Screens B–E using current CSS modules, `tokens.css` and existing primitives. The design HTML remains a reference, not imported/served code. Match existing design values and record justified corrections. Use semantic controls, visible focus, keyboard role selection, text status tags and live announcements for asynchronous/error states.

Verify archive rows, safe media sizing, long URLs/code and filter/pagination at desktop and 390px, plus the handoff's 640px/960px breakpoints. Screen E collapses to one column; no sideways page overflow is acceptable. The already-recorded Screen B narrow-screen overflow is directly in scope for this restored setup's responsive pass.

Restore the design/copy CI guard as focused checks of changed UI files: approved tokens/values, quoted copy and existing forbidden patterns. Reuse/extend current tests and linting; do not build a second design-rule framework or a regex claiming to prove all visual accessibility.

## Acceptance and evidence

Use the project's existing Vitest/Testing Library suites and real PostgreSQL 17. Demonstrate failing behavior checks before each feature/fix. Functional acceptance includes:

- Empty/add/remove role selection, guild ownership validation, `@everyone` refusal, role-only updates with live clips, admin exemption, configured member authorization and withdrawal after losing a role.
- Effective destination permission refusals and successful setup without changing existing-channel overwrites; private auto-create with bot read/write access and bootstrap permission revocation.
- Cross-guild/expired-session denial on every admin route; origin/acknowledgement enforcement on mutations.
- Cursor ties, forward/back navigation, new inserts between pages, channel filters, totals/ranges, zero results and tombstone/non-ACTIVE exclusion against real Postgres.
- Current-page-only Discord reads, request limits/concurrency, payload validation, safe rendering, code/attachments, reply metadata availability, missing copies and transient/permission error separation.
- Atomic deletion, rollback, other-guild isolation, zero deletion-initiated Discord calls, credential invalidation, and deterministic races with save/token exchange/Clip completion and deletion followed by re-setup.
- Existing uniqueness, state-machine, author/admin removal, tombstone, idempotency and count-dependent races remain green. Integrate the HTTP/domain paths against real Postgres instead of relabelling unit tests as the missing integrated pass.

Require `pnpm lint`, `pnpm test`, `pnpm build` and the restored design guard before merge. Playwright runs against the deployed release, as the project requires. Its browser coverage uses real Next routes, real Postgres and a dedicated Discord test guild/content; any short-lived admin session setup is explicit and does not replace the separate real `/setup` scenario. No mocked Discord or database stands in for end-to-end acceptance.

Complete all 17 original manual scenarios, including the three excluded by the deadline cuts. Record the permissions individually revoked/tested, Discord/application configuration, immutable app/migration image, test commands, observations and failures. For destructive checks, use a dedicated test guild and verify actual archive/source messages before and after data deletion. Do not purge the community's existing guild data as a test fixture.

Update README/status and the issue briefs after each completed wave, and record evidence in the journal and PR body; the assignment snapshot is frozen. The 2026-08-20 results remain historical evidence, not evidence that this implementation passes. Deployment requires appropriate live access; a missing credential/environment is reported with preserved progress rather than silently replaced by a mock.

## Decisions confirmed 2026-10-07

- Target 2026-10-31 23:59 KST. If it bites, cut deployed Playwright first, then the F.6 guard; never cut roles, archive, deletion, accessibility or 6.1–6.3.
- P1 selection waits until this P0 is complete and verified.
- The advisory lock with `configurationId` and the server-side effective-permission check are kept as designed.
- Ori edits the Korean draft table in this file; implementation copies the result verbatim. Only the auto-create description blocks Wave 4.
- Ori runs the manual scenarios and permission matrix from a prepared checklist with three accounts; creating a fresh 6.1 guild is a checklist prep step.
- Only the test guild uses the deployment, so the boundary release uses a plain recreate rollout without announcement.
- Implementation is inline per wave, with one independent review before each PR. Waves: `wave/4-p0-restoration` (this design, 4.3, F.4, destination permission check), `wave/5-web-archive` (5.1–5.4, F.5, deletion lock and `configurationId`), `wave/6-verification` (F.6, 6.1–6.4, 7.1). Reopen #11, #12, #29, #31–34, #38 and #39; #35–37 and #43 remain open.

## Review and next step

Review this written design and the Korean copy table. On approval, produce the executable implementation plan against the current code, reopen the appropriate task issues, and select its execution method. Until that review, changes are documentation only.
