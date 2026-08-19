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

### 2026-08-18 — H1 answered

Domain: **`clipendpoint.cc`**, Cloudflare, **USD 8/yr**. Apex, no subdomain.
`PUBLIC_BASE_URL=https://clipendpoint.cc`. Cost recorded in the README table.

**Recommended DNS-only (grey cloud), not proxied**, at least until `0.3b` passes. Discord
interaction verification signs the *exact raw request body*; a proxy that buffers or rewrites is
one more variable in the hardest gate to debug. Turn proxying on afterwards if wanted.

Still open on H1: the A record cannot be pointed until H3 supplies the ingress IP.

### Open question for H3 that no planning doc covered

k3s cannot pull an image from this Mac's Docker daemon, and no document specifies a container
registry. Options given to Ori: GHCR (recommended — free for public images, `gh` is already
authed), local `k3s ctr images import`, or an existing cluster registry. This would have blocked
`0.2` at apply time.

### 2026-08-18 — kubectl NotFound: root cause

`kubectl get nodes` → `Error from server (NotFound): the server could not find the requested resource`.

**Two distinct problems, only one of which is the reported error.**

**1. Malformed kubeconfig (the visible error).** `server: orioriori.duckdns.org` — a bare hostname
with no scheme and no port. A kubeconfig `server` must be a full URL. kubectl defaulted to
`https://orioriori.duckdns.org:443`, which is Traefik, which returned 404. `kubectl get --raw /`
also 404s; a real API server returns a JSON list of API paths there. So kubectl was talking to a
web server, not Kubernetes.

**2. The k3s API is not reachable from this machine at all (the real blocker).**

| Probe | Result |
|---|---|
| `orioriori.duckdns.org` resolves to | `14.39.43.191` |
| This Mac's public IP | `121.128.27.112` — **different network** |
| TCP 6443 (k3s API) | CLOSED/FILTERED |
| TCP 22 (SSH) | CLOSED/FILTERED |
| TCP 80 / 443 | OPEN — `HTTP/2 404`, `text/plain`, 19 bytes = Traefik default backend |

No kubeconfig edit can fix this. There is no LAN path and no SSH path from here.

**3. Latent third problem if 6443 is ever opened.** k3s generates its serving certificate with SANs
for `localhost`, `127.0.0.1`, the node IP and cluster names — **not** the DDNS hostname. Connecting
to `https://orioriori.duckdns.org:6443` would then fail x509 SAN validation unless k3s is restarted
with `--tls-san orioriori.duckdns.org`. Worth knowing before anyone opens the port and concludes
the fix did not work.

**The good news, and it is significant:** Traefik answering on 80/443 proves the ingress path is
internet-reachable. That is the only network property the *product* actually needs. `clipendpoint.cc`
will work. kubectl access is only needed for *deploying*, which is a separate problem with cheaper
solutions than exposing the Kubernetes API.

**DNS recommendation:** point `clipendpoint.cc` at the host with a **CNAME to
`orioriori.duckdns.org`**, not an A record to `14.39.43.191`. Cloudflare flattens CNAMEs at the
apex, so this survives the DDNS address changing — an A record would silently break the Discord
endpoint the next time the home IP rotates.

### 2026-08-18 — deploy access and registry resolved

**Access: Tailscale + SSH tunnel to `127.0.0.1:6443`.** Chosen over exposing 6443 or SSH publicly.
The key property: the stock k3s serving cert already includes `127.0.0.1`, so tunnelling to
localhost avoids the `--tls-san` restart that every other remote-kubectl approach would need.
`tailscale up --ssh` also means sshd on the host is never reconfigured.

**Registry: GHCR, pushed by CI, not from this machine.** The local `gh` token has scopes
`gist, read:org, repo, workflow` — no `write:packages`. Widening it was the obvious move and the
wrong one: building in CI means the deployed image always corresponds to a commit, needs no PAT
(`GITHUB_TOKEN` with `packages: write` suffices), and removes the dev Mac from the deploy path
entirely. Added as task `0.1b`.

Redeploys become one command over the tunnel:
`kubectl set image deployment/clip clip=ghcr.io/cgm-16/clip:sha-<short>`

**Watch for:** the GHCR package defaults to private. It must be flipped to public after the first
push, or k3s needs an `imagePullSecret` for no good reason.

### 2026-08-18 — cluster facts (measured, not assumed)

Tunnel up, `kubectl get nodes` works. Everything below is measured from the live cluster and
supersedes the planning documents where they disagree.

