import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticateAdminRequest, PRIVATE_NO_STORE, rejectUnsafeMutation } from '@/lib/admin/auth';
import { loadArchiveContent, MAX_CONTENT_BATCH } from '@/lib/archive/content';
import { createDiscordGuildLookup } from '@/lib/discord/guild-lookup';
import { createDiscordRestClient } from '@/lib/discord/rest-client';
import { parseEnv } from '@/lib/env';

const ContentRequestSchema = z.object({
  sourceMessageIds: z.array(z.string().min(1).max(32)).min(1).max(MAX_CONTENT_BATCH),
});

/** Screen D's per-page content read. A POST only to carry the id list; it changes nothing. */
export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/admin/guilds/[guildId]/archive/content'>,
) {
  const unsafe = rejectUnsafeMutation(request);
  if (unsafe) {
    return unsafe;
  }
  const { guildId } = await context.params;
  if (!(await authenticateAdminRequest(request, guildId))) {
    return new Response(null, { status: 401, headers: PRIVATE_NO_STORE });
  }
  const parsed = ContentRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new Response(null, { status: 400, headers: PRIVATE_NO_STORE });
  }
  const env = parseEnv(process.env);
  const options = { botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch };
  const lookup = createDiscordGuildLookup(options);
  const result = await loadArchiveContent({
    guildId,
    sourceMessageIds: parsed.data.sourceMessageIds,
    client: createDiscordRestClient(options),
    lookupUserName: (userId) => lookup.getUserHandle(userId),
  });
  if (result.kind === 'INVALID') {
    return new Response(null, { status: 400, headers: PRIVATE_NO_STORE });
  }
  return Response.json({ items: result.items }, { headers: PRIVATE_NO_STORE });
}
