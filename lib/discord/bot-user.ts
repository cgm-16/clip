import { createDiscordRestClient } from '@/lib/discord/rest-client';

export type DiscordBotUserLookupOptions = {
  botToken: string;
  fetchImpl: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export async function getDiscordBotUserId(options: DiscordBotUserLookupOptions): Promise<string | null> {
  const client = createDiscordRestClient(options);
  const user = await client.request('GET', '/users/@me');
  if (typeof user !== 'object' || user === null) {
    return null;
  }
  const { id } = user as { id?: unknown };
  return typeof id === 'string' && id !== '' ? id : null;
}
