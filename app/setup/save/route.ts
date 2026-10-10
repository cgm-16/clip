import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticateAdminSession, sessionTokenHash } from '@/lib/admin-session/service';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/admin-session/tokens';
import {
  countArchivedClips,
  finalizeGuildArchiveConfig,
  findGuildArchiveConfig,
  hasLiveClips,
} from '@/lib/clip/repository';
import {
  createDiscordGuildLookup,
  GuildLookupFailedError,
  GuildUnavailableError,
} from '@/lib/discord/guild-lookup';
import { getDiscordBotUserId } from '@/lib/discord/bot-user';
import {
  computeChannelPermissions,
  missingArchivePermissions,
  PERMISSION,
} from '@/lib/discord/permissions';
import { createDiscordRestClient, DiscordApiError } from '@/lib/discord/rest-client';
import { parseEnv } from '@/lib/env';
import { logClipEvent } from '@/lib/logging/safe-log';

// `channelId` is required only for "existing" -- "create" never carries a
// caller-chosen id (see `SetupSubmission` in `ScreenB.tsx`, which this
// mirrors rather than inventing a different shape). `guildId` is the one
// addition: the guild the client's form was rendered for.
const SaveRequestSchema = z
  .object({
    guildId: z.string().min(1),
    destination: z.enum(['create', 'existing']),
    channelId: z.string().min(1).nullable(),
    allowedRoleIds: z.array(z.string().min(1)).max(250),
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

// A permission overwrite's `type`: 0 targets a role, 1 targets a member. The
// guild id doubles as the `@everyone` role's id, so a `type: 0` overwrite
// keyed on it denies everyone; a `type: 1` overwrite keyed on the authenticated
// bot user's id targets the bot.
const ROLE_OVERWRITE_TYPE = 0;
const MEMBER_OVERWRITE_TYPE = 1;

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
 * Either way the result is persisted only after a final locked recheck, so a
 * Clip claimed during the Discord round-trip cannot be orphaned by the save.
 *
 * Allowed roles are validated against a fresh role list and replace the
 * configured set in the same transaction as the destination. An existing
 * channel is accepted only if the bot's effective permissions there cover
 * what the archive needs; that check reads Discord and never writes to it.
 */
export async function POST(request: NextRequest) {
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

  const sessionToken = request.cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value;
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
  // The browser holds one session cookie, and another tab's setup link can
  // replace it after this form rendered; the client names the guild it
  // rendered for, so a save never lands on whichever guild the cookie holds now.
  if (parsed.data.guildId !== identity.guildId) {
    return new Response(null, { status: 401 });
  }
  const { destination, channelId } = parsed.data;
  const requestedRoleIds = [...new Set(parsed.data.allowedRoleIds)];

  const env = parseEnv(process.env);
  const guildId = identity.guildId;

  // Finding C3: `Clip` rows carry no archive channel id of their own, only
  // `GuildConfig.archiveChannelId` does -- so repointing that field while a
  // live Clip still depends on the old channel strands its archive there
  // with nothing left able to address it (see `hasLiveClips`'s doc comment
  // in `lib/clip/repository.ts`). Setting the channel for the first time
  // (`existingConfig === null`) is always allowed; re-selecting the guild's
  // already-configured channel is a no-op, not a reconfigure, so it is
  // allowed too even with live Clips. "create" always makes a brand-new
  // channel, so it is a reconfigure whenever a config already exists.
  //
  // The one exception: Discord confirms the current archive channel itself
  // is gone. Its archive messages went with it, so there is nothing left to
  // strand, and refusing would leave the guild with no way to set a new
  // archive short of deleting its data (Ori, 2026-10-09, #58).
  const existingConfig = await findGuildArchiveConfig(guildId);
  const isReconfigure =
    existingConfig !== null &&
    (destination === 'create' || existingConfig.archiveChannelId !== channelId);
  let goneArchiveChannelId: string | undefined;
  if (isReconfigure && (await hasLiveClips(guildId))) {
    const lookup = createDiscordGuildLookup({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });
    if (!(await lookup.isChannelGone(existingConfig.archiveChannelId))) {
      return liveClipsConflict();
    }
    goneArchiveChannelId = existingConfig.archiveChannelId;
  }

  let archiveChannelId: string;
  let archiveChannelName: string;
  let allowedRoles: { id: string; name: string }[];

  try {
    const lookup = createDiscordGuildLookup({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });
    // One role read serves both the allowed-role validation and the
    // existing channel's permission computation.
    const roles = await lookup.getGuildRoles(guildId);
    const roleNames = new Map(roles.map((role) => [role.id, role.name]));
    // `@everyone` (id === guild id) is never a clipping role, and an id
    // missing from this guild's roles -- deleted, or another guild's -- is
    // refused rather than silently dropped.
    if (requestedRoleIds.some((roleId) => roleId === guildId || !roleNames.has(roleId))) {
      return Response.json({ reason: 'INVALID_ROLE' }, { status: 422 });
    }
    allowedRoles = requestedRoleIds.map((id) => ({ id, name: roleNames.get(id)! }));

    const botUserId = await getDiscordBotUserId({
      botToken: env.DISCORD_BOT_TOKEN,
      fetchImpl: fetch,
    });
    if (!botUserId) {
      return new Response(null, { status: 502 });
    }

    if (destination === 'existing') {
      const channels = await lookup.getGuildSetupChannels(guildId);
      // The client's own channel list is never trusted -- re-checked against
      // this guild's eligible channels, fetched fresh from Discord.
      const eligible = channels.find((channel) => channel.id === channelId);
      if (!eligible) {
        return Response.json({ reason: 'INVALID_CHANNEL' }, { status: 422 });
      }
      const [memberRoleIds, overwrites] = await Promise.all([
        lookup.getMemberRoleIds(guildId, botUserId),
        lookup.getChannelOverwrites(eligible.id),
      ]);
      const missingPermissions = missingArchivePermissions(
        computeChannelPermissions({
          guildId,
          memberId: botUserId,
          memberRoleIds,
          rolePermissions: new Map(roles.map((role) => [role.id, role.permissions])),
          overwrites,
        }),
      );
      if (missingPermissions.length > 0) {
        return Response.json({ reason: 'MISSING_PERMISSIONS', missingPermissions }, { status: 422 });
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
        //
        // The bot itself is not exempt from the @everyone deny above: it
        // holds no ADMINISTRATOR (spec §15) and its managed role carries no
        // overwrite of its own, so without a second, explicit member
        // overwrite here it could not see the private channel it just
        // created. VIEW_CHANNEL lets it address the channel at all;
        // SEND_MESSAGES is what `archive-message.ts`'s provenance and
        // forward posts need once it can; READ_MESSAGE_HISTORY is what the
        // admin archive's content reads need. Nothing broader: deleting the
        // bot's own messages needs no permission, and the create call above
        // already ran on the guild-level MANAGE_CHANNELS the bot holds, not
        // a channel overwrite.
        permission_overwrites: [
          {
            id: guildId,
            type: ROLE_OVERWRITE_TYPE,
            deny: PERMISSION.VIEW_CHANNEL.toString(),
          },
          {
            id: botUserId,
            type: MEMBER_OVERWRITE_TYPE,
            allow: (
              PERMISSION.VIEW_CHANNEL |
              PERMISSION.SEND_MESSAGES |
              PERMISSION.READ_MESSAGE_HISTORY
            ).toString(),
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
    if (error instanceof DiscordApiError || error instanceof GuildLookupFailedError) {
      return new Response(null, { status: 502 });
    }
    throw error;
  }

  // A channel this request auto-created that the save then did not keep.
  async function deleteCreatedChannel(): Promise<void> {
    const client = createDiscordRestClient({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });
    try {
      await client.request('DELETE', `/channels/${archiveChannelId}`);
    } catch (error) {
      logClipEvent({
        event: 'setup.archive-channel-cleanup-failed',
        guildId,
        errorCode:
          error instanceof DiscordApiError
            ? String(error.code ?? error.status)
            : 'UNKNOWN',
      });
    }
  }

  const finalized = await finalizeGuildArchiveConfig({
    guildId,
    archiveChannelId,
    configuredByUserId: identity.userId,
    allowedRoleIds: requestedRoleIds,
    sessionTokenHash: sessionTokenHash(sessionToken),
    goneArchiveChannelId,
  });
  if (finalized.kind === 'CONFLICT') {
    if (destination === 'create') {
      await deleteCreatedChannel();
    }
    return liveClipsConflict();
  }
  if (finalized.kind === 'SESSION_REVOKED') {
    // A guild-data deletion revoked this session after it was authenticated;
    // the save must not leave a channel the deleted configuration never owned.
    if (destination === 'create') {
      await deleteCreatedChannel();
    }
    return new Response(null, { status: 401 });
  }
  const clipCount = await countArchivedClips(guildId);

  return Response.json({
    archiveChannelId,
    archiveChannelName,
    autoCreated: destination === 'create',
    clipCount,
    allowedRoles,
  });
}

/** Live Clips depend on the current archive channel (finding C3). */
function liveClipsConflict(): Response {
  return Response.json({ reason: 'LIVE_CLIPS' }, { status: 409 });
}
