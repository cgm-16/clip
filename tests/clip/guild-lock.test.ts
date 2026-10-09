import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { withGuildLock } from '@/lib/guild-lock';

// Discord snowflakes are opaque strings to us; a random per-test id keeps
// concurrent/re-run test invocations from colliding on the same lock.
function fakeSnowflake(): string {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

describe('guild lock', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    // lib/db.ts validates the full Env on first use of the client.
    // DATABASE_URL is deliberately left untouched: it must come from the real
    // Postgres the test runs against, supplied by the invoking command.
    vi.stubEnv('DISCORD_APPLICATION_ID', '1539212298600718416');
    vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
    vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-value');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');

    prisma = (await import('@/lib/db')).getPrismaClient();
  });

  // Opens pool connections before a race; see tests/clip/repository.test.ts.
  async function warmConnectionPool(callers: number): Promise<void> {
    await Promise.all(Array.from({ length: callers }, () => prisma.$queryRaw`SELECT 1`));
  }

  test('withGuildLock serializes two writers on the same guild', async () => {
    const guildId = fakeSnowflake();
    await warmConnectionPool(2);
    const firstHolds = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const order: string[] = [];

    const first = withGuildLock(guildId, async () => {
      order.push('first-start');
      firstHolds.resolve();
      await releaseFirst.promise;
      order.push('first-end');
    });
    await firstHolds.promise;
    const second = withGuildLock(guildId, async () => {
      order.push('second');
    });

    let waitError: unknown;
    try {
      await vi.waitFor(
        async () => {
          const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock' AND wait_event = 'advisory'
            ) AS blocked`;
          expect(row?.blocked).toBe(true);
        },
        { timeout: 2_000, interval: 10 },
      );
    } catch (error) {
      waitError = error;
    } finally {
      releaseFirst.resolve();
    }
    await Promise.all([first, second]);
    if (waitError !== undefined) {
      throw waitError;
    }
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  test('withGuildLock does not block a different guild', async () => {
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = withGuildLock(fakeSnowflake(), async () => {
      holding.resolve();
      await release.promise;
    });
    await holding.promise;
    try {
      await withGuildLock(fakeSnowflake(), async () => {}); // must not wait
    } finally {
      release.resolve();
    }
    await first;
  });
});
