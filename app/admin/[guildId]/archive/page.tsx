import { redirect } from 'next/navigation';
import { SessionExpired } from '@/components/admin/SessionExpired';
import { archiveHref } from '@/lib/admin/archive-href';
import { authenticateAdminPage } from '@/lib/admin/auth';
import { getClipPage } from '@/lib/archive/reader';
import { createDiscordGuildLookup } from '@/lib/discord/guild-lookup';
import { parseEnv } from '@/lib/env';
import { ArchiveScreen } from './ArchiveScreen';

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Screen D. Reading cookies makes this page dynamic, so Next sends private, no-store. */
export default async function ArchivePage({ params, searchParams }: PageProps<'/admin/[guildId]/archive'>) {
  const { guildId } = await params;
  if (!(await authenticateAdminPage(guildId))) {
    return <SessionExpired />;
  }
  const query = await searchParams;
  const channel = single(query.channel);
  const before = single(query.before);
  const after = single(query.after);

  const result = await getClipPage({ guildId, sourceChannelId: channel, before, after });
  if (result.kind === 'INVALID') {
    // A malformed or hand-edited URL: recover to the first page, never an
    // unbounded query -- and before spending any Discord lookups on it.
    redirect(archiveHref(guildId, {}));
  }
  const lookup = createDiscordGuildLookup({ botToken: parseEnv(process.env).DISCORD_BOT_TOKEN, fetchImpl: fetch });
  const [guildName, channelNames] = await Promise.all([
    lookup.getGuildName(guildId),
    lookup.getGuildChannelNames(guildId),
  ]);
  const { page } = result;
  return (
    <ArchiveScreen
      key={`${channel ?? ''}|${before ?? ''}|${after ?? ''}`}
      guildId={guildId}
      guildLabel={guildName ?? guildId}
      items={page.items}
      total={page.total}
      range={page.range}
      newerHref={page.newerCursor ? archiveHref(guildId, { channel, after: page.newerCursor }) : null}
      olderHref={page.olderCursor ? archiveHref(guildId, { channel, before: page.olderCursor }) : null}
      // A deleted source channel stays filterable, shown by its id.
      channelOptions={page.channelIds.map((id) => ({ id, label: channelNames[id] ?? id }))}
      selectedChannel={channel ?? null}
    />
  );
}