| Fact | Value |
|---|---|
| Node | `ori`, Ubuntu 24.04.4, k3s **v1.33.4+k3s1**, containerd 2.0.5 |
| Node LAN IP | `192.168.50.40` |
| Allocatable | 4 cpu / ~15.4 Gi |
| Ingress class | `traefik` |
| TLS | cert-manager, ClusterIssuer **`letsencrypt-http`** (HTTP-01), `READY=True` |
| Ingress pattern | annotation `cert-manager.io/cluster-issuer: letsencrypt-http` + `spec.tls[].secretName: <app>-tls` |
| Postgres | **CloudNativePG 1.27.0**, operator in `cnpg-system` |
| Postgres convention | one CNPG `Cluster` per app in the app's own namespace (`ssemtle-db` in `apps`, `vridge-db` in `vridge`) — **not** one shared cluster |
| Secrets | plain `Secret`. No sealed-secrets, no external-secrets. |
| Namespaces | `apps` `cert-manager` `cnpg-system` `data` `default` `vridge` + system |

**The planning documents are stale on capacity.** `00_HANDOFF_INDEX.md` and spec §18 claim "CPU load
around 1.6" and "memory utilization around 5%". Measured now:

- load average **14.70 / 14.64 / 14.13** on 4 cores — sustained, not a spike
- memory 47%
- node CPU *requests* only 47% committed; *limits* 165% (overcommitted)

Cause: the two `ssemtle` pods consume 3.24 cores between them and declare
`resources: {}` — **no requests, no limits**, so they are BestEffort and soak every idle cycle.

**Why this is less alarming than it looks.** BestEffort pods rank below anything with explicit
requests for both CPU shares and eviction. A Clip pod that declares requests will be scheduled
(2100m of requestable CPU remains) and will preempt ssemtle under contention. The load average
measures ssemtle burning otherwise-idle time, not genuine starvation.

**But two consequences are real:**

1. **Raise the planned resource request.** Spec §18 suggests `100m / 256Mi`. On a contended node
   running Next.js SSR that is too thin. Use `requests: 500m / 512Mi`, `limits: 2 / 1Gi`.
2. **Discord's 3-second interaction deadline gets riskier.** Under contention, a cold SSR path can
   plausibly exceed it. The deferred-response pattern already noted in task `3.4` moves from
   good practice to mandatory — acknowledge immediately, do the REST work in the follow-up.

Corrected the README cost table, which asserted the stale 1.6/5% figures.

### 2026-08-18 — DNS chain confirmed

```
clipendpoint.cc --CNAME--> clip.orioriori.duckdns.org --> 14.39.43.191
```

DuckDNS resolves wildcard subdomains to the base record, so the chain follows the home IP when
DDNS updates. Cloudflare flattens the apex CNAME, so `dig clipendpoint.cc` externally shows only
an A record — that is flattening, not a misconfigured record. TTL 60. Matches the existing
`ssemtle.orioriori.duckdns.org` convention.

**Decision: the Ingress declares `clipendpoint.cc` only, not both hostnames.** `ssemtle` lists three
hosts on one Certificate, and copying that here would be a mistake on the critical path: cert-manager
issues a single Certificate covering every SAN, so an HTTP-01 failure on *either* host yields *no*
cert, and gate `0.3b` cannot pass without one. Add `clip.orioriori.duckdns.org` as a second SAN only
after the first certificate issues cleanly, if a fallback hostname is wanted at all.

## 2026-08-18 — standalone container crash: `@swc/handlers` esm/ dropped by file tracing

**Symptom.** The Wave 0 image built and started, then died immediately:

```
Error: Cannot find module
'/app/node_modules/.pnpm/next@16.3.1_.../node_modules/@swc/helpers/esm/_interop_require_default.js'
```

**First hypothesis, wrong.** I blamed pnpm's symlinked `.pnpm` store and added
`--node-linker=hoisted` to the image's install step, reasoning that Next's file tracing
does not follow symlinks. That hypothesis was never tested before it was written into a
Dockerfile comment.

**What the evidence actually showed.** Inspecting the builder stage:

- `node_modules/@swc/helpers` was already a **real directory** containing `esm/` — the
  hoisted linker worked exactly as asked, and the crash persisted anyway.
- `.next/standalone/node_modules/@swc/helpers/` contained **only `package.json`**.

