# October 2026

## 2026-10-05 — ponytail audit simplifications (#53)

- Replaced platform wrappers and removed Tailwind without changing product behavior. Database initialization stays lazy and globally cached; transaction locks and query predicates are unchanged.
- Local Postgres was initially unavailable. Started Docker and an isolated, disposable Postgres 17 container on port 5433; the complete baseline passed 345 tests. After the refactor, 346 tests pass, including an exchange-cookie round trip through real session authentication.
- Compared actual Screen A/B/C components and the input primitive at 1280px and 390px in a temporary browser fixture. Measured geometry, typography, colors, spacing, and primary-link hover matched before/after. Removed the fixture before final verification. Its initial missing TextInput label/id caused a temporary type-check failure, not a shipping-code failure.
- Out of scope: Screen B's existing fixed-width card overflows at 390px. The overflow is identical before/after; recorded for a separate responsive-layout fix.
- Production browser smoke checks passed for the expired-link screen and setup authentication/origin guards against real Next routes and Postgres. Live Discord setup and deployment e2e were not run.
- Removing dependencies refreshed pnpm peer-resolution metadata and exposed an existing ESLint 9 deprecation notice; no unrelated dependency versions were upgraded.
