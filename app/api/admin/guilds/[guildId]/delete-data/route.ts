import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticateAdminRequest, PRIVATE_NO_STORE, rejectUnsafeMutation } from '@/lib/admin/auth';
import { deleteGuildData } from '@/lib/admin/guild-data';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/admin-session/tokens';
import { logClipEvent } from '@/lib/logging/safe-log';

const DeleteRequestSchema = z.object({ acknowledged: z.literal(true) });

/**
 * Screen E's step 2. The acknowledgement is checked here as well as in the
 * UI -- a destructive endpoint does not trust the button that called it.
 * Makes no Discord calls; see `deleteGuildData`.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/admin/guilds/[guildId]/delete-data'>,
) {
  const unsafe = rejectUnsafeMutation(request);
  if (unsafe) {
    return unsafe;
  }
  const { guildId } = await context.params;
  const auth = await authenticateAdminRequest(request, guildId);
  if (!auth) {
    return new Response(null, { status: 401, headers: PRIVATE_NO_STORE });
  }
  const parsed = DeleteRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new Response(null, { status: 400, headers: PRIVATE_NO_STORE });
  }

  let outcome: Awaited<ReturnType<typeof deleteGuildData>>;
  try {
    outcome = await deleteGuildData(guildId, auth.sessionTokenHash);
  } catch {
    logClipEvent({ event: 'admin.delete-data-failed', guildId, errorCode: 'UNKNOWN' });
    return new Response(null, { status: 500, headers: PRIVATE_NO_STORE });
  }
  if (outcome.kind === 'SESSION_REVOKED') {
    return new Response(null, { status: 401, headers: PRIVATE_NO_STORE });
  }

  const response = NextResponse.json({ deleted: true }, { headers: PRIVATE_NO_STORE });
  // Same name and path the exchange route set it with, or the browser keeps it.
  response.cookies.set(ADMIN_SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    secure: process.env.NODE_ENV === 'production',
  });
  return response;
}
