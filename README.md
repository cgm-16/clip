# Clip

**An authorized Discord member deliberately preserves one message into a server-owned archive — with roughly the effort of pinning it.**

Discord keeps the archived content. Clip's database keeps only the control state needed to operate the archive correctly.

> **Status: P0 shipped in reduced scope, deployed and live.** The Discord path — setup, Clip, Unclip, author/admin removal — is built, tested and running at `https://clipendpoint.cc`. The read-only web archive (Wave 5) was deliberately cut against the 2026-08-20 deadline. [What is built](#what-is-built) states exactly what exists, what was cut and by whose decision; [docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md](docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md) is the append-only evidence log behind every claim here.

---

## The problem

Discord pins are a bounded, channel-local shortlist managed through moderation permissions. The current limit is 250 pins per channel. The motivating incident was concrete: a community had to delete historical pins to make room for new ones.

But pin count is the symptom. The real gap is that communities have no low-friction primitive for saying:

> *"This message is worth preserving for us."*

## Positioning

Clip is not an unlimited-pin utility and not a Starboard. Each neighboring primitive already means something specific:

| Primitive | What it means |
|---|---|
| Discord Pin | A moderator says this is important **for this channel** |
| Personal bookmark | An individual says **I** want this later |
| Starboard | **Enough people** liked this |
| Pin archiver | These were **already pinned** and overflowed |
| Bulk logger/exporter | **Capture everything**, filter later |
| **Clip** | **An authorized member says this is worth preserving for the community** |

The niche is *shared intentional memory*: one visible message, preserved on purpose, without first pinning it, without a popularity threshold, and without bulk-ingesting the conversation.

## Core loop

```
Admin runs /setup in Discord
  → ephemeral one-time link (15 min)
  → web: choose archive channel
  → done

Member right-clicks a message → Apps → Clip
  → provenance + forwarded snapshot posted to the archive channel
  → 📎 marker added to the source message
  → author receives a best-effort DM with a "remove" action

Author or admin → Apps → Remove from Clip Archive
  → archive deleted, tombstone retained, recreation blocked
```

## Architecture

A single stateless Next.js deployable serves both the Discord interaction endpoint and the admin web UI. There is no persistent Gateway worker in P0 — every product input is an explicit command or button, which HTTP interactions deliver.

```mermaid
flowchart LR
  D[Discord<br/>HTTP interactions] --> A
  B[Browser<br/>admin setup] --> A
  A[Next.js web/API<br/>stateless] --> P[(PostgreSQL<br/>control plane)]
  A --> R[Discord REST API<br/>content plane]
```

### The ownership boundary

This is the central architectural decision:

| Discord is authoritative for | PostgreSQL is authoritative for |
|---|---|
| Archived message body | Guild configuration and allowed roles |
| Embeds, attachments, media | Clip identity and state machine |
| Snapshot rendering | Per-user preservation signals |
| User/channel display details | Author/admin removal tombstones |
| | Notification and idempotency state |
| | Admin setup tokens and sessions |

Clip **does not** persist raw message bodies, attachment binaries, embed payloads, avatars, a search corpus, or embeddings.

Deleting Clip's data for a guild deletes Clip's control state and leaves the Discord archive channel and every message in it untouched. Our service data disappearing must never destroy community-owned content.

## What is built

Verified against the source tree at `main`, not against the issue tracker — several issues for merged work are still open, and an open issue is evidence about who last edited the tracker, not about the world.

| Capability | State |
|---|---|
| Deployment on k3s behind Traefik, HTTPS, CloudNativePG | **Shipped** — pod and migration initContainer both on `ghcr.io/cgm-16/clip:sha-7109e3d`, the `main` HEAD commit |
| Discord interaction endpoint (Ed25519 verification, PING) | **Shipped** — Discord holds `https://clipendpoint.cc/api/discord/interactions`, which it only accepts after a successful signed PING |
| `/setup` slash command → one-time 15-minute admin link | **Shipped** |
| Context commands `Clip`, `Unclip`, `Remove from Clip Archive` | **Shipped** — all four commands registered to the test guild |
| Two-message archive entry (provenance + forward) | **Shipped** |
| 📎 source marker, best-effort author DM with a remove button | **Shipped** |
| Clip state machine, row locking, tombstones, idempotency | **Shipped** — unit-tested against a real PostgreSQL |
| Design system: tokens, Korean string table, UI primitives | **Shipped** (`F.1`–`F.3`) |
| Setup web flow: expired link, destination, complete (Screens A/B/C) | **Shipped** (`4.0`, `4.1`, `4.2`, `4.4`) |
| **Read-only web archive (Screens D/E)** | **Cut** — `5.1`–`5.4`, decision recorded 2026-08-20 01:05 KST |
| **Role configuration UI** | **Cut** — `4.3`; the spec already allows admin-only clipping, which is what ships |
| **Playwright end-to-end; exhaustive a11y sweep** | **Cut** — `6.4`, `7.1` |
| Permission matrix on a fresh guild; integrated race pass; 17-scenario manual suite | **Not done** — `6.1`, `6.2`, `6.3`. Neither cut nor completed; see below |
| CI guard for token/string-table discipline | **Not done** — `F.6` |

**The cuts were a human decision, not a drift.** With 23 hours left, the remaining graph was measured against the project's own recorded pace (Wave 1 ≈ 6h, Wave 2 ≈ 10h) and the arithmetic put to Ori rather than absorbed. He chose to protect the Discord path plus the minimum setup UI. Wave 5 is the cut that costs a real capability: it is P0 item 11 in the spec, and it is beyond what the DAG's own cut order covers. It is browsing of an archive that Discord itself already displays, so losing it loses convenience rather than the product — but it is a genuine reduction of approved scope, recorded as one.

**`6.1`–`6.3` are the residual, and they are the honest weak point.** They were neither protected nor cut; the clock reached them last. Their absence bounds what the test suite proves: see below.

### What the tests do and do not cover

`pnpm test` is **345 tests across 30 files, all green** against a real PostgreSQL 17 (concurrency invariants are never mocked here). Commands, run from a clean checkout with the container up:

```bash
docker run -d --name clip-pg -p 5433:5432 \
  -e POSTGRES_USER=clip -e POSTGRES_PASSWORD=clip -e POSTGRES_DB=clip_dev postgres:17-alpine
DATABASE_URL='postgresql://clip:clip@localhost:5433/clip_dev' pnpm prisma migrate deploy
pnpm test
```

What that number does **not** cover, stated plainly because an unqualified green count is the exact failure this project kept recording:

- **No end-to-end run in a live guild.** The 17-scenario manual suite (`6.3`) was not executed. The Discord path is covered by unit and route tests against a fake gateway and a real database; the endpoint is live and the commands are registered, but no archived message was observed being created by a human in Discord as part of a recorded suite.
- **No browser end-to-end.** Playwright (`6.4`) was cut. The setup screens are covered by React Testing Library against jsdom.
- **No measured permission matrix.** The table below is the *assumed* minimum set, derived from the API's documented errors, not a set validated by revoking permissions on a fresh guild (`6.1`).

Several of these tests exist because a mutation proved the previous version of them could not fail. That method, and the four times it caught a false green, is the substance of [the evidence log](docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md).

## P0 scope

**In**, because the service cannot operate correctly without it: admin setup and archive destination; role-gated clipping; exactly one selected message per clip; canonical deduplication with multiple preservation signals; unclip; author/admin removal with durable tombstones; concurrency and idempotency invariants; private archive by default; best-effort author DM plus a source marker; a minimal Postgres control plane; a read-only admin web archive; and real deployment.

Everything in that list ships except **the read-only admin web archive**, which was cut under deadline as described above. The scope statement is left standing rather than edited to match what happened — the divergence is the record.

**Deferred**, with reasons, in [docs/01_CLIP_PRODUCT_SPEC.md §21](docs/01_CLIP_PRODUCT_SPEC.md) and the ledger in [docs/03_CLIP_RESEARCH_DECISION_LOG.md §10](docs/03_CLIP_RESEARCH_DECISION_LOG.md): AI summarization, publishing/print, full-text search, tags and collections, thread/parent clipping, reaction-driven clipping, preemptive opt-out, per-channel denylists, permission-aware routing, member OAuth, content caching, a Gateway worker, and automated reconciliation.

The cuts are part of the answer, not gaps to hide.

## Discord permissions

Clip never requests `Administrator`. Verified against the live application: the bot holds `VIEW_CHANNEL`, `SEND_MESSAGES` and `MANAGE_CHANNELS`, and not `ADMINISTRATOR`.

| Permission | Why | When |
|---|---|---|
| `VIEW_CHANNEL` on source channels | Discord refuses to forward a message the application cannot read (error `160014`) | Steady state |
| `VIEW_CHANNEL` + `SEND_MESSAGES` on the archive channel | Post provenance and the forwarded snapshot | Steady state |
| `MANAGE_MESSAGES` on the archive channel | Delete an archive entry on unclip or removal | Steady state |
| `ADD_REACTIONS` | The bot-owned 📎 marker on the source message | Steady state |
| `MANAGE_CHANNELS` | Only to auto-create the private archive channel | Bootstrap only — revocable afterwards |

This is the **assumed** minimum, derived from Discord's documented error cases. Task `6.1` — revoking each one on a fresh guild and recording what actually breaks — was not run, so no entry in this table has been falsified by experiment. One of them nearly went out wrong: the auto-created private channel originally denied `VIEW_CHANNEL` to `@everyone` without granting it back to the bot, which would have made the recommended default destination invisible to the application that created it. That was caught in review, and a test now fails if either overwrite is removed.

## Privacy and data behavior

- Clipping is restricted to guild admins and explicitly configured roles. **In P0 as shipped, only guild admins can clip**, because the role configuration UI (`4.3`) was cut — the spec allows this and the domain layer supports configured roles once a UI exists to set them.
- A newly created archive is private by default
- Only human-selected messages are touched; there is no bulk monitoring
- Message content is never copied into Clip's database
- The original author is notified on first archival and can remove their own archived message, independently of whether the DM was delivered
- Removal leaves a tombstone that blocks immediate recreation, so an author cannot be re-clipped in a loop
- Operational logs record identifiers and state transitions, never message bodies or attachments

We do not claim to store no user data. Clip stores Discord IDs, role configuration, preservation signals and operational metadata.

## Known limitations

- **The 📎 marker count is not a metric.** Users can add the same reaction; Clip ignores those. The count is never surfaced, and removing an archive cannot remove reactions other users added.
- **Forwarding constrains what can be clipped.** Discord only forwards `DEFAULT`, `REPLY`, `CHAT_INPUT_COMMAND` and `CONTEXT_MENU_COMMAND` messages — polls, calls and system messages are rejected as invalid targets.
- **A forward cannot carry its own provenance.** Discord rejects `content` sent alongside a forward (error `160011`) and omits `author` from the snapshot, so each archive entry is two messages: a provenance line, then the forward.
- **Snapshots are immutable.** Editing the original does not update the archive; deleting the original does not delete the archive.
- **The archive can drift**, and in P0 nothing surfaces the drift. If someone manually deletes an archive message in Discord, the control row survives; the `누락` state exists in the string table and the spec, but the screen that would render it was cut. Automated reconciliation was already P1.
- **There is no web archive in P0.** Members and admins read the archive in Discord, in the archive channel itself.
- **Reconfiguring the archive destination is refused while live Clips exist.** This is deliberate — per-Clip archive-channel storage is the real fix and is out of P0 scope — but it means an admin who picks the wrong channel must delete the guild's Clip data to change it.

## Deployment

Self-hosted on an existing home k3s cluster (Intel N100, 16 GB) behind Traefik, against a CloudNativePG PostgreSQL cluster in the same namespace. Deployment was P0 work and happened before the product was built, not after — the Discord interaction endpoint has to be verified against real HTTPS early, and gate `0.3b` (Discord accepting the endpoint URL) blocked everything downstream of it.

Observed state at 2026-08-20 22:15 KST:

| | |
|---|---|
| Application pod | `clip-7d9bc9889-vmdgs`, `Running`, image `ghcr.io/cgm-16/clip:sha-7109e3d` |
| Migration initContainer | same image — the two are bumped together, never one alone |
| Database | `clip-db-1`, CloudNativePG, `Running` |
| TLS | cert-manager certificate `clip-tls`, `READY True` |
| Health | `curl https://clipendpoint.cc/api/health` → `200 {"ok":true}` |

`k8s/deployment.yaml` carries `__CLIP_RELEASE_IMAGE__` as a placeholder and is rendered by `scripts/render-k8s-deployment.sh` with an explicit tag. It is a template rather than a checked-in pin because the checked-in pin went stale and named an image without the migration stage — applying it would have crash-looped the service. Verification of the rendered manifest is a test (`tests/scripts/render-k8s-deployment.test.ts`), not a `grep` that only prints.

Self-hosting is not free. The honest accounting:

| Cost | Amount | Note |
|---|---|---|
| Domain `clipendpoint.cc` | **USD 8 / year** | Registered via Cloudflare. The one genuinely new recurring cost. |
| Incremental compute | ~0 marginal cash | Absorbed by an existing cluster. Not free — merely already paid for. The node is shared with co-tenant workloads. |
| Electricity, network, hardware depreciation | not itemized | Real costs the household absorbs. Treated as sunk for this project rather than claimed as zero. |
| Operator effort | not itemized | The largest real cost of self-hosting, and the one most often omitted. |

Resource usage under load was not measured; there was no load. An earlier claim in this file about the node's load average was withdrawn because it could not be reproduced — that retraction is entry `[2026-08-19 05:30 KST]` in the evidence log and is deliberately kept.

## Development

Requires Node 24+, pnpm, Docker, and a PostgreSQL instance.

```bash
pnpm install
cp .env.example .env          # fill in Discord credentials and DATABASE_URL

# Local PostgreSQL on :5433 — the port tests/setup/database-url.ts defaults to.
docker run -d --name clip-pg -p 5433:5432 \
  -e POSTGRES_USER=clip -e POSTGRES_PASSWORD=clip -e POSTGRES_DB=clip_dev \
  postgres:17-alpine

export DATABASE_URL='postgresql://clip:clip@localhost:5433/clip_dev'
pnpm prisma generate
pnpm prisma migrate deploy
pnpm dev
```

`DATABASE_URL` has to be in the shell, not only in `.env`: Prisma 7 reads the datasource from `prisma.config.ts` at CLI time and that file resolves the variable from the environment. Runtime code goes through `parseEnv` in `lib/env.ts` instead, which does read `.env`.

`pnpm test` needs the container up and migrations applied; it does not need `.env`, because `tests/setup/database-url.ts` defaults to the same URL. It defaults rather than overrides, so an explicit `DATABASE_URL` always wins and the suite can never silently truncate tables in a database the developer did not intend.

Registering the Discord commands to a test guild (immediate, versus roughly an hour for global) — requires `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN` and `DISCORD_TEST_GUILD_ID` in the environment:

```bash
pnpm exec tsx scripts/register-discord-commands.ts
```

The merge gate is `pnpm lint`, `pnpm test`, `pnpm build`. The interaction endpoint requires real HTTPS with a valid certificate, so Discord-facing behavior is exercised against the deployment rather than locally.

## AI-assisted development method

This project was built with Claude Code as the primary implementer, with product and architecture judgment held by the human. The working pattern, and the evidence for it, was recorded continuously rather than reconstructed at the end:

- Product semantics were frozen in a specification **before** any code generation, so implementation agents optimized the build rather than the product
- Every wave was planned as atomic tasks with an explicit dependency graph — see [docs/tasks/00_DAG.md](docs/tasks/00_DAG.md)
- Technical notes, dead ends and parked issues go to [docs/journal/](docs/journal/)
- Assignment evidence — what the AI proposed, what was accepted, what was rejected and why, how it was verified — is appended to [docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md](docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md)

Failures were recorded when they happened, not summarized afterwards, and the log contains more of them than of successes. They converge on one shape worth stating here: **a rigorous check aimed one object to the left of the claim it was supposed to support.** A verification run against an image the manifest does not name. A ruling reasoned over two summaries of a design instead of the design. A blocker declared from a probe of the access path instead of the desired end state. A concurrency test that passed because the callers were never concurrent. In every case the work was careful, the evidence was real, and the conclusion was wrong — and in every case it was caught by a reader who had not written the thing.

## Repository map

| Path | Contents |
|---|---|
| [docs/00_HANDOFF_INDEX.md](docs/00_HANDOFF_INDEX.md) | Entry point to the planning package and read order by role |
| [docs/01_CLIP_PRODUCT_SPEC.md](docs/01_CLIP_PRODUCT_SPEC.md) | Approved product behavior, data model, invariants, failure cases |
| [docs/02_CLIP_IMPLEMENTATION_PLAN.md](docs/02_CLIP_IMPLEMENTATION_PLAN.md) | Waves, tasks, tests, verification gates |
| [docs/03_CLIP_RESEARCH_DECISION_LOG.md](docs/03_CLIP_RESEARCH_DECISION_LOG.md) | Why Clip, competitor attacks, rejected alternatives, reversals |
| [docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md](docs/04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md) | **Append-only evidence log** — the record behind every claim above |
| [docs/05_DESIGN_AGENT_BRIEF.md](docs/05_DESIGN_AGENT_BRIEF.md) | Functional screens and UX invariants given to the design pass |
| [docs/06_DESIGN_HANDOFF.md](docs/06_DESIGN_HANDOFF.md) | **The UI specification** — design system, screens A–E, final Korean copy |
| [docs/DESIGN_RATIONALE_APPEND.md](docs/DESIGN_RATIONALE_APPEND.md) | Design decision log (Korean) |
| [docs/tasks/00_DAG.md](docs/tasks/00_DAG.md) | Dependency graph, critical path, cut order |
| [docs/journal/](docs/journal/) | Technical notes and dead ends |
| [design/](design/) | Design reference prototypes — **not code**, never imported or served |
| [tokens.css](tokens.css) | The single source of visual values |
| [k8s/](k8s/) | Deployment manifest template, rendered by `scripts/render-k8s-deployment.sh` |
| [scripts/](scripts/) | Command registration, manifest rendering, kubeconfig tunnel |

## License

Not yet determined.
