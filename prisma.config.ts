import { defineConfig, env } from 'prisma/config';

// Prisma 7 reads the datasource URL from this config file rather than from
// `env()` inside schema.prisma. This is CLI-time only (migrate/generate);
// runtime code still goes through `parseEnv` in lib/env.ts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
