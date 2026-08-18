# Journal — 2026-08

Technical notes, dead ends and parked issues. Assignment evidence goes to
`docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md` instead — see CLAUDE.md.

---

## 2026-08-18 — Repo preparation

### Discord forward API: the plan's archive format was not buildable

Verified against current Discord docs before writing any code.

- `message_reference.type = 1` (FORWARD) **cannot** be sent with `content`, `embeds` or
  `components` → error `160011` "Forward messages cannot have additional content".
- The `message_snapshots` object is a minimal subset and **excludes `author`**.
- Creating a forward requires `VIEW_CHANNEL` on the source channel → error `160014` otherwise.
- Forwardable types: `DEFAULT`, `REPLY`, `CHAT_INPUT_COMMAND`, `CONTEXT_MENU_COMMAND`.
  Polls, calls and activities are not forwardable.
- A `forward_only` field exists on the message reference for selective attachment/embed inclusion.
  Not needed for P0 but worth remembering if attachment handling gets fiddly.

Spec §6.3 assumed one archive post containing the snapshot *and* provenance. Not possible.
Resolved as two messages (provenance, then forward); spec §6.3/§8.3/§15/§17 amended.

Sources: https://docs.discord.com/developers/resources/message ·
https://github.com/discord/discord-api-docs/pull/6818

### Environment gaps at prep time

- `kubectl` installed but **zero configured contexts** — no cluster access from this machine yet.
- No Discord application created yet; no domain registered yet. Both are human tasks and both
  gate Wave 0, which gates everything else.
- `psql` not installed locally. Use the Postgres docker image or Prisma for DB work.
- Available: node 24.15, pnpm 11.3, docker 29.7, gh 2.97 (authed as `cgm-16`).

### Parked — do not fix now

- `design/Clip P0 Screens.dc.html` Screen A uses a `다음` callout tag; the handoff document
  standardises on `NOTE`. The design HTML is a reference artifact and is not being corrected —
  implementation follows the handoff. Logged in `DESIGN_RATIONALE_APPEND.md` §10.4.
- `docs/02_CLIP_IMPLEMENTATION_PLAN.md` references a spec at
  `docs/superpowers/specs/2026-08-18-clip-p0-design.md` that does not exist. Rather than
  duplicating the spec (which would drift), the task files point at `01_CLIP_PRODUCT_SPEC.md`.
- Screen C's `보관된 메시지 · 47개` count has no defined semantics in any document.
  Decided: counts `ACTIVE` clips only, excluding tombstoned and removed. Revisit if it looks wrong.
