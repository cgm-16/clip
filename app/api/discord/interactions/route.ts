import { z } from 'zod';
import { issueSetupToken } from '@/lib/admin-session/service';
import { SETUP_COMMAND_NAME } from '@/lib/discord/commands';
import { DISCORD_COPY } from '@/lib/discord/copy';
import { hasManageGuild } from '@/lib/discord/permissions';
import { parseEnv } from '@/lib/env';
import { verifyInteractionRequest } from '@/lib/discord/verify-interaction';

// Discord's PING (type 1) handshake, answered with PONG (type 1), is what
// lets Discord accept this URL as the app's interaction endpoint.
const PING_INTERACTION_TYPE = 1;
const APPLICATION_COMMAND_INTERACTION_TYPE = 2;

// Interaction callback type 4 answers the invocation with a message.
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
// MessageFlags.EPHEMERAL: only the invoking member sees the message.
const EPHEMERAL_FLAG = 64;

// The fields `/setup` needs from an invocation, all of which Discord sends
// only for a guild invocation: in a DM there is no `member` and no
// `guild_id`. Validating rather than reaching in is what makes that case a
// refusal instead of a crash.
const GuildInvocationSchema = z.object({
  guild_id: z.string().min(1),
  member: z.object({
    // A decimal bitfield string; see `hasManageGuild`.
    permissions: z.string().min(1),
    user: z.object({ id: z.string().min(1) }),
  }),
});

function ephemeralReply(content: string): Response {
  return Response.json({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL_FLAG },
  });
}

/**
 * Answers `/setup` with the one-time `Configure Clip` link (product spec
 * §5.1), or with a refusal.
 *
 * Both answers are ephemeral. The link is an admin credential, so posting it
 * into the channel would hand it to everyone present; the refusal is
 * ephemeral so a failed authorization attempt is not announced either.
 *
 * Discord abandons an interaction left unanswered for 3 seconds, so the only
 * work on this path is the permission test and the single indexed insert
 * behind `issueSetupToken`.
 */
async function handleSetupCommand(interaction: unknown, baseUrl: string): Promise<Response> {
  const invocation = GuildInvocationSchema.safeParse(interaction);
  // Authorization is settled here, against the permission set Discord
  // computed and signed. Nothing later in the flow may re-derive it from a
  // claim the browser makes: the setup token is the browser's only evidence.
  if (!invocation.success || !hasManageGuild(invocation.data.member.permissions)) {
    return ephemeralReply(DISCORD_COPY.noPermission);
  }

  const { token } = await issueSetupToken(invocation.data.guild_id, invocation.data.member.user.id);
  return ephemeralReply(`${baseUrl}/setup/${token}`);
}

export async function POST(request: Request) {
  // Read the raw body before anything parses it as JSON: `verifyKey` signs
  // over the exact bytes Discord sent, so a parse-then-restringify round
  // trip could produce a body that no longer matches the signature.
  const rawBody = await request.text();
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');

  // parseEnv is called per-request rather than at module load so a missing
  // env var fails a request, not the build (env vars are absent in CI).
  const env = parseEnv(process.env);

  const isValid = await verifyInteractionRequest(
    rawBody,
    signature,
    timestamp,
    env.DISCORD_PUBLIC_KEY,
  );
  if (!isValid) {
    // Missing signature, missing timestamp, and a bad signature all return
    // the same 401 with no detail, so an attacker learns nothing about which
    // check failed.
    return new Response(null, { status: 401 });
  }

  const interaction = JSON.parse(rawBody);
  if (interaction.type === PING_INTERACTION_TYPE) {
    return Response.json({ type: PING_INTERACTION_TYPE });
  }

  if (
    interaction.type === APPLICATION_COMMAND_INTERACTION_TYPE &&
    interaction.data?.name === SETUP_COMMAND_NAME
  ) {
    return handleSetupCommand(interaction, env.PUBLIC_BASE_URL);
  }

  return new Response(null, { status: 501 });
}
