import { SessionExpired } from '@/components/admin/SessionExpired';
import { authenticateAdminPage } from '@/lib/admin/auth';
import { AdminSetupEdit } from './AdminSetupEdit';

/** The settings edit (decision D1). Dynamic (reads cookies), so Next sends private, no-store. */
export default async function AdminSetupPage({ params }: PageProps<'/admin/[guildId]/setup'>) {
  const { guildId } = await params;
  return (await authenticateAdminPage(guildId)) ? <AdminSetupEdit guildId={guildId} /> : <SessionExpired />;
}