So tracing did not fail to *follow* the package; it copied the package and dropped every
file in it. Next's `require-hook.js` resolves `@swc/helpers/esm/*` at runtime through the
package's `exports` map, and the tracer cannot see subpaths reached that way.

**Fix.** `outputFileTracingIncludes: { '/**/*': ['./node_modules/@swc/helpers/**'] }` in
`next.config.ts`. Verified: container starts, `GET /api/health` returns `{"ok":true}`,
process runs as uid 1001.

`--node-linker=hoisted` stays, but for the honest reason: the include glob resolves
against real directories rather than symlinks into `.pnpm`. The Dockerfile comment was
corrected to say that instead of the wrong claim.

**Lesson.** The misleading part was the *path* in the error message. It contained
`.pnpm/`, which made "pnpm layout problem" feel obvious, and the real defect — an empty
traced package — was one `ls` away the whole time. Read the artifact, not the path string.

**Unrelated, parked:** the host disk hit 100% mid-build (`input/output error` from
buildkit). Ori freed space. Docker's build cache still holds ~7 GB reclaimable and there
is a stale 9.9 GB stopped `ubuntu` container, both Ori's to decide on.

---

## 2026-08-19 — Withdrawing the cluster-load claim as unreproducible

**Claim made.** That the k3s node ran at a sustained load average of ~14 on 4 cores,
attributed to a co-tenant workload (`ssemtle`) declaring no resource requests, and that
two of its pods ran suspicious binaries (`./javae`, `./ycxm7ue3qrco`) that respawned.
This was written into `README.md` as a cost-table fact and used to justify labelling
issues #5 (`0.2`) and #7 (`0.3b`) `blocked:human`.

**Why it is withdrawn.** Ori could not reproduce any of it with `ps` and asked for a
verification procedure. On re-checking I found that (a) the scratchpad notes holding the
original evidence are gone with the session directory, and (b) SSH to the host now fails
with `Permission denied (publickey)` and no tunnel is up, so I cannot re-derive the
numbers. A claim I cannot reproduce and whose evidence I did not durably record does not
belong in a public README. The cost-table row is now "headroom has not been measured".

**What was actually load-bearing, and what was not.** Two separable assertions got fused:
the *load number*, which I cannot substantiate, and *whether the co-tenant declares
resource requests*, which is checkable from `kubectl get pods -A -o yaml` and has nothing
to do with the malware question. I stated them as one causal sentence, which made a
checkable fact inherit the credibility problem of an unchecked one.

**Why `ps` finding nothing is not a refutation either.** `ycxm7ue3qrco` is a randomized
name; if the process respawns under a fresh one, a name grep fails by construction. A
null result cannot distinguish gone / renamed / pod-restarted / wrong host. Neither of us
can settle this name-first. The discriminating check is **cgroup CPU attribution** —
`systemd-cgtop`, then `/proc/<pid>/cgroup` and `/proc/<pid>/exe` on whatever is hot —
because that identifies the container burning CPU regardless of what the binary calls
itself. Verification script left in the scratchpad, deliberately not committed here.

**Lesson.** Same failure shape as the `@swc/helpers` misdiagnosis: a plausible reading
committed to a durable artifact before it was verified. The new part is the evidence
handling — an observation that only ever lived in a scratchpad and in my context is not
evidence, because both are volatile. Findings that will be cited in a committed file must
be pasted into the journal *when observed*, with the raw command output.

**Not yet in the snapshot.** The rule is to record an AI proposal immediately when it
turns out wrong. This one is not established wrong — it is unverified. It goes to the
snapshot once Ori's verification run resolves it either way, and the outcome is recorded
whichever direction it falls.

---

## 2026-08-19 — Deployment manifests: two plan defects found before applying

**Migration initContainer cannot work as specified.** Issue #5 (`0.2`) calls for an
initContainer running `prisma migrate deploy`. The runtime image cannot do that: the
Dockerfile's `runner` stage copies only `.next/standalone` and `.next/static`, so there is
no Prisma CLI and no migration SQL in it. The initContainer would crash-loop on first boot.

Wave 0 also ships no schema at all — `prisma/` arrives with Wave 1 — so there is nothing to
migrate yet either. Dropped the initContainer from `k8s/deployment.yaml` with the reason
written into the file, and deferred it to Wave 1.

**What Wave 1 needs to add.** Copying the Prisma CLI into the runtime image means dragging
in its transitive engine packages and inflating the image that runs 24/7. The cleaner shape
is a separate `migrator` stage built from `deps` (which already has full `node_modules`)
plus `prisma/`, pushed as its own tag, with the initContainer pointing at that tag. Not
implemented yet — recorded here so Wave 1 does not rediscover the constraint.

