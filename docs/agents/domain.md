# Domain docs

## Before exploring the domain

This repo uses a single-context layout:

- Read root `CONTEXT.md` for domain terms.
- Read relevant decisions in `docs/adr/`.
- Continue to use `docs/01_CLIP_PRODUCT_SPEC.md` for settled product semantics and `docs/03_CLIP_RESEARCH_DECISION_LOG.md` for existing rationale. Domain docs supplement these sources.

If `CONTEXT.md` or `docs/adr/` is absent, proceed silently. Do not suggest creating them upfront. The `domain-modeling` skill creates them lazily when terms or decisions are resolved.

## Layout

```text
CONTEXT.md
docs/adr/
  0001-<decision>.md
```

## Vocabulary and decisions

Use the glossary's terms in issue titles, proposals, hypotheses, and test names. If a concept is missing, reconsider invented terminology or note the gap for `domain-modeling`.

If a proposal contradicts an existing ADR, identify the ADR and explain why reopening it may be warranted. Preserve settled product semantics unless Ori authorizes a change.
