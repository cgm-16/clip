import { parseEnv } from '@/lib/env';
import {
  consumeSetupToken,
  findLiveAdminSession,
  insertAdminSession,
  insertSetupToken,
  type AdminIdentity,
} from '@/lib/admin-session/repository';
import {
  ADMIN_SESSION_TTL_MS,
  SETUP_TOKEN_TTL_MS,
  generateBearerToken,
  hashBearerToken,
} from '@/lib/admin-session/tokens';

/**
 * A credential handed to its holder. `token` is the bearer value and is
 * returned exactly once, at creation: only its hash is stored, so it cannot
 * be recovered afterwards by us or by anyone who reads the database.
 */
export type IssuedCredential = {
  token: string;
  expiresAt: Date;
};

export type AdminSessionGrant = IssuedCredential & AdminIdentity;

// parseEnv is called per operation rather than at module load so a missing
// env var fails a request, not the build (env vars are absent in CI).
function sessionSecret(): string {
  return parseEnv(process.env).ADMIN_SESSION_SECRET;
}

/**
 * Issues the one-time setup token behind the ephemeral `Configure Clip` link
 * (product spec §5.1). `/setup` is its only caller.
 */
export async function issueSetupToken(
  guildId: string,
  userId: string,
  now: Date = new Date(),
): Promise<IssuedCredential> {
  const token = generateBearerToken();
  const expiresAt = new Date(now.getTime() + SETUP_TOKEN_TTL_MS);

  await insertSetupToken({
    tokenHash: hashBearerToken(token, sessionSecret()),
    guildId,
    userId,
    expiresAt,
  });

  return { token, expiresAt };
}

/**
 * Exchanges a setup token for a short admin session, at most once per token.
 *
 * Returns null for an unknown, already used, or expired token alike. The
 * caller must not distinguish them: Screen A tells the admin
 * `이미 사용된 링크일 수도 있습니다` precisely so that one recovery message covers
 * every failure and none of them confirms that a token ever existed.
 */
export async function exchangeSetupToken(
  setupToken: string,
  now: Date = new Date(),
): Promise<AdminSessionGrant | null> {
  const secret = sessionSecret();

  const identity = await consumeSetupToken(hashBearerToken(setupToken, secret), now);
  if (!identity) {
    return null;
  }

  const token = generateBearerToken();
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
  await insertAdminSession({
    tokenHash: hashBearerToken(token, secret),
    guildId: identity.guildId,
    userId: identity.userId,
    expiresAt,
  });

  return { token, expiresAt, ...identity };
}

/**
 * Resolves the admin a session cookie belongs to, or null if the session is
 * unknown, expired, or revoked (product spec §17 case 3). The identity comes
 * from the session row, never from anything the browser sends alongside it.
 */
export async function authenticateAdminSession(
  sessionToken: string,
  now: Date = new Date(),
): Promise<AdminIdentity | null> {
  return findLiveAdminSession(hashBearerToken(sessionToken, sessionSecret()), now);
}
