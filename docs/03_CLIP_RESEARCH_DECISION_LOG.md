# Clip — Research and Decision Log

**Purpose:** Preserve the actual product-discovery path, including ideas that were rejected after competitor research. This document is useful for the assignment question asking how the service planning took shape rather than requesting a polished post-hoc plan.

---

## 1. Starting company thesis: Sweetbook's strategic position

The research started from the mistaken/loose frame of “traditional publisher looking for a niche.” Public evidence suggested a more precise description:

- Sweetbook historically developed photo-related software and vertically integrated into photobooks/digital print/POD.
- The company operates/has operated real digital print production equipment and an automated production flow.
- AI Story Class is a vertical service where Sweetbook participates in both content creation software and physical output.
- Book Print API reverses that relationship: third-party services keep their users/content, while Sweetbook exposes print/manufacturing/fulfillment as B2B infrastructure.

Working strategic inference:

> Sweetbook is productizing a physical production capability through software/platform layers rather than trying to compete as a conventional trade publisher for authors/IP/bookstore shelf space.

This made “content reservoir -> structured/curated artifact -> optional physical output” a useful pattern for product ideation, while the assignment email explicitly allowed topics unrelated to books/printing.

### Why this mattered

The project should not be a superficial “book app because Sweetbook prints books.” A stronger fit would demonstrate:

- independent product definition;
- content lifecycle;
- REST/API thinking;
- B2B/platform/SaaS awareness;
- operational state/failure judgment;
- an AI-assisted development process where the human retains product/architecture judgment.

---

## 2. Market/domain exploration

Multiple latent-content domains were considered:

- developer/GitHub history;
- education/classroom;
- travel/lifelog;
- family memories/oral history;
- creator/newsletter archives;
- sports seasons;
- food/cooking memories;
- clubs/teams;
- gaming communities;
- conferences/events;
- online communities/chat;
- professional portfolios/company history.

The research criterion was not “is there no competitor?” It was closer to:

> Which adjacent products validate demand, but leave a clean job-to-be-done or strategic quadrant unowned?

---

## 3. Candidate 1 — Repo Chronicle / project retrospective publishing

### Initial concept

GitHub repo history -> meaningful events -> editable retrospective -> web/PDF/optional physical project book.

Initial strength:

- strong REST integration;
- authentic developer-domain fit;
- content-service framing;
- potential “structured activity -> artifact” connection to Sweetbook.

### Competitor attack 1

Direct/adjacent products found:

- Commit Story — repo history into an interactive story/timeline;
- wrapped.dev / GitHub Unwrapped — GitHub year/repo recap;
- GitRoll/GitHubFolio — GitHub data into professional artifacts;
- Repo Visualizer/GitStock — repository evolution/activity visualization;
- GitHub Skyline — developer history into a physicalizable 3D artifact.

This invalidated the broad pitch “turn GitHub history into a story.”

### Reposition attempt

The concept narrowed to “evidence-backed, human-curated project retrospective.”

### Competitor attack 2

README/changelog automation already solves large portions of the remaining job:

- github-activity-readme;
- lowlighter/metrics;
- all-contributors;
- GitHub generated release notes;
- Release Drafter;
- semantic-release;
- AI README generation.

### Decision

**Parked, not rejected.** The remaining niche — episodic human-curated project retrospective publishing — is plausible but increasingly requires explanation of why it is not existing GitHub/README tooling.

### Lesson

A product idea can remain technically good while becoming strategically weaker as its core job is decomposed into already-commoditized sub-jobs.

---

## 4. Candidate 2 — Conference Afterbook

### Initial concept

Import structured event data (Sessionize connector first), enrich it with attendee/session context, and produce a finished post-event publication.

### Sessionize finding

Sessionize is meaningful in developer/community CFP/scheduling, including Korean developer/open-source events, but is not the general Korean event-platform incumbent. Korean general event platforms such as Event-us/OnOffMix have broader local reach/workflows.

This changed the architecture from “Sessionize Afterbook” to “source-agnostic event publication, Sessionize connector #1.”

### Competitor attack

Adjacent jobs were already occupied:

- PheedLoop — post-event operational/ROI reports;
- Conference AI/Joditap — session transcription/summarization/repurposing;
- Ownstory/MemorySnap — attendee-contributed event recaps/memories;
- Ex Ordo — formal proceedings/book-of-abstracts publication.

Remaining whitespace existed at “experiential + editorial + durable publication,” but was narrower than first assumed.

### Decision

**Viable fallback.** Strong B2B/API demonstration, but weaker evidence of urgent pain and more fragmented adjacent competition.

---

## 5. Candidate 3 — Community Issue -> Clip

### Initial concept

A recurring community publication where members submit moments/stories and an editor creates an issue.

### User correction

The more interesting primitive was not the issue. It was capture:

> A Discord bot that lets someone “clip” a message — analogous to a streaming clip — into an external/shared repository.

The user had a direct historical pain point: the community had hit Discord pin limits and deleted older pins to make room.

This changed the product from “publication CMS” to “create the curated content reservoir; downstream use is not P0.”

---

## 6. Storage idea evolution

### First thought

Host clipped content externally.

Concern:

- storage/infra scaling;
- data responsibility;
- privacy;
- duplicating Discord content.

### Better idea

Create/select a dedicated Discord archive channel, initially private/admin-only. `Clip` forwards/snapshots the selected message into that channel with provenance metadata.

Advantages:

- Discord remains content storage;
- community controls archive inside its guild;
- no media/object-storage cost;
- bot can provide semantics/indexing without becoming a bulk archive provider.

### Later correction

The DB was initially described as almost disposable/rebuildable from Discord. Once the design accepted a real PostgreSQL-backed service, this became an unnecessary constraint.

Current boundary:

