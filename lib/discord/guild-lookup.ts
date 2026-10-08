import {
  createDiscordRestClient,
  DiscordApiError,
  DISCORD_ERROR,
  type DiscordRestClient,
} from '@/lib/discord/rest-client';
import type { PermissionOverwrite } from '@/lib/discord/permissions';

/**
 * Discord channel types this module cares about
 * (developers.discord.com/docs/resources/channel#channel-object-channel-types).
 * Everything else (voice, category, forum, thread, stage, media, DM) is not a
 * channel a plain message can be posted into and is filtered out below.
 */
const GUILD_TEXT = 0;
const GUILD_ANNOUNCEMENT = 5;

/**
 * Channel types the setup form may offer as an archive destination.
 *
 * `GUILD_ANNOUNCEMENT` is deliberately excluded even though the bot can post
 * there: an announcement channel can be followed by other servers, and
 * anything posted to it can be crossposted outside this guild. The archive
 * holds members' preserved messages and the product frames it as
 * server-owned (README); a channel type whose whole purpose is distributing
 * its content elsewhere is the wrong destination for that regardless of
 * whether posting itself would succeed.
 *
 * This is type filtering only, not a permission check. `GET
 * /guilds/{id}/channels` does not return the bot's effective permissions --
 * that needs the bot's own member roles resolved against each channel's
 * overwrites, a request this module does not make. A channel can pass this
 * filter and still reject a later post; that failure surfaces when the post
 * is attempted, not here. `/setup/save` makes that check for the one channel
 * an admin picks, with `computeChannelPermissions` in `permissions.ts`.
 */
const ARCHIVABLE_CHANNEL_TYPES: ReadonlySet<number> = new Set([GUILD_TEXT]);

export type SetupChannel = {
  id: string;
  name: string;
  type: number;
};

/** A guild role with its guild-level permissions. Server-side only. */
export type GuildRole = {
  id: string;
  name: string;
  permissions: bigint;
};

/** A role as the setup page shows it; `@everyone` is listed but not selectable. */
export type SetupRole = {
  id: string;
  name: string;
  selectable: boolean;
};

/** The guild does not exist, or the bot cannot see it. */
export class GuildUnavailableError extends Error {}

/** The lookup could not complete for a reason unrelated to the guild's existence. */
export class GuildLookupFailedError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean }) {
    super(message);
    this.retryable = options.retryable;
  }
}

// Not present in the shared `DISCORD_ERROR` map in `lib/discord/rest-client.ts`
// as of this writing. Kept local rather than added there so this task's
// commit does not touch a file another implementer owns concurrently; belongs
// in the shared map alongside `UNKNOWN_CHANNEL` if a second caller needs it.
const UNKNOWN_GUILD = 10004;

/**
 * Discord error codes that mean "this guild cannot be read" rather than "the
 * attempt failed" -- the same distinction `archive-message.ts` draws for a
 * source message, applied to a guild instead.
 */
function isGuildUnavailable(error: DiscordApiError): boolean {
  if (error.code !== null) {
    return error.code === UNKNOWN_GUILD || error.code === DISCORD_ERROR.MISSING_ACCESS;
  }
  // Discord normally supplies a code. When it does not, 404 and 403 still say
  // plainly that the bot cannot address this guild, which is the same outcome.
  return error.status === 404 || error.status === 403;
}

function parseChannels(body: unknown): SetupChannel[] {
  if (!Array.isArray(body)) {
    return [];
  }
  const channels: SetupChannel[] = [];
  for (const item of body) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    // Only these three fields are lifted off the payload. The response also
    // carries `topic`, `position`, `permission_overwrites` and more, and
    // narrowing here is what keeps them from travelling any further.
    const { id, name, type } = item as { id?: unknown; name?: unknown; type?: unknown };
    if (typeof id !== 'string' || typeof name !== 'string' || typeof type !== 'number') {
      continue;
    }
    if (!ARCHIVABLE_CHANNEL_TYPES.has(type)) {
      continue;
    }
    channels.push({ id, name, type });
  }
  return channels;
}

const DECIMAL = /^\d+$/;

