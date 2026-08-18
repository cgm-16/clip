# Wave 0 remainder — Discord interaction endpoint

Branch: `wave/0-deploy-skeleton`. Tasks `0.1` (env parser, health route, container) are
already complete and merged into this branch. `0.2` and `0.3b` are blocked on cluster
access and are not part of this plan. `0.1b` (GHCR push) is CI configuration handled by
the controller.

## Context

Clip is a Discord app: an authorized member preserves one message into a server-owned
archive. One Next.js deployable serves both the Discord interaction endpoint and the
admin web UI. There is no Gateway worker — every product input arrives as an HTTP
interaction, which Discord signs with Ed25519.

Repository layout is root-level: `app/`, `lib/`, `tests/`, `scripts/`. There is no `src/`.

## Global Constraints

- **TDD is mandatory.** Write the failing test first, watch it fail, then implement.
- Tests live in `tests/`, mirroring the `lib/` path of what they cover.
- `pnpm lint` (eslint + `tsc --noEmit`), `pnpm test`, and `pnpm build` must all pass.
- Never log or persist raw Discord message bodies, attachments, or embed payloads.
- Environment access goes through `parseEnv` in `lib/env.ts`. Do not read
  `process.env` directly in feature code.
- Match the surrounding code's style: single quotes, semicolons, 2-space indent.
- Comments explain *why*, never temporal context ("new", "moved", "recently").
- Conventional Commits. One commit per task.

## Task 1 — Discord interaction signature verification and PING

### Files
- `lib/discord/verify-interaction.ts` (new)
- `app/api/discord/interactions/route.ts` (new)
- `tests/discord/verify-interaction.test.ts` (new)

### Requirements

- [ ] Failing test first: unsigned and bad-signature requests are rejected with **401**
- [ ] Verify using the `discord-interactions` package's `verifyKey` against the **raw**
      request body plus the `X-Signature-Ed25519` and `X-Signature-Timestamp` headers
- [ ] Reading the raw body in an App Router route handler is the usual trap — do not let
      a JSON parse consume it first. Read `await request.text()` and parse afterwards.
- [ ] Respond to an interaction of `type: 1` (PING) with `{ type: 1 }` (PONG)
- [ ] The public key comes from `DISCORD_PUBLIC_KEY` via `parseEnv`

### Done check

Tests pass, including a **valid** signature generated in-test with a known keypair —
use Node's `crypto` (`generateKeyPairSync('ed25519')` and `sign`) so the happy path is
exercised for real rather than mocked. `verifyKey` takes a hex-encoded public key, so
export the generated key in the same encoding Discord uses.

### Spec

`docs/01_CLIP_PRODUCT_SPEC.md` §17 case 1. Read that section; do not redesign it.
