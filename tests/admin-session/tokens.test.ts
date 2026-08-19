import { describe, expect, test, vi } from 'vitest';
import {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  SETUP_TOKEN_TTL_MS,
  buildAdminSessionCookie,
  generateBearerToken,
  hashBearerToken,
} from '@/lib/admin-session/tokens';

const SECRET = 'x'.repeat(32);

describe('setup/session token primitives', () => {
  test('the TTLs match the authoritative Korean copy: 15 minutes and 30 minutes', () => {
    expect(SETUP_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
    expect(ADMIN_SESSION_TTL_MS).toBe(30 * 60 * 1000);
  });

  test('generated bearer tokens are URL-safe and unpredictable', () => {
    const first = generateBearerToken();
    const second = generateBearerToken();

    expect(first).not.toBe(second);
    // 32 random bytes in base64url; the value travels in a path segment.
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('the hash is a keyed digest that never contains the bearer value', () => {
    const bearer = generateBearerToken();
    const hash = hashBearerToken(bearer, SECRET);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(bearer);
    expect(hashBearerToken(bearer, SECRET)).toBe(hash);
    expect(hashBearerToken(bearer, 'y'.repeat(32))).not.toBe(hash);
  });

  test('the session cookie is HttpOnly, SameSite=Lax and expires with the session', () => {
    const cookie = buildAdminSessionCookie('bearer-value');

    expect(cookie.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=bearer-value;`)).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`);
  });

  test('the cookie is Secure in production only, so local http development still works', () => {
    expect(buildAdminSessionCookie('bearer-value')).not.toContain('Secure');

    vi.stubEnv('NODE_ENV', 'production');
    expect(buildAdminSessionCookie('bearer-value')).toContain('Secure');
    vi.unstubAllEnvs();
  });
});