> Discord = content authority. PostgreSQL = product/control authority.

Postgres must durably retain clipper signals, tombstones, configuration, state machine and notification/idempotency state because these cannot be faithfully reconstructed from archive content alone.

---

## 7. Competitor attack on Clip

Direct/adjacent products found:

### Discord pins

Native, channel-local, moderator-oriented, currently bounded at 250 per channel/DM.

### Personal bookmarks

Private individual retrieval/read-later behavior.

### Starboard

Very large category; reaction/popularity threshold copies notable messages into a shared channel. Validates desire to preserve notable messages, but semantics are democratic popularity rather than intentional archival authority.

### Pin Archiver / ArchBot / pinee

Very close to “move/copy pins to an archive channel,” invalidating the pitch “unlimited pin overflow.”

### DiscordLogs / bulk exporters

Capture many/all messages into external archive/search/export; opposite philosophy from selective human-first capture.

### Discord -> Notion/Obsidian workflows

Validate moving selected content into knowledge repositories, but typically require adopting external storage/knowledge tooling.

### Surviving niche

> Permitted member explicitly preserves one visible message into a server-owned shared archive, without first pinning it, without a popularity threshold, and without bulk-ingesting the conversation.

This is “shared intentional memory.”

---

## 8. Why Clip won

Compared with Afterbook/Repo Chronicle, Clip had:

1. **Direct experienced pain.** The user had actually deleted old pins due to limits.
2. **A very small capture primitive.** One message context action.
3. **A defensible semantic niche.** Not moderator pin, personal bookmark, democratic Starboard, pin-overflow archiver, or bulk logger.
4. **Clear product judgment surface.** Consent, immutable snapshots, author removal, permissions, concurrency, storage ownership, failure semantics.
5. **Low P0 infrastructure/content cost.** Discord stores content; Postgres stores control metadata.
6. **Natural REST/platform engineering.** Discord interactions/REST plus a web admin/archive surface.
7. **Good scope under deadline.** No AI/search/publication needed for the service to operate.
8. **Structural Sweetbook relevance without cosplay.** It creates a curated content reservoir that can later feed recaps/publications/physical output, but P0 is useful independently.

---

## 9. Major approved design reversals

These reversals are useful evidence for assignment Q1/Q4 because they show the planning did not simply follow the first AI proposal.

### Reversal A — company framing

**Before:** “traditional publisher pivoting into niche.”  
**After:** vertically integrated digital-print/POD company productizing manufacturing through software/API layers.

### Reversal B — first project choice

**Before:** Repo Chronicle looked strongest.  
**After:** direct story/README/changelog competition narrowed it enough to park it.

### Reversal C — Community Issue output

**Before:** editorial issue/publication was P0.  
**After:** capture/repository is P0; publication is downstream.

### Reversal D — pin-overflow positioning

**Before:** solve Discord pin limit.  
**After:** pin limit is triggering anecdote; product niche is shared intentional memory because pin archivers already solve overflow.

### Reversal E — disposable DB

**Before:** try to make DB a rebuildable cache/index.  
**After:** durable Postgres control plane is cleaner once infrastructure is accepted; only content remains in Discord.

### Reversal F — traditional always-on bot assumption

**Before:** assume a long-lived Discord Gateway bot process is mandatory.  
**After:** P0 explicit context commands/buttons can use Discord HTTP interactions; Gateway is P1 only if ambient reaction/channel events become inputs.

---

## 10. Approved P0 vs P1 decision ledger

| Area | P0 | P1 / later | Why |
|---|---|---|---|
| Capture | Message context `Clip` | reaction shortcut/modes | Preserve explicit intentional semantics |
| Target scope | selected message only | parent/thread/multi-message | Avoid consent/scope expansion |
| Archive storage | Discord channel | same | Avoid hosting media/content |
| Control state | PostgreSQL | same + reconciliation | Needed for correctness |
| Visibility | private archive by default | permission-aware routing | Permission graph too complex for P0 |
| Clip authorization | admin + configured roles | channel denylist etc. | Simple trust boundary |
| Author consent | notify + remove after capture | preemptive opt-out | Avoid user settings plane in P0 |
| Marker | bot reaction status only | endorsement/clip experiments | Avoid Starboard semantics |
| Web access | short admin session | Discord OAuth/member access | Avoid auth/account scope |
| Archive UI | chronological + channel filter + pagination | search/tags/collections | Avoid persistent content index |
| Content fetch | live Discord REST | short-lived cache | Cheapest correct path first |
| AI | none | clustering/recap after corpus exists | Human significance first |
| Publication/print | none | recap/PDF/Book Print API | Downstream use, not core validation |
| Gateway worker | none | ambient event worker | HTTP interactions sufficient for P0 |
| Reconciliation | manual/basic recovery | automated DB↔Discord repair | P0 can define semantics without building ops system |

---

## 11. Useful source list for future research checks

Sweetbook / publishing:

- https://www.sweetbook.com/main
- https://storyclass.ai/
- https://api.sweetbook.com/
- https://api.sweetbook.com/case-studies/
- https://api.sweetbook.com/docs/ai-agents/overview/

Discord:

- https://docs.discord.com/developers/
- https://support.discord.com/hc/en-us/articles/221421867-Pin-Messages-FAQ

Competitive categories referenced during discovery:

- Commit Story / GitHub story tools
- wrapped.dev / GitHub Unwrapped
- lowlighter/metrics, all-contributors, Release Drafter, semantic-release
- Sessionize, Event-us, OnOffMix
- PheedLoop, Conference AI, Ownstory, Ex Ordo
- Starboard, Pin Archiver, DiscordLogs, personal bookmark bots

Future final-answer writer should verify any exact live counts/prices/limits if used in the submission; strategic reasoning is more important than quoting volatile numbers.
