import { createHmac, randomBytes } from 'node:crypto';

// Product spec §5.1: a setup token is valid for approximately 15 minutes and
// the admin session for approximately 30 minutes with no refresh. The Korean
// copy on Screen A (`발급 후 15분`) is authoritative for the token TTL.
export const SETUP_TOKEN_TTL_MS = 15 * 60 * 1000;
export const ADMIN_SESSION_TTL_MS = 30 * 60 * 1000;

export const ADMIN_SESSION_COOKIE_NAME = 'clip_admin_session';

// 256 bits of entropy: the setup token travels in a URL path segment and the
// session token in a cookie, so both are guessable-in-principle bearer values
// whose only defence is being too large to search.
const BEARER_TOKEN_BYTES = 32;

/** Mints a bearer value. The caller sees it once; only its hash is stored. */
export function generateBearerToken(): string {
  return randomBytes(BEARER_TOKEN_BYTES).toString('base64url');
}

/**
 * Derives the stored form of a bearer token.
 *
 * Keyed (HMAC) rather than a bare digest so that a leaked database is not by
 * itself enough to test candidate tokens offline: without ADMIN_SESSION_SECRET
 * an attacker cannot compute the hash of a guess to compare against a row.
 * Hex, because `token_hash` is the string primary key of both tables.
 */
export function hashBearerToken(bearer: string, secret: string): string {
  return createHmac('sha256', secret).update(bearer).digest('hex');
}
