# Wave 6 manual checklist: 6.1 permission matrix and 6.3 scenarios

Ori runs this against the **deployment** (`https://clipendpoint.cc`), never localhost. Korean strings are quoted from the string tables by key (`DISCORD_COPY.*` in `lib/discord/copy.ts`, `WEB_COPY.*` in `lib/ui/copy.ts`). If what you see differs from the quoted string, that is a finding.

For each row, record **pass/fail**, the time (KST), and a screenshot path under `docs/evidence/wave-6/` (screenshots double as submission evidence).

## Prep

- [ ] The deployed image includes Wave 6 Tasks 1–4 (`#64` logging). Record the image tag: `sha-_______`.
- [ ] **A fresh guild for 6.1**, never used with Clip. Three accounts:
  - **A**: guild owner/admin.
  - **R**: a member holding a role you will configure as a clipping role.
  - **M**: a plain member with no configured role.
- [ ] Invite Clip with the README invite link (permissions integer `68688` = `MANAGE_CHANNELS`, `ADD_REACTIONS`, `VIEW_CHANNEL`, `SEND_MESSAGES`, `READ_MESSAGE_HISTORY`).
- [ ] Two source channels: `#general` and `#second` (for the archive filter in scenario 15).
- [ ] A terminal tailing the pod log, used by every "log" check below:
  `kubectl -n clip logs -f deploy/clip -c clip | grep -E 'clip\.|archive\.'`

## 6.1: Permission matrix (#35)

### Intended minimum set, all granted

| # | Check | Expected | Result |
|---|---|---|---|
| P1 | A runs `/setup`, chooses **create new** (`WEB_COPY.setup.destinationCreateLabel`), saves | Private archive channel created; Screen C shows `WEB_COPY.setupComplete.title` | |
| P2 | A clips a message in `#general` via right-click → Apps → Clip | `DISCORD_COPY.success`; provenance + forward both appear in the archive channel; 📎 marker on the source | |
| P3 | Author DM | The author (with DMs allowed) gets `DISCORD_COPY.firstArchivalDm` with both buttons | |
| P4 | Revoke `MANAGE_CHANNELS` from Clip's role, then A clips a new message and unclips it | Both succeed (README claim: bootstrap only) | |
| P5 | Re-run `/setup` → edit → **existing channel** that Clip cannot send to (deny `SEND_MESSAGES` for Clip in that channel's overwrites) | Save refused with `WEB_COPY_AUTHORED.destinationMissingPermissions` naming the missing permission; no opaque failure | |
| P6 | Auto-create path without `MANAGE_CHANNELS` (in a second fresh guild, or after deleting Clip data on Screen E) | Record exactly what A sees | |

### One revocation at a time (the missing "complete minimal matrix")

Restore everything between rows. For each, clip a new message as A and record what happens and the log line.

| # | Revoked | Where | Expected | Observed | Log line (`clip.archive_failed` step / failure / httpStatus / discordCode) |
|---|---|---|---|---|---|
| R1 | `VIEW_CHANNEL` | `#general` (source) | `DISCORD_COPY.invalidTarget` (error `160014` / missing access); no state written | | |
| R2 | `READ_MESSAGE_HISTORY` | `#general` | record | | |
| R3 | `VIEW_CHANNEL` | archive channel | `DISCORD_COPY.transientFailure` or `invalidTarget`; never ACTIVE without both messages | | |
| R4 | `SEND_MESSAGES` | archive channel | same as R3 | | |
| R5 | `ADD_REACTIONS` | `#general` | Clip still succeeds; only the 📎 marker is missing | | |
| R6 | Message Content Intent (Developer Portal) | application | Forward refused `160014` (README claim) | | |

**Done:** the orchestrator replaces the README permission table with the measured set from these rows, then appends the snapshot.

## 6.3: The 17 scenarios (#37)

| # | Scenario | Steps | Expected | Result |
|---|---|---|---|---|
| 1 | Setup, create new channel | covered by P1 | Screen B → Screen C | |
| 2 | Setup, existing channel | `/setup` → edit → existing channel Clip can use; add R's role | Saves; Screen E shows the channel and role | |
| 3 | Admin implicit clip | A clips | `DISCORD_COPY.success` | |
| 4 | Allowed-role clip | R clips a different message | `DISCORD_COPY.success` | |
| 5 | Unauthorized clip | M clips | `DISCORD_COPY.noPermission`; nothing in the archive | |
| 6 | Same user twice | A clips the scenario-3 message again | `DISCORD_COPY.duplicate`; still one archive entry | |
| 7 | Two users, same message | R clips the scenario-3 message | `DISCORD_COPY.success`; still one archive entry | |
| 8 | One unclip, another signal remains | A unclips the scenario-3 message | `DISCORD_COPY.unclipped`; archive entry stays | |
| 9 | Final unclip | R unclips it | `DISCORD_COPY.unclipped`; both archive messages deleted; marker removed | |
| 10 | Author removal | Author uses DM `firstArchivalDmRemoveFromArchive` (or the Remove command) on a clipped message | Archive entry deleted | |
| 11 | Re-clip after author removal | A clips the scenario-10 message | `DISCORD_COPY.invalidTarget` | |
| 12 | Source edited after clip | Edit a clipped message | The archive forward still shows the original text | |
| 13 | Source deleted after clip | Delete a clipped source | The archive forward survives; Screen D shows `WEB_COPY_AUTHORED.originalUnavailable` | |
| 14 | DM blocked | An author with server DMs off gets clipped | Clip still `DISCORD_COPY.success` | |
| 15 | Archive filter + pagination | Clip > 1 page across `#general` and `#second`; Screen D | Filter by channel, page next/previous, URL reflects both | |
| 16 | Session expiry | Leave an admin tab 30+ min, then act | `WEB_COPY_AUTHORED.adminSessionExpiredTitle` with `/setup` recovery | |
| 17 | Archive copy deleted by hand | Delete a forward in the archive channel; open Screen D | Row shows `누락` + `WEB_COPY.archive.missingCopyTitle` | |
| 17b | Poll / system message | Clip a poll | `DISCORD_COPY.invalidTarget`; no row written | |

### Retry timing (#78)

- A clip that answered `DISCORD_COPY.transientFailure` (row `FAILED`) can be retried at once.
- A Clip stuck in `DELETING` (its final delete failed, so the archive copy stays up) or `PENDING` (its creator died) recovers only when someone clips or unclips **that same message** after it has sat untouched for **5 minutes**. Nothing runs in the background.
- If an unclip leaves the archive copy up, wait 5+ minutes before retrying. A retry inside that window changes nothing by design, so it is not a new bug.

### Burst repeat (#64)

- [ ] A and R clip 5 different messages within ~10 s.
- [ ] Every failure shows `DISCORD_COPY.transientFailure` and no ACTIVE row without both messages.
- [ ] For each `clip.archive_failed` line, copy `step`, `failure`, `httpStatus`, `discordCode` here: ______
- [ ] Open Screen D during the burst; copy any `archive.content_read_failed` lines here: ______

**Done:** every row recorded. A failure that is not fixed becomes a stated known limitation in the snapshot, never dropped.