**Cluster facts measured today**, replacing what the issue asserted:

| | |
|---|---|
| Node | `ori`, k3s v1.33.4+k3s1, 4 cores |
| Load | 1.42 / 1.94 / 4.02 — the 15-min figure was Ori's own ClamAV scan at 80.7% |
| Containers with no CPU request | **94**, nearly all `ssemtle` |
| `apps` namespace | 5 pods Running, **78 in `ContainerStatusUnknown`** |
| Storage class | `local-path` (default), no expansion |
| CNPG | 1.27, `vridge-db` (1 instance) and `ssemtle-db` (3) as pattern references |
| DNS | `clipendpoint.cc` → 14.39.43.191, unproxied, same A record as the duckdns name |

The 78 dead pod records are almost certainly what an earlier session misread as a runaway
co-tenant. They are pod objects, not workloads, and cost nothing but `kubectl` output. Worth
garbage-collecting, but Ori's call and not ours.

The conclusion the wrong evidence had supported still holds on the right evidence: 94
containers declaring no CPU request makes them BestEffort, so Clip must declare requests to
be scheduled safely against them. Same recommendation, different reason.

**Blocked, not deferred:** applying `namespace.yaml` and `postgres.yaml` ahead of the image
was denied by the harness's auto-mode classifier. Cluster writes need Ori's explicit
permission; not worked around.
## 2026-08-19 — Prisma 7 on Next 16: three things that only fail outside your shell

Task 1.1 (control-plane schema) passed lint, tests and build locally while being broken
in two environments nobody had exercised yet. All three problems share a shape: a
dependency that is satisfied *by the developer's shell* rather than by the repository.

**1. Vitest does not read `.env`.** The schema-invariant tests need a real Postgres, so
they resolved `DATABASE_URL` through `parseEnv` and threw without it. It looked green
only because every run so far had passed the variable inline. Fixed with a setup file
that **defaults** rather than overrides (`??=`), so an explicit value from a shell or CI
always wins — these tests call `deleteMany`, and a setup file that overrode the
environment could point that at a database the developer did not intend.

**2. Prisma 7 generates the client into a git-ignored directory.** `output = "../generated/prisma"`
means a fresh clone has no client at all, and `lib/db.ts` imports from it, so nothing
typechecks. CI needed explicit `prisma generate` and `prisma migrate deploy` steps ahead
of lint/test/build.

**3. The same directory was git-ignored but not docker-ignored** — the worst of the
three, because it fails *silently in the right direction*. The image was copying in
whatever stale client happened to sit on the build machine, so it built fine here and
would have had no client at all in CI. Added to `.dockerignore` and regenerated in the
builder stage.

**Then the regeneration failed on its own:** `prisma.config.ts` resolves `DATABASE_URL`
eagerly, and `generate` refuses to start without it, even though generating a client
never opens a connection. Resolved by giving the generate step an unroutable placeholder
rather than loosening the config — `migrate deploy` must still fail loudly when the real
URL is absent.

**Lesson, and it is the same one as the `@swc/helpers` entry above:** "it works" measured
in the environment that built it proves very little. Both defects were found by
constructing the *unprepared* environment on purpose — `env -u DATABASE_URL`, and a
container build from a clean context — not by reading the code.

---

## A concurrency test that could not fail — cold Prisma connection pools serialize callers

Task 1.4's single-use invariant is enforced by a conditional
`updateMany({ where: { tokenHash, usedAt: null, ... } })` whose count decides the winner.
To prove the test was worth anything, the implementation was temporarily replaced with the
exact regression it is supposed to catch — a `findFirst` followed by an unconditional
`update`. **The test still passed**, with 8 `Promise.allSettled` callers.

The reason is not the database. A cold `pg` pool opens connections lazily, so eight
simultaneous callers each wait on their own TCP+auth handshake; the first one to connect
finished its whole read-then-write in ~9ms while the other seven were still connecting
(~22ms), and they then read the row the winner had already marked used. The interleaving
the test exists to create never happened.

Confirmed the pool itself is not the serializer: two `pg_sleep(0.5)` queries on one client
finish in 558ms, so a *warm* client is genuinely parallel. Warming the pool in the test —
`Promise.all` of N trivial queries before the concurrent section — makes the same
regression produce 7 winners and 8 sessions, and the test fails as it should.

