import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { POST } from '@/app/api/setup/exchange/route';
import {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  SETUP_TOKEN_TTL_MS,
  hashBearerToken,
} from '@/lib/admin-session/tokens';
import {
  authenticateAdminSession,
  exchangeSetupToken,
  issueSetupToken,
} from '@/lib/admin-session/service';
import { exchangeSetupTokenForSession } from '@/lib/admin-session/repository';

const SESSION_SECRET = 'x'.repeat(32);
const CONCURRENT_CALLERS = 8;

// Discord snowflakes are opaque strings to us; a random per-test id keeps
// concurrent/re-run test invocations from colliding on the same row.
function fakeSnowflake(): string {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

describe('admin session service', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    // The service validates the full Env on first use, so every required var
    // needs a value even though only ADMIN_SESSION_SECRET matters here.
    // DATABASE_URL is deliberately left untouched: it must come from the real
    // Postgres the test runs against, supplied by the invoking command.
    vi.stubEnv('DISCORD_APPLICATION_ID', '1539212298600718416');
    vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
    vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-value');
    vi.stubEnv('ADMIN_SESSION_SECRET', SESSION_SECRET);
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');

    prisma = (await import('@/lib/db')).getPrismaClient();
  });

  const cleanupGuildIds: string[] = [];

  function trackedGuildId(): string {
    const guildId = fakeSnowflake();
    cleanupGuildIds.push(guildId);
    return guildId;
  }

  afterEach(async () => {
    await prisma.setupToken.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    await prisma.adminSession.deleteMany({ where: { guildId: { in: cleanupGuildIds } } });
    cleanupGuildIds.length = 0;
  });

  test('issuing a token persists only its hash, with a 15 minute expiry', async () => {
    const guildId = trackedGuildId();
    const userId = fakeSnowflake();
    const issuedAt = new Date();

    const issued = await issueSetupToken(guildId, userId, issuedAt);

    const rows = await prisma.setupToken.findMany({ where: { guildId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tokenHash: hashBearerToken(issued.token, SESSION_SECRET),
      guildId,
      userId,
      usedAt: null,
    });
    // The bearer value must be unrecoverable from the row.
    expect(JSON.stringify(rows[0])).not.toContain(issued.token);
    expect(rows[0].expiresAt.getTime()).toBe(issuedAt.getTime() + SETUP_TOKEN_TTL_MS);
    expect(issued.expiresAt.getTime()).toBe(issuedAt.getTime() + SETUP_TOKEN_TTL_MS);
  });

  test('a valid unused token exchanges once for a session scoped to its guild and user', async () => {
    const guildId = trackedGuildId();
    const userId = fakeSnowflake();
    const exchangedAt = new Date();

    const issued = await issueSetupToken(guildId, userId);
    const grant = await exchangeSetupToken(issued.token, exchangedAt);

    expect(grant).toMatchObject({ guildId, userId });
    expect(grant?.expiresAt.getTime()).toBe(exchangedAt.getTime() + ADMIN_SESSION_TTL_MS);

    const identity = await authenticateAdminSession(grant!.token);
    expect(identity).toEqual({ guildId, userId });

    const sessions = await prisma.adminSession.findMany({ where: { guildId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].tokenHash).toBe(hashBearerToken(grant!.token, SESSION_SECRET));
    expect(JSON.stringify(sessions[0])).not.toContain(grant!.token);
  });

  test('the exchanged cookie authenticates a browser request for the same guild and user', async () => {
    const guildId = trackedGuildId();
    const userId = fakeSnowflake();
    const issued = await issueSetupToken(guildId, userId);

    const response = await POST(
      new Request('https://clipendpoint.cc/api/setup/exchange', {
        method: 'POST',
        body: JSON.stringify({ token: issued.token }),
      }),
    );
    expect(response.status).toBe(204);
    const cookie = response.headers.get('Set-Cookie')!;
    const browserRequest = new NextRequest('https://clipendpoint.cc/setup/data', {
      headers: { Cookie: cookie.split(';')[0] },
    });
    const bearer = browserRequest.cookies.get(ADMIN_SESSION_COOKIE_NAME)!.value;

    expect(await authenticateAdminSession(bearer)).toEqual({ guildId, userId });
  });

  test('a second exchange of the same token fails', async () => {
    const guildId = trackedGuildId();
    const issued = await issueSetupToken(guildId, fakeSnowflake());

    expect(await exchangeSetupToken(issued.token)).not.toBeNull();
    expect(await exchangeSetupToken(issued.token)).toBeNull();

    expect(await prisma.adminSession.count({ where: { guildId } })).toBe(1);
  });

  test('an expired token fails', async () => {
    const guildId = trackedGuildId();
    const issuedAt = new Date(Date.now() - SETUP_TOKEN_TTL_MS - 1000);

    const issued = await issueSetupToken(guildId, fakeSnowflake(), issuedAt);

    expect(await exchangeSetupToken(issued.token)).toBeNull();
    expect(await prisma.adminSession.count({ where: { guildId } })).toBe(0);
  });

  test('an unknown token fails the same way a used or expired one does', async () => {
    expect(await exchangeSetupToken('not-a-token-we-ever-issued')).toBeNull();
  });

  test('simultaneous exchanges of one token produce exactly one winner', async () => {
    const guildId = trackedGuildId();
    const userId = fakeSnowflake();
    const issued = await issueSetupToken(guildId, userId);

    // The callers only genuinely overlap on a warm connection pool. Cold, the
    // pool opens a connection per caller and the first one to finish its
    // handshake completes its whole exchange while the rest are still
    // connecting -- which would let a check-then-write implementation pass.
    await Promise.all(
      Array.from({ length: CONCURRENT_CALLERS }, () =>
        prisma.setupToken.count({ where: { guildId } }),
      ),
    );

    // More callers than the two the invariant names: every extra caller widens
    // the window in which a check-then-write implementation could interleave a
    // read before the winner's write lands.
    const attempts = await Promise.allSettled(
      Array.from({ length: CONCURRENT_CALLERS }, () => exchangeSetupToken(issued.token)),
    );

    const grants = attempts.filter(
      (attempt) => attempt.status === 'fulfilled' && attempt.value !== null,
    );
    expect(grants).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(0);

    // The decisive assertion: a losing caller must not have minted a session.
    expect(await prisma.adminSession.count({ where: { guildId } })).toBe(1);
  });

  test('a token survives a failed session insert and can be exchanged again', async () => {
    const guildId = trackedGuildId();
    const userId = fakeSnowflake();
    const issued = await issueSetupToken(guildId, userId);
    const setupTokenHash = hashBearerToken(issued.token, SESSION_SECRET);
    const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS);

    // A real primary key collision rather than a stubbed failure:
    // `admin_sessions.token_hash` is the table's id, so the insert fails inside
    // the transaction exactly as any genuine write failure would.
    const collidingHash = hashBearerToken('a-session-token-already-minted', SESSION_SECRET);
    await prisma.adminSession.create({
      data: { tokenHash: collidingHash, guildId, userId, expiresAt },
    });

    await expect(
      exchangeSetupTokenForSession(
        setupTokenHash,
        { tokenHash: collidingHash, expiresAt },
        new Date(),
      ),
    ).rejects.toThrow();

    // The consumption rolled back with the insert, so the token is still live
    // for the rest of its TTL and the admin can simply retry the link.
    const row = await prisma.setupToken.findUniqueOrThrow({
      where: { tokenHash: setupTokenHash },
    });
    expect(row.usedAt).toBeNull();
    expect(await exchangeSetupToken(issued.token)).toMatchObject({ guildId, userId });
  });

  test('an expired session fails', async () => {
    const guildId = trackedGuildId();
    const exchangedAt = new Date(Date.now() - ADMIN_SESSION_TTL_MS - 1000);

    const issued = await issueSetupToken(guildId, fakeSnowflake(), exchangedAt);
    const grant = await exchangeSetupToken(issued.token, exchangedAt);

    expect(await authenticateAdminSession(grant!.token)).toBeNull();
  });

  test('a revoked session fails before its expiry', async () => {
    const guildId = trackedGuildId();
    const issued = await issueSetupToken(guildId, fakeSnowflake());
    const grant = await exchangeSetupToken(issued.token);

    await prisma.adminSession.update({
      where: { tokenHash: hashBearerToken(grant!.token, SESSION_SECRET) },
      data: { revokedAt: new Date() },
    });

    expect(await authenticateAdminSession(grant!.token)).toBeNull();
  });

  test('an unknown session token fails', async () => {
    expect(await authenticateAdminSession('not-a-session-we-ever-issued')).toBeNull();
  });
  // #72: a used link re-opened (re-click, reload, retry after a lost response)
  // is answered by the server, which knows the token's guild and user -- the
  // browser tab cannot tell which guild a link belongs to.
  describe('re-opening a used link', () => {
    function exchangeRequest(token: string, cookie?: string): Request {
      return new Request('https://clipendpoint.cc/api/setup/exchange', {
        method: 'POST',
        headers: cookie ? { Cookie: cookie } : {},
        body: JSON.stringify({ token }),
      });
    }

    async function openLink(guildId: string, userId: string) {
      const issued = await issueSetupToken(guildId, userId);
      const response = await POST(exchangeRequest(issued.token));
      expect(response.status).toBe(204);
      return { token: issued.token, cookie: response.headers.get('Set-Cookie')!.split(';')[0] };
    }

    test('succeeds with a live session for the token\'s own guild and user, minting nothing', async () => {
      const guildId = trackedGuildId();
      const link = await openLink(guildId, fakeSnowflake());

      const response = await POST(exchangeRequest(link.token, link.cookie));

      expect(response.status).toBe(204);
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect(await prisma.adminSession.count({ where: { guildId } })).toBe(1);
    });

    test('is refused with another guild\'s session', async () => {
      const userId = fakeSnowflake();
      const linkA = await openLink(trackedGuildId(), userId);
      const linkB = await openLink(trackedGuildId(), userId);

      expect((await POST(exchangeRequest(linkA.token, linkB.cookie))).status).toBe(401);
    });

    test('is refused with another user\'s session for the same guild', async () => {
      const guildId = trackedGuildId();
      const mine = await openLink(guildId, fakeSnowflake());
      const theirs = await openLink(guildId, fakeSnowflake());

      expect((await POST(exchangeRequest(mine.token, theirs.cookie))).status).toBe(401);
    });

    test('is refused with no session', async () => {
      const link = await openLink(trackedGuildId(), fakeSnowflake());

      expect((await POST(exchangeRequest(link.token))).status).toBe(401);
    });

    test('is refused when its own session has expired', async () => {
      const guildId = trackedGuildId();
      const link = await openLink(guildId, fakeSnowflake());
      await prisma.adminSession.updateMany({ where: { guildId }, data: { expiresAt: new Date(Date.now() - 1000) } });

      expect((await POST(exchangeRequest(link.token, link.cookie))).status).toBe(401);
    });

    test('is refused once the link itself has expired, even with a live session', async () => {
      const guildId = trackedGuildId();
      const link = await openLink(guildId, fakeSnowflake());
      await prisma.setupToken.updateMany({ where: { guildId }, data: { expiresAt: new Date(Date.now() - 1000) } });

      expect((await POST(exchangeRequest(link.token, link.cookie))).status).toBe(401);
    });
  });
});
