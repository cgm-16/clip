import { redirect } from 'next/navigation';
import { SessionExpired } from '@/components/admin/SessionExpired';
import { authenticateAdminPage } from '@/lib/admin/auth';
import { countArchivedClips, findGuildArchiveConfig } from '@/lib/clip/repository';
import { createDiscordGuildLookup } from '@/lib/discord/guild-lookup';
import { parseEnv } from '@/lib/env';
import { SettingsScreen } from './SettingsScreen';

/** Screen E. Dynamic (reads cookies), so Next sends private, no-store. */
export default async function SettingsPage({ params, searchParams }: PageProps<'/admin/[guildId]/settings'>) {
  const { guildId } = await params;
  if (!(await authenticateAdminPage(guildId))) {
    return <SessionExpired />;
  }
  const config = await findGuildArchiveConfig(guildId);
  if (config === null) {
    // A live session for a guild with no configuration (first setup not
    // finished): the prefilled form is also the first-setup form.
    redirect(`/admin/${guildId}/setup`);
  }
  const lookup = createDiscordGuildLookup({ botToken: parseEnv(process.env).DISCORD_BOT_TOKEN, fetchImpl: fetch });
  const [guildName, channelNames, roles, clipCount] = await Promise.all([
    lookup.getGuildName(guildId),
    lookup.getGuildChannelNames(guildId),
    lookup.getGuildRoles(guildId).catch(() => []),
    countArchivedClips(guildId),
  ]);
  const roleNames = new Map(roles.map((role) => [role.id, role.name]));
  const channelListLoaded = Object.keys(channelNames).length > 0;
  const query = await searchParams;
  return (
    <SettingsScreen
      guildId={guildId}
      guildLabel={guildName ?? guildId}
      archiveChannelLabel={channelNames[config.archiveChannelId] ?? config.archiveChannelId}
      // Only claim "missing" when the channel list actually loaded.
      archiveChannelMissing={channelListLoaded && !(config.archiveChannelId in channelNames)}
      allowedRoles={config.allowedRoleIds.map((id) => ({ id, name: roleNames.get(id) ?? id }))}
      clipCount={clipCount}
      saved={query.saved === '1'}
    />
  );
}