**Lesson:** a concurrency test asserting "exactly one winner" is worthless until it has
been shown to fail against the serial implementation. Connection-pool warm-up is part of
the setup, not an optimisation. Any future test of §9's invariants (simultaneous Clip,
simultaneous Unclip) must warm the pool the same way and be mutation-checked the same way.

## 2026-08-19 — Wave 1: three defects that only mutation testing found

Wave 1 shipped five tasks. Every one passed its implementer's self-review, and the suite was
green at every point. Three separate security defects were nevertheless present, and all three
were found the same way: break the code, re-run the tests, see whether anything notices.

1. **Task 2, `safe-log.ts`.** The allowlist filtered key *names* but not value *types*, so
   `logClipEvent({ userId: { content: 'BODY' } })` logged a message body verbatim — against the
   invariant that exists specifically to prevent that.
2. **Task 4, the concurrency test.** Substituting the exact check-then-write regression it
   claimed to catch still passed. Root cause: node-postgres opens pool connections lazily, so
   caller 1 finished its read-then-write in ~9ms while the others were still handshaking at
   ~22ms. A `Promise.all` warm-up fixes it, and that warm-up is load-bearing — deleting it
   gives 5/5 false passes with the regression in place. Reproduced twice, independently.
3. **Task 5, the interaction endpoint.** No test required `/setup` to sit downstream of the
   Ed25519 check. Moving the branch above `verifyInteractionRequest` left all 71 tests green,
   in a build where an unauthenticated POST mints a live admin token for any guild.

Plus two more at the whole-branch review: a cross-origin POST to `/api/setup/exchange` returned
204 with a `Set-Cookie`, and `content String?` could be added to the `Clip` table without a
single test failing — the "never persist message bodies in Postgres" invariant had no
deliberate protection whatsoever, only the absence of columns.

The transferable finding: **a green suite is evidence about the tests, not about the code.**
AI-authored tests cluster densely on the behaviour the author was thinking about and leave the
adjacent boundary — authentication, storage shape, request origin — entirely unnamed. Reading
the tests does not reveal this; only mutating the code does. Wave 2 should mutate every
invariant it claims to protect, and treat "I read it and it looks right" as worthless for this
class of bug.

### Two traps that cost time

- **`tsconfig.tsbuildinfo` does not invalidate on a tsconfig change.** After bumping `target`
  ES2017 → ES2020, `tsc` kept reporting `TS2737` against the *old* target. Delete the buildinfo
  whenever a tsconfig edit appears not to take effect.
- **The test Postgres is on port 5433, not 5432** (`tests/setup/database-url.ts` defaults to the
  `clip-pg` container). A reviewer concluded from a closed 5432 that the DB tests were silently
  skipping and that Task 4's evidence was void. They were not skipping: pointing `DATABASE_URL`
  at a dead port makes them *fail*. Check the default before concluding a suite is inert.

### Deferred deliberately, with reasons

`X-Signature-Timestamp` has no replay window, so a captured signed body mints setup tokens
forever. Deferred to Wave 2 because exploitability requires capturing a signed body and that is
not established here — Traefik runs without `--accesslog` and never logs bodies regardless, and
the route does not log the body. Adding it now would deviate from Discord's documented procedure
on the only Discord-facing surface, with no live-guild coverage, where clock skew past the
window silently 401s every interaction and presents as a signature bug.

## 2026-08-19 — PR 46 review: the two-write exchange was not atomic

CodeRabbit found what 12 mutations did not: `exchangeSetupToken` consumed the setup token and
inserted the admin session as two independent statements. If the insert failed, `used_at` was
already committed and the admin was stranded on a dead link — a burned token, recoverable only
by re-running `/setup`. Not a security hole (at most one session per token held either way,
which is why the mutation pass never flagged it), but a real availability defect.

Why the mutation regime missed it: every mutation asked *"can this invariant be violated?"*.
Non-atomicity violates no invariant — it fails **safe**, in the direction of doing less. The
transferable point is that mutation testing finds tests too weak to catch a *stronger* wrong
behaviour, and is structurally blind to failure modes that are merely *worse for the user*.

The fix folds both writes into `exchangeSetupTokenForSession`, one `prisma.$transaction`. The
session's guild and user now come from the consumed token row rather than from the caller, so a
session cannot be scoped to a pair its token was not issued for. The one-winner property is
strengthened, not weakened: the row lock is now held to commit instead of being released at the
end of the UPDATE.

