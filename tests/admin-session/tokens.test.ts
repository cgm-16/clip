import { describe, expect, test } from 'vitest';
import {
  ADMIN_SESSION_TTL_MS,
  SETUP_TOKEN_TTL_MS,
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
});
