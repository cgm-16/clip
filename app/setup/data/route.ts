import { authenticateAdminSession } from '@/lib/admin-session/service';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/admin-session/tokens';
import {
  createDiscordGuildLookup,
  GuildUnavailableError,
} from '@/lib/discord/guild-lookup';
import { parseEnv } from '@/lib/env';

/**
 * Reads one cookie's value out of a raw `Cookie` request header. Not
 * `next/headers`' `cookies()` helper: every other route handler in this
 * codebase (`app/api/setup/exchange/route.ts`, `app/api/discord/interactions
 * /route.ts`) reads headers directly off the `Request`, and this stays
 * consistent with that rather than introducing a second pattern.
 */
function readCookie(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

/**
 * `SetupFlow`'s data source once an admin session cookie exists — the guild
 * id it is scoped to, plus that guild's archivable channels
 * (`lib/discord/guild-lookup.ts`). Not under `/api/setup/`: it lives beside
 * the `/setup/:token` page it exclusively serves, not with the Discord
 * interaction endpoint's API surface.
 *
 * 401 covers both "no cookie" and "cookie doesn't resolve to a live
 * session" identically — `SetupFlow` reacts to either by attempting the
 * setup-token exchange next, not by distinguishing the cause.
 */
export async function GET(request: Request) {
  const sessionToken = readCookie(request.headers.get('Cookie'), ADMIN_SESSION_COOKIE_NAME);
  if (!sessionToken) {
    return new Response(null, { status: 401 });
  }

  const identity = await authenticateAdminSession(sessionToken);
  if (!identity) {
    return new Response(null, { status: 401 });
  }

  const env = parseEnv(process.env);
  const lookup = createDiscordGuildLookup({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });

  try {
    const channels = await lookup.getGuildSetupChannels(identity.guildId);
    return Response.json({ guildId: identity.guildId, channels });
  } catch (error) {
    // GuildUnavailableError: the bot can no longer see this guild (kicked,
    // guild deleted). Anything else (GuildLookupFailedError, a network
    // failure) is a transient failure on Discord's side, not the session's.
    if (error instanceof GuildUnavailableError) {
      return new Response(null, { status: 404 });
    }
    return new Response(null, { status: 502 });
  }
}
