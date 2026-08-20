import { z } from 'zod';
import { authenticateAdminSession } from '@/lib/admin-session/service';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/admin-session/tokens';
import { countArchivedClips, upsertGuildArchiveConfig } from '@/lib/clip/repository';
import {
  createDiscordGuildLookup,
  GuildUnavailableError,
} from '@/lib/discord/guild-lookup';
import { createDiscordRestClient, DiscordApiError } from '@/lib/discord/rest-client';
import { parseEnv } from '@/lib/env';

/**
 * Reads one cookie's value out of a raw `Cookie` request header. Duplicated
 * from `app/setup/data/route.ts` rather than shared: that route's own doc
 * comment explains why it reads headers directly off the `Request` instead
 * of `next/headers`' `cookies()` helper, and this stays consistent with it.
 * Two call sites, not three -- see CLAUDE.md's rule-of-three DRY guidance --
 * so this is noted rather than extracted.
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

// `channelId` is required only for "existing" -- "create" never carries a
// caller-chosen id (see `SetupSubmission` in `ScreenB.tsx`, which this
// mirrors exactly rather than inventing a different shape).
const SaveRequestSchema = z
  .object({
    destination: z.enum(['create', 'existing']),
    channelId: z.string().min(1).nullable(),
  })
  .refine((data) => data.destination !== 'existing' || data.channelId !== null, {
    message: 'channelId is required when destination is "existing"',
  });

// Discord channel type for a standard text channel
// (developers.discord.com/docs/resources/channel#channel-object-channel-types).
// Duplicated locally rather than imported from `lib/discord/guild-lookup.ts`,
// which does not export it -- the same per-file convention that module's own
// test file already follows.
const GUILD_TEXT_CHANNEL_TYPE = 0;

// A permission overwrite's `type`: 0 targets a role. The guild id doubles as
// the `@everyone` role's id, so an overwrite keyed on it denies everyone.
const ROLE_OVERWRITE_TYPE = 0;

// VIEW_CHANNEL, from Discord's permission bitflags
// (developers.discord.com/docs/topics/permissions#permissions-bitwise-permission-flags).
// `lib/discord/permissions.ts` only exports the one flag it currently tests
// (`MANAGE_GUILD`); this stays local rather than growing that file for a
// second caller, matching `guild-lookup.ts`'s own `UNKNOWN_GUILD` precedent.
const VIEW_CHANNEL_PERMISSION = 1n << 10n;

const ARCHIVE_CHANNEL_NAME = 'clip-archive';

function parseCreatedChannel(body: unknown): { id: string; name: string } | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { id, name } = body as { id?: unknown; name?: unknown };
  if (typeof id !== 'string' || typeof name !== 'string') {
    return null;
  }
  return { id, name };
}

/**
 * `SetupFlow`'s save target -- persists the archive destination an admin
 * chose on Screen B (`docs/06_DESIGN_HANDOFF.md` "Screen B"). Session-gated
 * the same way `app/setup/data/route.ts` is: the guild id always comes from
 * the admin session, never the request body, since trusting a body-supplied
 * guild id would let an admin of one guild configure another.
 *
 * "existing channel" re-validates the submitted id against the guild's own
 * eligible channels server-side (never trusting the client's list); "create"
 * asks Discord to make a new private `#clip-archive` and use that instead.
 * Either way the result is persisted with `upsertGuildArchiveConfig`, an
 * upsert so re-running setup for an already-configured guild updates in
 * place rather than duplicating or throwing.
 *
 * Allowed-role configuration is cut from P0 per the task brief; only the
 * archive channel and who configured it are persisted here.
 */
export async function POST(request: Request) {
  // Same CSRF reasoning as `app/api/setup/exchange/route.ts`: `request.json()`
  // ignores Content-Type, so a cross-origin `text/plain` POST is a CORS
  // *simple* request with no preflight, and the admin session cookie is sent
  // regardless (`SameSite=Lax` governs cross-site *navigations*, not a
  // same-site-classified simple POST). Without this check any site could
  // reconfigure an admin's guild archive from their own browser session.
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== parseEnv(process.env).PUBLIC_BASE_URL) {
    return new Response(null, { status: 403 });
  }

  const sessionToken = readCookie(request.headers.get('Cookie'), ADMIN_SESSION_COOKIE_NAME);
  if (!sessionToken) {
    return new Response(null, { status: 401 });
  }

  const identity = await authenticateAdminSession(sessionToken);
  if (!identity) {
    return new Response(null, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = SaveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(null, { status: 400 });
  }
  const { destination, channelId } = parsed.data;

  const env = parseEnv(process.env);
  const guildId = identity.guildId;

  let archiveChannelId: string;
  let archiveChannelName: string;

  try {
    if (destination === 'existing') {
      const lookup = createDiscordGuildLookup({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });
      const { channels } = await lookup.getGuildSetupTargets(guildId);
      // The client's own channel list is never trusted -- re-checked against
      // this guild's eligible channels, fetched fresh from Discord.
      const eligible = channels.find((channel) => channel.id === channelId);
      if (!eligible) {
        return new Response(null, { status: 422 });
      }
      archiveChannelId = eligible.id;
      archiveChannelName = eligible.name;
    } else {
      const client = createDiscordRestClient({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });
      const created = await client.request('POST', `/guilds/${guildId}/channels`, {
        name: ARCHIVE_CHANNEL_NAME,
        type: GUILD_TEXT_CHANNEL_TYPE,
        // Private by default (spec §5.3): deny VIEW_CHANNEL for @everyone.
        // A guild Administrator sees it regardless -- Discord never lets a
        // channel overwrite narrow ADMINISTRATOR's access.
        permission_overwrites: [
          {
            id: guildId,
            type: ROLE_OVERWRITE_TYPE,
            deny: VIEW_CHANNEL_PERMISSION.toString(),
          },
        ],
      });
      const parsedChannel = parseCreatedChannel(created);
      if (!parsedChannel) {
        return new Response(null, { status: 502 });
      }
      archiveChannelId = parsedChannel.id;
      archiveChannelName = parsedChannel.name;
    }
  } catch (error) {
    // GuildUnavailableError: the bot can no longer see this guild (kicked,
    // guild deleted) -- same distinction `app/setup/data/route.ts` draws.
    // Anything else (a lookup failure, a DiscordApiError creating the
    // channel -- e.g. MANAGE_CHANNELS was revoked) is a Discord-side failure,
    // not the session's.
    if (error instanceof GuildUnavailableError) {
      return new Response(null, { status: 404 });
    }
    if (error instanceof DiscordApiError) {
      return new Response(null, { status: 502 });
    }
    throw error;
  }

  await upsertGuildArchiveConfig({
    guildId,
    archiveChannelId,
    configuredByUserId: identity.userId,
  });
  const clipCount = await countArchivedClips(guildId);

  return Response.json({
    archiveChannelId,
    archiveChannelName,
    autoCreated: destination === 'create',
    clipCount,
  });
}
