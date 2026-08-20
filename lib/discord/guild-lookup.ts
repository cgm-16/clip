import {
  createDiscordRestClient,
  DiscordApiError,
  DISCORD_ERROR,
  type DiscordRestClient,
} from '@/lib/discord/rest-client';

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
 * is attempted, not here.
 */
const ARCHIVABLE_CHANNEL_TYPES: ReadonlySet<number> = new Set([GUILD_TEXT]);

export type SetupChannel = {
  id: string;
  name: string;
  type: number;
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

export type DiscordGuildLookupOptions = {
  botToken: string;
  fetchImpl: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type DiscordGuildLookup = {
  /** The channels a setup form may offer as archive destinations for one guild. */
  getGuildSetupChannels(guildId: string): Promise<SetupChannel[]>;
};

export function createDiscordGuildLookup(options: DiscordGuildLookupOptions): DiscordGuildLookup {
  const client: DiscordRestClient = createDiscordRestClient(options);

  async function fetchGuildChannels(guildId: string) {
    try {
      return await client.request('GET', `/guilds/${guildId}/channels`);
    } catch (error) {
      if (error instanceof DiscordApiError && isGuildUnavailable(error)) {
        throw new GuildUnavailableError('guild channels could not be read');
      }
      throw new GuildLookupFailedError('could not read guild channels', {
        retryable: error instanceof DiscordApiError ? error.retryable : true,
      });
    }
  }

  return {
    async getGuildSetupChannels(guildId: string): Promise<SetupChannel[]> {
      return parseChannels(await fetchGuildChannels(guildId));
    },
  };
}
