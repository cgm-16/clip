// Vitest does not read `.env`, and the schema-invariant tests need a real
// PostgreSQL. Default to the local development container so `pnpm test` works
// with no shell setup, while still letting CI point at its own service.
//
// Defaulting rather than overriding is deliberate: an explicit DATABASE_URL
// always wins, so this can never silently redirect a suite that deletes rows
// at some database the developer did not intend.
process.env.DATABASE_URL ??= 'postgresql://clip:clip@localhost:5433/clip_dev';
