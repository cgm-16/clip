import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { authenticateAdminSession, sessionTokenHash } from '@/lib/admin-session/service';
import type { AdminIdentity } from '@/lib/admin-session/repository';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/admin-session/tokens';
import { parseEnv } from '@/lib/env';

export type AdminAuth = { identity: AdminIdentity; sessionTokenHash: string };

export const PRIVATE_NO_STORE: HeadersInit = { 'Cache-Control': 'private, no-store' };

/**
 * The live session behind `sessionToken`, if it belongs to `guildId`.
 *
 * A session for a different guild is treated exactly like no session, so the
 * guild id in a path or body never confers authority and the response says
 * nothing about whether that guild exists.
 */
async function authenticate(sessionToken: string | undefined, guildId: string): Promise<AdminAuth | null> {
  if (!sessionToken) {
    return null;
  }
  const identity = await authenticateAdminSession(sessionToken);
  if (identity === null || identity.guildId !== guildId) {
    return null;
  }
  return { identity, sessionTokenHash: sessionTokenHash(sessionToken) };
}

export function authenticateAdminRequest(request: NextRequest, guildId: string): Promise<AdminAuth | null> {
  return authenticate(request.cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value, guildId);
}

export async function authenticateAdminPage(guildId: string): Promise<AdminAuth | null> {
  return authenticate((await cookies()).get(ADMIN_SESSION_COOKIE_NAME)?.value, guildId);
}

/**
 * CSRF guard for admin POSTs. The Origin check matches `/setup/save`'s, and
 * a request with no Origin passes it -- so JSON is also required: a
 * cross-site form or `text/plain` POST cannot set it without a CORS
 * preflight, which this app never grants.
 */
export function rejectUnsafeMutation(request: NextRequest): Response | null {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== parseEnv(process.env).PUBLIC_BASE_URL) {
    return new Response(null, { status: 403 });
  }
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(contentType)) {
    return new Response(null, { status: 415 });
  }
  return null;
}
