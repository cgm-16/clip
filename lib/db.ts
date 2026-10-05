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

// Keep construction lazy: importing a repository during a build must not
// require Discord/session environment variables or open a connection pool.
export function getPrismaClient(): PrismaClient {
  return globalForPrisma.prisma ??= createPrismaClient();
}
