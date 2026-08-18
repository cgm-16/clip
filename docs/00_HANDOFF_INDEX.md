# Clip — Sweetbook Project Test Handoff Index

**Status:** Product/behavior architecture approved; visual design and implementation not yet executed in this conversation.  
**Snapshot date:** 2026-08-18 KST  
**Assignment deadline:** 2026-08-20 23:59 KST  
**Working product name:** `Clip` (provisional; naming/branding may change without changing product semantics)

## Purpose of this handoff

This package preserves the decisions, rejected alternatives, architecture, MVP boundaries, deployment assumptions, and assignment-answer evidence accumulated during product discovery. It is designed to be handed to separate implementation and design agents without forcing them to reconstruct the preceding conversation.

The implementation and design agents should **append factual outcomes** to the cumulative snapshot rather than rewriting the planning history. A later model can then generate the final four Korean assignment answers from one evidence base.

## Files

1. [`01_CLIP_PRODUCT_SPEC.md`](./01_CLIP_PRODUCT_SPEC.md)  
   Approved product behavior, P0/P1 scope, trust model, architecture, data model, state/concurrency semantics, failure handling, deployment and operational constraints.

2. [`02_CLIP_IMPLEMENTATION_PLAN.md`](./02_CLIP_IMPLEMENTATION_PLAN.md)  
   Repo-ready task plan with dependency waves, suggested file boundaries, tests, deployment-first sequencing, verification gates, and submission artifacts.

3. [`03_CLIP_RESEARCH_DECISION_LOG.md`](./03_CLIP_RESEARCH_DECISION_LOG.md)  
   Why Clip was selected, Sweetbook strategic context, competitor attacks, alternatives considered, and major reversals in the reasoning process.

4. [`04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md`](./04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md)  
   Append-only evidence document organized around the four assignment questions. This is the main file that implementation/design agents should update with real outcomes, AI prompts, accepted/rejected suggestions, failures, tests, and metrics.

5. [`05_DESIGN_AGENT_BRIEF.md`](./05_DESIGN_AGENT_BRIEF.md)  
   Functional screens, UX invariants, state inventory, and scope constraints for a separate visual/design-system pass. It intentionally does not prescribe a finished visual style.

## Read order by role

### Implementation agent

Read in this order:

1. `01_CLIP_PRODUCT_SPEC.md`
2. `02_CLIP_IMPLEMENTATION_PLAN.md`
3. `04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md`
4. `03_CLIP_RESEARCH_DECISION_LOG.md` only when product rationale is needed

Before coding, record the actual repository/stack choices in the cumulative snapshot if they differ from the plan. During implementation, append evidence after meaningful milestones rather than waiting until the end.

### Design agent

Read:

1. `01_CLIP_PRODUCT_SPEC.md`
2. `05_DESIGN_AGENT_BRIEF.md`
3. `04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md`

Append design rationale, discarded alternatives, and any usability-driven scope changes to the cumulative snapshot.

### Final assignment-answer agent

Read:

1. `04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md`
2. `03_CLIP_RESEARCH_DECISION_LOG.md`
3. implementation/design outcomes from the first two files if needed

Do **not** claim planned behavior as implemented behavior unless the cumulative snapshot contains implementation evidence.

## Non-negotiable product thesis

> Clip lets authorized Discord community members deliberately preserve a message into a server-owned shared archive with approximately the effort of pinning it, without consuming a Discord pin or requiring moderator-level pin permission.

The niche is **not** “unlimited pins.” Existing pin archivers already do that. The intended position is **shared intentional memory**:

- Discord Pin: a moderator says this is important for this channel.
- Personal Bookmark: I want this for myself later.
- Starboard: enough people liked this.
- **Clip: an authorized member says this is worth preserving for the community.**

## Non-negotiable P0 architecture thesis

> Discord is authoritative for archived content. PostgreSQL is authoritative for Clip's product/control state.

The application stores identifiers, decisions, permissions, state-machine information, tombstones, and notification state. It does **not** persist copies of message bodies or attachments.

## Scope discipline

P0 is intentionally not:

- a Discord logging/crawling bot;
- a Starboard clone;
- a searchable Discord replacement;
- an AI summarizer;
- a publishing/photobook product;
- a hosted copy of Discord data;
- a full multi-user SaaS dashboard.

Those exclusions are part of the assignment answer, not deficiencies to hide.

## Deployment memo

Deployment is part of P0 and should happen early enough to test against the real Discord interaction endpoint.

Target environment currently available:

- Intel N100 home server
- 16 GB RAM
- observed CPU load around 1.6 during planning
- observed memory utilization around 5% during planning
- k3s
- existing PostgreSQL cluster
- existing Traefik ingress
- existing web workloads

P0 does not require a persistent Discord Gateway worker. Explicit HTTP interactions can be delivered to the web/API endpoint. A future Gateway worker belongs in P1 if ambient reaction/message/channel events become product inputs.

Self-hosting is not economically “free.” Document domain registration/renewal and, where relevant, electricity/network/hardware/operator costs. Incremental compute is absorbed by existing hardware for this test.

## Source anchors

Primary product/company sources consulted during discovery:

- Sweetbook: https://www.sweetbook.com/main
- AI Story Class: https://storyclass.ai/
- Sweetbook Book Print API: https://api.sweetbook.com/
- Sweetbook Book Print API AI-agent docs: https://api.sweetbook.com/docs/ai-agents/overview/
- Discord developer docs: https://docs.discord.com/developers/
- Discord pin FAQ: https://support.discord.com/hc/en-us/articles/221421867-Pin-Messages-FAQ

The user-provided Sweetbook recruitment page states that experience with AI-assisted/vibe coding and web development is required; REST API integration and B2B/platform/SaaS experience are preferred. The project email additionally states that planning/requirements definition and implementation are weighted similarly and that unimplemented areas may be represented through planning/design/mockups.