### The pool-exhaustion risk that did not materialize (measured)

An interactive transaction holds a pool connection for its whole duration, and the concurrency
test fires 8 overlapping callers while asserting **zero** rejections. Prisma's default
`connection_limit` is `physical_cpus * 2 + 1` — about 5 on a 2-core runner — so the worry was 8
transactions against 5 connections blowing the 2s `maxWait` and rejecting in CI only, on a
machine with 10 physical cores that would never reproduce locally.

It does not happen. Pinned `connection_limit` to 5, 3 and finally **2** — stricter than any
realistic runner — and ran the file **12 consecutive times at limit 2: 78/78, zero rejections**.
The transactions are sub-millisecond, so queued callers get a connection far inside `maxWait`.
No `connection_limit` was added to the test URL: it would have been a harness change with no
evidence behind it. If this ever does go flaky in CI, this is the first thing to suspect.

The new test uses a genuine primary-key collision on `admin_sessions.token_hash` (it is the
table's `@id`) to make the insert fail — a real Postgres unique violation, no mocks, per the
real-data rule. It is decisive: reverting the `$transaction` to two bare statements fails it on
`expected 2026-08-19T04:50:28.277Z to be null`.

## 2026-08-19 — Wave 2 task 2: the clip repository

### `?connection_limit=N` in `DATABASE_URL` does nothing under the pg driver adapter

Wave 1 recorded pinning `connection_limit` to 2 as evidence that interactive transactions do not
starve the pool. Measured today: that knob is inert in this stack.

`@prisma/adapter-pg` builds `new pg.Pool({ connectionString })`. `pg.Pool` reads its ceiling from
`options.max`; the connection string is parsed by the `Client`, and `pg-connection-string` copies
unknown query parameters onto the config verbatim, so `connection_limit` lands in the config as a
string nobody reads. Timed four concurrent `SELECT pg_sleep(0.3)` on one client:

| pool config                     | wall time |
| ------------------------------- | --------- |
| `?connection_limit=1` in the URL | 306 ms    |
| `new PrismaPg({ …, max: 1 })`    | 1224 ms   |
| unconstrained                    | 305 ms    |

Only `max` constrains anything. The real check is to set `max` on the adapter in `lib/db.ts`
temporarily. Done for this task at `max: 2` and `max: 1` — 96/96 both times, five and three runs
respectively — which is a much stronger result than the vacuous one, since at `max: 1` any code
that checked out a second connection inside a transaction would deadlock outright.

### The pool warm-up did not change these two race outcomes

The mandated warm-up before a race is real advice, but for the two races in
`tests/clip/repository.test.ts` it turned out not to be the deciding factor: with the warm-up
deleted, the check-then-insert regression still produced 9 rejected claims out of 10 (five runs,
test run in isolation so no earlier test could warm the pool), and the dropped-`FOR UPDATE`
regression still produced `[1, 1]` instead of `[0, 1]` (five runs). node-postgres opens up to
`max` connections concurrently, so N ≤ 10 cold callers all finish their handshakes at roughly the
same moment and do overlap. Wave 1's false positive presumably needed more round trips per caller
to hide behind. The warm-up stays — it removes a genuine confound and costs nothing — but its
comment no longer claims more than was observed.

### Unrelated, do not fix here

`.env` in the worktree still points at `postgresql://clip:clip@localhost:5432/clip`, while the
running container is `clip-pg` on **5433/clip_dev**. Every `prisma` CLI invocation therefore needs
`DATABASE_URL=…5433/clip_dev` in front of it, and `set -a && . ./.env && set +a` sends the CLI at
a dead port. `.env` is gitignored, so this is a local-machine fix for Ori rather than a repo change.

## 2026-08-19 — Task 2.3: the deletion window, and what a half-applied ruling looks like

### The two-instruction composition bug

The Task 3 dispatch carried seven pre-settled rulings. Two of them, both individually correct:

- **F** — tombstoning deletes every clipper row (§7.4: removal overrides all preservation signals).
- **A** — the deletion finalizer branches on the freshly-locked status: tombstoned → clear the
  archive ids and keep the row; `DELETING` with zero clippers → delete the row.

F was implemented. A was implemented *only for the revival branch*. The result:

```
A clips             -> ACTIVE, 1 clipper
A unclips           -> removeClipper (0 left) -> markDeleting -> DELETING, lock released
                       [ Discord delete in flight — the window ]
author removes      -> REMOVED_BY_AUTHOR + deleteClippers   (F)
finalizer relocks   -> countClippers == 0 -> deleteClipWithClippers   <-- tombstone destroyed
```

The clipper count cannot tell "the last clipper left" from "removal wiped the clippers" — both read
zero. Only the status can, which is exactly what ruling A said. Recreation was unblocked for a
message whose author had explicitly removed it, which is the harassment loop §7.4 exists to stop.

What makes this worth writing down is that it violates no CHECK, satisfies every type, and passed
all 19 of the implementer's own tests. It was found by reading the window against the ruling that
named it. The lesson for future dispatches: **audit each numbered ruling against the diff
individually before reviewing the code as a whole.** A skipped ruling (G, the safe-log allowlist)
shows up in a grep. A half-applied one leaves no artifact distinguishing it from a finished one.

### The delete hook is what makes these races testable

`tests/clip/fake-gateway.ts` `onNextDelete(hook)` runs an arbitrary async function *inside*
`deleteArchiveMessage`, i.e. exactly in the window between "Discord messages gone" and "finalizer
retakes the lock". Both window tests (revival, and now tombstone) are fully deterministic with no
sleeps. It is one-shot on purpose: a hook that fired again on the delete the concurrent request
itself triggers would recurse.

### Parked: `ACTIVE` with zero clippers

Not fixed, deliberately — full reasoning and a fix sketch are in the SDD ledger under PARKED.

```
A unclips    -> DELETING, delete in flight
B clips      -> count 1
finalizer    -> relocks, reads count 1 -> "revived", releases lock
B unclips    -> sees DELETING -> ALREADY_DELETING, returns
finalizer    -> recreates archive, publishArchive: DELETING -> ACTIVE is legal
             -> ACTIVE, zero clippers, live archive no unclip can remove
```

`service.ts` claims the finalizer's count re-read makes this converge, but the lock does not order
that read after B's `removeClipper` — only one of the two interleavings is safe. Not reproducible
with a single `onNextDelete` hook (B's clip must land before the count read, B's unclip after it).
The right repair is an "ACTIVE requires ≥1 clipper" guard inside `publishArchive`'s lock, which
then strands the row `DELETING` with no finalizer and so needs `finalizeDeletion` restructured to
re-enter. Wider than Task 3; a half-applied version repeats the bug above.

### Unrelated, do not fix here

`k8s/deployment.yaml:19-25` carries a comment saying "Wave 0 ships no Prisma schema, so there is
nothing to migrate". False since Wave 1. The migration is still applied by hand; the `migrator`
Dockerfile stage running `prisma migrate deploy` as an initContainer is the carried-forward fix.

## 2026-08-19 — Wave 2 review: mutation 4, and the deferred work it uncovered

### Mutation 4 was a false pass, and why that was structural

Plan mutation 4: *delete `clearArchiveMessageIds` from the finalizer → the revival race
test must fail.* It passed **22/22**. Every finalizer outcome hides that line:

| outcome | why the clear is invisible |
|---|---|
| tombstoned | `removeByAuthorOrAdmin` clears the ids itself, from inside the hook |
| revived successfully | `markActive` overwrites both ids anyway |
| deleted | the row is gone |
| ACTIVE won the race | (post-fix) the clear is skipped by design |

The only surviving state that exposes it is a revival whose **rebuild fails**: the Clip
stays `DELETING` with a clipper and no archive, so stale ids would be the §9.3
"already deleted vs. never attempted" ambiguity the first CHECK constraint exists for.
`tests/clip/service.test.ts` now pins exactly that; M4 fails 1/23 against it.

Worth generalizing: a mutation is only a real check if some *observable* state depends
on the mutated line. Three of this wave's four mutations were decisive on the first try
(3, 16 and 3 failures); the fourth targeted a line every code path overwrote or
discarded. Writing the mutation list at plan time — before the code exists — is what
produced that mismatch, and it is not avoidable, so the discipline is to treat a
mutation that passes as a finding about coverage rather than as a passed check.

### The finalizer had two decisions and one guard

`finalizeDeletion`'s callback decides two things from one locked row — whether to clear
the ids, and whether to delete the row. The tombstone fix earlier today guarded the
second and not the first, four lines apart. A concurrent `publishArchive` then makes the
row ACTIVE, and clearing ids on an ACTIVE row violates `clips_active_requires_archive`,
which surfaces as a raw Prisma rejection out of `unclip` — `UnclipResult` declares a
`FAILED` member but neither `unclip` nor `removeByAuthorOrAdmin` has a `try`/`catch`, so
those union members are unreachable and the error was never designed for.

The callback now branches by case, and `deleteArchiveQuietly`'s boolean is load-bearing:

```
ACTIVE won the race        -> touch nothing (ids belong to that publish)
delete succeeded           -> clear ids
  tombstoned               -> keep the row (§7.4 outranks the deletion)
  clippers == 0            -> delete the row
  clippers  > 0            -> revive
delete failed / no channel -> keep ids AND row, leave DELETING for reconciliation
```

### Carried to Wave 5 reconciliation — do not fix here

- **A Clip stranded `PENDING` has no retry path.** If the process dies between
  `claimClip` and `recordArchiveFailure` (real on a 3s interaction ack budget), the row
  stays `PENDING` with no archive and every later clip returns `CLIPPER_ADDED` with
  `archive: null` forever. **Do not fix by adding `PENDING` to `mustCreateArchive`** —
  that breaks §9.4 for a second clipper landing mid-round-trip. Needs a lease or an
  `updatedAt` staleness heuristic.
- **Revival in a guild that lost its config dead-ends.** `finalizeDeletion` returns early
  when `archiveChannelId` is null, leaving the Clip `DELETING` with clippers > 0; a later
  unclip hits `ALREADY_DELETING` and returns without finalizing, so the row is stuck.
- `CONCURRENT_CLAIMERS = 10` in `tests/clip/repository.test.ts` silently equals
  node-postgres' undeclared default `max`. Raising it turns the race into a queue with no
  test failure. Set `max` explicitly in the test setup, or assert the relationship.
- `TOMBSTONE_STATUSES` in `lib/clip/repository.ts` is a mutable module-level array.

## 2026-08-19 — CodeRabbit on PR #47: the false comment was the defect

### A removal retry could not clean up an archive whose first delete failed

`removeByAuthorOrAdmin` commits the tombstone, then deletes the two Discord messages, and
keeps the ids when that delete fails — deliberately, since they are the only handle on
content still up in the archive channel. Nothing ever used that handle: a second removal
matched `isTerminalStatus` and returned before reaching the delete. The pair stayed up
with no retry path, and only Wave 5 reconciliation would ever have noticed.

The tell was a comment, not the control flow: *"the archive it pointed at is already
gone"* was simply false on the failed-delete path. The branch was written for a tombstone
whose ids had been cleared, and the failed-delete case — added later, correctly — made
that premise conditional without anyone revisiting the sentence that asserted it.

The fix returns `archiveOf(locked)` from the terminal branch so the caller re-enters the
same delete-and-clear path. What makes that safe is worth keeping: **ids on a terminal
row can only be the pair the removal was meant to delete.** `markActive` is their only
writer, `publishArchive` gates it on `canTransition`, and `LEGAL_TRANSITIONS` gives the
tombstones no outgoing edges — so nothing can put a *different* archive's ids there. The
retry deletes and clears; it does not re-tombstone, so `removedAt` keeps naming the
removal that actually happened. Falling through to a second transition would throw, and
the test pins `removedAt` unchanged to catch exactly that mis-wiring.

Two consequences, both acceptable. Concurrent removals can now both issue a delete for
the same pair — a no-op for an absent message under the gateway contract the orphaned-
provenance cleanup already relies on. And a removal in a guild with no archive channel
now cleans up once the guild is configured, which it previously never did.

### The `ACTIVE` with zero clippers defect, found independently

CodeRabbit reached the same reachable sequence as `### Parked` above, from the code
alone. Third independent confirmation; still parked, still Ori's call to unpark. Its
proposed sketch takes the archive back down after a successful publish and says it "still
needs the follow-up transition out of `ACTIVE`" — that follow-up is the load-bearing
half. Deleting the messages does not trip `clips_active_requires_archive`, because the
CHECK reads the row and not Discord; clearing the ids afterwards does, which is the
failure already fixed in `2a8abdc` and written up above.

### The `PARKED` pointer above is dangling

`### Parked: ACTIVE with zero clippers` points at "the SDD ledger under PARKED".
`.superpowers/sdd/` holds only `wave-0-remainder` in the main checkout and nothing at all
in the wave-2 worktree (the directory is git-ignored, so a worktree never carries it).
The reasoning survives in this journal and in the PR body; the cross-reference does not.
Ledger paths are ignored and per-checkout, so a journal entry should carry the substance
rather than point at one.
