import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { parseEnv } from './env';

// Next's dev server hot-reloads modules but keeps the Node process alive, so
// a plain top-level `new PrismaClient()` would open a fresh connection pool
// on every edit. Stashing the instance on `globalThis` survives the reload.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const env = parseEnv(process.env);
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

function getPrismaClient(): PrismaClient {
  // Must cache unconditionally, not just in dev: the Proxy below calls this
  // on every property access, and skipping the cache would open a fresh
  // connection pool per query.
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }
  return globalForPrisma.prisma;
}

// `createPrismaClient` calls `parseEnv`, which validates the full Env, not
// just DATABASE_URL. Building the client eagerly at module load would force
// every importer -- including build-time bundling and tests that never
// touch the database -- to have Discord/session vars set just to satisfy
// that unrelated validation. A Proxy defers construction to the first
// actual property access instead, so importing this module only requires
// what the caller's own code path actually needs.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrismaClient();
    const value = Reflect.get(client, prop);
    // Prisma Client methods close over `this`; grabbing them off the proxy
    // (e.g. `const { clip } = prisma`) must not lose that binding.
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
