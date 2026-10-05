import type { NextRequest } from 'next/server';
import { authenticateAdminSession } from '@/lib/admin-session/service';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/admin-session/tokens';
import {
  createDiscordGuildLookup,
  GuildUnavailableError,
} from '@/lib/discord/guild-lookup';
import { parseEnv } from '@/lib/env';

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
export async function GET(request: NextRequest) {
  const sessionToken = request.cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value;
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
