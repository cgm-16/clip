# Clip pitch deck — design

Date: 2026-10-14. Approved in conversation by Ori on 2026-10-14. This spec replaces #41's interview capture, which was closed as not planned because the interview will not happen.

## Purpose and reader

- **Purpose.** A portfolio deck for hiring. The reader should finish it trusting the author's product and engineering judgement. A short adoption section closes the deck.
- **Reader.** Someone who opens a link alone, with nobody presenting.
  - Every slide must make sense without narration.
  - There are no speaker notes.
- **Not this deck:**
  - investor framing or market-size claims, since Clip has no users, metrics or business model;
  - a live demo embed.

## Voice, identity, language

- **Voice.** First person: "I cut…", "I used Claude Code as the implementer…".
- **Title slide.** Names the author as `cgm-16`, linked to <https://github.com/cgm-16>. No legal name appears anywhere.
- **English first.** The English content and structure are written and locked before any Korean.
- **Korean second.** It is drafted from the locked English. Every Korean line goes to Ori for review before it ships, per the project's copy rule.
- **One file for both.** Both languages live in one HTML file, with a language toggle, so the two versions cannot drift apart structurally.
  - Each slide carries both languages.
  - The toggle switches which one is shown.
  - The `lang` attribute follows the shown language.

## Format and location

- **Source.** `docs/deck/index.html`, merged through a PR like any other change.
- **Self-contained.** It has no build step and no framework. Its only external fetches are the ones the Artifact contract allows: fonts and pinned CDN scripts.
- **Images.** It reuses screenshots already committed under `docs/evidence/wave-6/`. They are referenced in the repo by relative path, and they are published as Artifact supporting files.
- **Published.** As a private Artifact. Ori decides whether to share the link.

## Look and accessibility

- **Clip's own design system.**
  - The values in `tokens.css`, dark theme.
  - Monospace only for machine values: commands, codes, ids, shas.
  - No shadows, gradients, blur, or animation beyond a 120ms hover colour transition.
  - 2px radius and 1px borders.
- **`--faint` is for disabled controls only.** All readable text uses `--muted` or stronger, the same rule as the product.
- **Navigation.** Arrow keys and Page Up/Down move between slides, and Home/End jump to the first and last. Each slide is a `<section>` with a heading. Visible previous/next buttons are real `<button>`s. A slide counter shows the position.
- **Images.** Every screenshot has alt text, in both languages.
- **Phone width.** The deck reads on a phone: slides reflow, with no horizontal scroll and a 16px gutter.
- **Product copy.** None of the product's Korean UI strings are paraphrased. A screenshot shows them as they are.

## Slides

Each slide lists its point, its content and its sources. Every number carries its date and commit. Every claim must be traceable to a listed source.

1. **Title.**
   - "Clip — deliberate community memory for Discord."
   - `cgm-16` with the GitHub link.
   - The date of the deck.
2. **Problem.**
   - Discord pins are channel-bound, capped at 250 per channel, and managed by moderators.
   - The originating incident: a community deleted old pins to make room for new ones.
   - The real gap: there is no low-friction way to say "keep this for us".
   - Source: README "문제".
3. **Positioning.**
   - A condensed table: pin / bookmark / Starboard / Clip, and what each one means.
   - The niche: deliberate community memory.
   - Source: README "포지셔닝".
4. **How it works.**
   - Right-click a message, then Apps → Clip.
   - The archive entry is two messages, a provenance line followed by the forward. This is because a forward cannot carry content (`160011`) and its snapshot omits the author.
   - The author gets a DM with a remove button.
   - Image: `p2-archive.png`.
   - Sources: README "핵심 흐름", CLAUDE.md "Discord API constraints".
5. **The core decision.**
   - Discord is authoritative for content.
   - Postgres holds only control state: configuration, Clip identity and state, clippers, tombstones, tokens and sessions.
   - No message bodies, attachments or embeds are stored.
   - Deleting Clip's data leaves the Discord archive intact.
   - A small diagram, built in HTML/CSS or inline SVG, not an image.
   - Source: README "소유권 경계".
6. **Setup and the web archive.**
   - Screen B, the setup screen.
   - Screen D, the read-only archive.
   - Images: `p6-form.png`, `burst-screen-d.png`.
   - Source: README "무엇이 만들어졌는가".
7. **The hard parts.**
   - One canonical Clip per `(guild, source message)`, enforced by DB uniqueness and row locks, not by check-then-insert.
   - Author or admin removal leaves a tombstone that blocks re-clipping.
   - Never `ACTIVE` with a partial archive.
   - Platform facts verified against Discord's docs before building on them: `160011`, no `author` in snapshots, the forwardable message types.
   - Sources: CLAUDE.md invariants, product spec.
8. **A decision under a deadline.**
   - On 2026-08-20, 23 hours before the deadline, I computed the remaining work against the project's own measured velocity and cut the web archive. That was a decision made with the arithmetic in front of me, not drift.
   - It shipped on 2026-10-09 (PR #61).
   - On 2026-10-14 the restoration's e2e gate passed 8/8 on `sha-b845a59`.
   - Sources: README "무엇이 만들어졌는가", the journal for 2026-10-14.
9. **How it was built.**
   - Claude Code is the implementer.
   - I hold product and architecture judgement.
   - Every PR gets an independent review.
   - TDD, with the RED recorded.
   - The recurring failure shape: rigorous verification aimed one step beside the claim, caught each time by someone who did not write it.
   - Two concrete cases, each told as what happened → how it was caught → what changed:
     - **Forward-API finding.** An AI-authored plan assumed a forward could carry its own provenance. A documentation check (`160011`) caught it before any implementation cost. That is why each entry is two messages. Source: `docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md` (around line 567).
     - **`deploy.sh` revision race.** A reviewed, tested fix pinned the rollout to a revision read too early under `Recreate`. It failed on its first real run (`desired revision (12) is different from the running revision (13)`). The deploy itself was healthy. The fix verifies by generation instead. Source: journal 2026-10-14, PR #97.
10. **Proof it ships.** All of these are stamped 2026-10-14:
    - self-hosted on k3s behind Traefik, `sha-3ed1d60`;
    - 49 files / 706 tests against real PostgreSQL, on `main`;
    - Playwright 8/8 against production;
    - the permission matrix measured one permission at a time, with logged codes `50001` and `160014`;
    - idle use of 3m CPU / 88Mi;
    - a cost of USD 8/yr for the domain, with the honest note that the existing cluster absorbs electricity, hardware and operator time.
    - Sources: README, `docs/evidence/wave-6/RESULTS.md`, journal.
11. **Try it.**
    - The invite link, labelled: a demo hosted on a home server, for test servers, with no uptime promise.
    - The repository link.
    - MIT licence.

Every figure is re-checked against the repo at build time. If a figure has moved since this spec, the deck uses the current value with its new date, never the stale one.

## Process

- **Issue.** The deck has its own GitHub issue, linking this spec.
- **Branch.** `wave/7-pitch-deck`.
- **Before the PR.** One independent review that fact-checks every claim against its source, and checks the design rules and keyboard navigation.
- **Korean pass.** The Korean version is a separate step after the English is locked, reviewed by Ori line by line, and it may be a separate PR.
- **Verification.**
  - Open the deck in a browser at desktop and phone widths.
  - Walk it with the keyboard only.
  - Check the language toggle.
  - Check the design rules: tokens only, no `--faint` text.

## Out of scope

- Investor or market slides.
- Speaker notes.
- A live demo embed.
- Edits to the frozen `docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md`.
- Rewording README line 103. Ori chose to keep it.
