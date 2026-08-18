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
