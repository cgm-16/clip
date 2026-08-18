## What

<!-- One or two sentences. Which wave and which DAG tasks does this close? -->

Closes #

## Spec basis

<!-- Which sections of docs/01_CLIP_PRODUCT_SPEC.md or docs/06_DESIGN_HANDOFF.md govern this? -->

## Verification

<!-- Evidence, not intent. Paste output or say what you observed. -->

- [ ] `pnpm lint` / `pnpm test` / `pnpm build` pass
- [ ] Tests written before implementation
- [ ] Verified against a real Discord guild or deployment (say which, or N/A)

## Invariants

- [ ] No raw message bodies or attachments persisted to Postgres or logs
- [ ] No new Korean strings invented; copy taken from `docs/06_DESIGN_HANDOFF.md`
- [ ] No ad-hoc hex codes or off-scale spacing; `tokens.css` only
- [ ] Concurrency invariants unchanged, or tests prove the new behavior

## Records

- [ ] `docs/journal/journal-2026-08.md` updated with anything learned the hard way
- [ ] `docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md` appended (once per wave, or immediately on an AI failure)
- [ ] `docs/DESIGN_RATIONALE_APPEND.md` appended if a visual or copy change was forced
