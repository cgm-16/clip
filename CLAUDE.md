# Clip — implementation rules

Read `README.md` for what the product is. The UI specification is `docs/06_DESIGN_HANDOFF.md` and is self-sufficient for the web UI. Product semantics live in `docs/01_CLIP_PRODUCT_SPEC.md` and are settled — do not redesign them.

**Deadline: 2026-08-20 23:59 KST.** If scope is endangered, cut polish before correctness, consent, or deployment.

## Stack

Next.js App Router · TypeScript · React · PostgreSQL · Prisma · Zod · Vitest · Playwright · pnpm · Docker → k3s behind Traefik.

One deployable serves both the Discord interaction endpoint and the admin web UI. No Gateway worker in P0.

## Design hard rules

1. `design/*.dc.html` are **design references, not code**. Never import, copy, or serve them. Recreate the UI in this codebase's framework.
2. Use `tokens.css` as the single source of visual values. No ad-hoc hex codes, no new spacing values outside the 4px scale.
3. `--faint` (#5f646a) is for **disabled controls only**. Any readable text uses `--muted`. This is an accessibility rule, not a preference.
4. No shadows, no gradients, no blur, no animation beyond a 120ms hover color transition.
5. Radius is 2px (1px chips, 50% radios). Borders are 1px.
6. Monospace = machine values only (channel, role, timestamp, permission constant, slash command). Never for human sentences.
7. One primary button per screen. Destructive actions are always two steps with consequence copy listing what is deleted and what survives.
8. Every state gets a **text tag** (`NOTE` / `OK` / `확인` / `오류` / `누락`). Never signal state with color alone.
9. Korean copy in `docs/06_DESIGN_HANDOFF.md` is final. Put it in a string table; do not paraphrase or "improve" it. Never invent new Korean strings — reuse an existing one or ask.
10. Mockups use `<span>` where a real control belongs. Build semantic `<button>`, `<input>`, `<select>`, `<fieldset>` with labels and keyboard support.

## Discord API constraints — verified 2026-08-18, do not rediscover

These were confirmed against current Discord docs and already cost one plan revision.

- **A forward cannot carry additional content.** Sending `content`/`embeds`/`components` alongside `message_reference.type = 1` fails with error `160011`. An archive entry is therefore **two messages**: a provenance message, then the forward. Both IDs live on the Clip row; removal deletes both.
- **Forward snapshots omit `author`.** Provenance must come from our control plane, never from the snapshot.
- **`VIEW_CHANNEL` on source channels is a steady-state permission**, not bootstrap-only. Forwarding a message the bot cannot read fails with `160014`.
- **Only `DEFAULT`, `REPLY`, `CHAT_INPUT_COMMAND`, `CONTEXT_MENU_COMMAND` are forwardable.** Polls, calls, activities and system messages must be rejected as invalid targets *before* any state is written.
- Setup token TTL is **15 minutes** (the Korean copy is authoritative; the spec was aligned to it).

## Invariants that are product requirements, not polish

Never weaken these to make a test pass:

- One canonical Clip per `(guild_id, source_message_id)`; one Clipper per `(guild_id, source_message_id, clipper_user_id)`.
- Use DB uniqueness/upsert, never check-then-insert. Mutations that depend on clipper count must hold a row lock.
- Author/admin removal overrides all clipper signals and leaves a tombstone that blocks recreation.
- Never reach `ACTIVE` with a missing or partial Discord archive.
- Never persist raw message bodies, attachments, or embed payloads in Postgres — or in logs.

## Do not add

Reaction/vote/rank counts anywhere in the web UI. Dark/light theme switcher UI (the tokens support both; P0 ships dark). Illustrations, icon sets, marketing pages. Search, AI summarization, publishing — those are P1+ per the spec.

## Workflow

- Tasks live in `docs/tasks/` with a dependency graph in `docs/tasks/00_DAG.md`. Work them in DAG order.
- **One branch and one PR per wave**, not per task: `wave/<n>-<slug>`. Never commit to `main`.
- Conventional Commits. Commit per task, not per wave — each commit one reviewable logical unit.
- CI must be green before merge: `pnpm lint`, `pnpm test`, `pnpm build`.
- TDD: write the failing test first. Concurrency invariants get tests against a real Postgres, not mocks.
- Playwright e2e runs against the deployment, not in the merge gate. Discord interaction scenarios are the manual suite in `docs/tasks/` Wave 6.

## Journaling — two files, different jobs

- **`docs/journal/journal-YYYY-MM.md`** — technical notes, dead ends, debugging findings, unrelated issues you must not fix now. Cheap and frequent. Write here before you forget.
- **`docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md`** — assignment evidence, append-only, using the dated template in its §0. Append **once per wave**, plus **immediately** whenever an AI proposal turns out wrong. Those failures are the Q4 answer and are unrecoverable if deferred.

Never rewrite snapshot history, and never record planned work as implemented.

## When you change the design

If implementation forces a visual or copy change, record it in `docs/DESIGN_RATIONALE_APPEND.md` (append, don't rewrite) so the decision log stays complete.
