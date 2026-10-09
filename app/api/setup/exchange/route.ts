import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { exchangeSetupToken, findReopenableSetupTokenGuild } from '@/lib/admin-session/service';
import { parseEnv } from '@/lib/env';
import { ADMIN_SESSION_COOKIE_NAME, ADMIN_SESSION_TTL_MS } from '@/lib/admin-session/tokens';

const ExchangeRequestSchema = z.object({ token: z.string().min(1) });

// POST, not GET: a one-time token in a URL a browser can prefetch, or a chat
// client can unfurl, would be consumed before the admin ever clicks it.
export async function POST(request: Request) {
  // `request.json()` ignores Content-Type, so a cross-origin `text/plain` POST
  // is a CORS *simple* request and never gets a preflight. SameSite=Lax governs
  // whether a cookie is *sent*, not whether one may be *set*, so without this
  // check any site could plant its own guild's admin session in an admin's
  // browser and have them operate on the wrong guild.
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== parseEnv(process.env).PUBLIC_BASE_URL) {
    return new Response(null, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = ExchangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(null, { status: 400 });
  }

  const grant = await exchangeSetupToken(parsed.data.token);
  if (!grant) {
    // A used link re-opened by the admin it was spent for (#72) is confirmed
    // without minting anything; the existing session cookie stays as it is.
    const sessionToken = new NextRequest(request.url, { headers: request.headers }).cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value;
    const reopenedGuildId =
      sessionToken === undefined ? null : await findReopenableSetupTokenGuild(parsed.data.token, sessionToken);
    if (reopenedGuildId !== null) {
      return Response.json({ guildId: reopenedGuildId });
    }
    // Unknown, expired and already-used tokens are one indistinguishable
    // failure; Screen A's copy covers all three (product spec §17 case 2).
    return new Response(null, { status: 401 });
  }

  // Both successes name the token's guild: the browser holds one session
  // cookie, which another tab's link can replace before this tab loads its
  // setup data, and the guild is how the tab tells its own session apart.
  const response = NextResponse.json({ guildId: grant.guildId });
  // Path=/ reaches the setup pages and their APIs. Secure stays conditional
  // so local development over plain http can send the cookie back.
  // NODE_ENV is set by the framework, not part of the validated Env schema.
  response.cookies.set(ADMIN_SESSION_COOKIE_NAME, grant.token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ADMIN_SESSION_TTL_MS / 1000,
    secure: process.env.NODE_ENV === 'production',
  });
  return response;
}