function parseRoles(body: unknown): GuildRole[] {
  if (!Array.isArray(body)) {
    return [];
  }
  const roles: GuildRole[] = [];
  for (const item of body) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const { id, name, permissions } = item as { id?: unknown; name?: unknown; permissions?: unknown };
    if (
      typeof id !== 'string' ||
      typeof name !== 'string' ||
      typeof permissions !== 'string' ||
      !DECIMAL.test(permissions)
    ) {
      continue;
    }
    roles.push({ id, name, permissions: BigInt(permissions) });
  }
  return roles;
}

/**
 * Unlike the parsers above, this one throws instead of skipping: the result
 * feeds a permission check, and an overwrite dropped here could be a deny
 * the bot is subject to. Unreadable overwrites must fail the check, not pass it.
 */
function parseOverwrites(body: unknown): PermissionOverwrite[] {
  const malformed = () => new GuildLookupFailedError('malformed channel overwrites', { retryable: false });
  const raw =
    typeof body === 'object' && body !== null
      ? (body as { permission_overwrites?: unknown }).permission_overwrites
      : undefined;
  if (!Array.isArray(raw)) {
    throw malformed();
  }
  const overwrites: PermissionOverwrite[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw malformed();
    }
    const { id, type, allow, deny } = item as Record<string, unknown>;
    if (typeof id !== 'string' || (type !== 0 && type !== 1)) {
      throw malformed();
    }
    if (typeof allow !== 'string' || typeof deny !== 'string' || !DECIMAL.test(allow) || !DECIMAL.test(deny)) {
      throw malformed();
    }
    overwrites.push({ id, type, allow: BigInt(allow), deny: BigInt(deny) });
  }
  return overwrites;
}

function stringField(body: unknown, field: string): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

export type DiscordGuildLookupOptions = {
  botToken: string;
  fetchImpl: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type DiscordGuildLookup = {
  /** The channels a setup form may offer as archive destinations for one guild. */
  getGuildSetupChannels(guildId: string): Promise<SetupChannel[]>;
  /** Every guild role, `@everyone` (id === guild id) included. */
  getGuildRoles(guildId: string): Promise<GuildRole[]>;
  /** One channel's permission overwrites. Never sent to a browser. */
  getChannelOverwrites(channelId: string): Promise<PermissionOverwrite[]>;
  getMemberRoleIds(guildId: string, userId: string): Promise<string[]>;
  /** Display only: null on any failure, and the caller shows the id instead. */
  getGuildName(guildId: string): Promise<string | null>;
  /** Display only: null on any failure. */
  getUserHandle(userId: string): Promise<string | null>;
};

export function createDiscordGuildLookup(options: DiscordGuildLookupOptions): DiscordGuildLookup {
  const client: DiscordRestClient = createDiscordRestClient(options);

  async function fetchOrThrow(path: string) {
    try {
      return await client.request('GET', path);
    } catch (error) {
      if (error instanceof DiscordApiError && isGuildUnavailable(error)) {
        throw new GuildUnavailableError('guild data could not be read');
      }
      throw new GuildLookupFailedError('could not read guild data', {
        retryable: error instanceof DiscordApiError ? error.retryable : true,
      });
    }
  }

  async function fetchOrNull(path: string) {
    try {
      return await client.request('GET', path);
    } catch {
      return null;
    }
  }

  return {
    async getGuildSetupChannels(guildId: string): Promise<SetupChannel[]> {
      return parseChannels(await fetchOrThrow(`/guilds/${guildId}/channels`));
    },
    async getGuildRoles(guildId: string): Promise<GuildRole[]> {
      return parseRoles(await fetchOrThrow(`/guilds/${guildId}/roles`));
    },
    async getChannelOverwrites(channelId: string): Promise<PermissionOverwrite[]> {
      return parseOverwrites(await fetchOrThrow(`/channels/${channelId}`));
    },
    async getMemberRoleIds(guildId: string, userId: string): Promise<string[]> {
      const body = await fetchOrThrow(`/guilds/${guildId}/members/${userId}`);
      const roles = typeof body === 'object' && body !== null ? (body as { roles?: unknown }).roles : undefined;
      return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === 'string') : [];
    },
    async getGuildName(guildId: string): Promise<string | null> {
      return stringField(await fetchOrNull(`/guilds/${guildId}`), 'name');
    },
    async getUserHandle(userId: string): Promise<string | null> {
      return stringField(await fetchOrNull(`/users/${userId}`), 'username');
    },
  };
}
