import { z } from 'zod';
import { issueSetupToken } from '@/lib/admin-session/service';
import { createDiscordArchiveGateway } from '@/lib/discord/archive-message';
import {
  CLIP_COMMAND_NAME,
  REMOVE_FROM_CLIP_ARCHIVE_COMMAND_NAME,
  SETUP_COMMAND_NAME,
  UNCLIP_COMMAND_NAME,
} from '@/lib/discord/commands';
import { DISCORD_COPY } from '@/lib/discord/copy';
import {
  clipResultCopy,
  deferredEphemeralReply,
  ephemeralReply,
  patchFollowupMessage,
  removeButtonResultCopy,
  removeResultCopy,
  unclipResultCopy,
} from '@/lib/discord/interaction-responses';
import { createArchiveMarker } from '@/lib/discord/marker';
import { handleRemoveButtonInteraction, notifyAuthorOfFirstArchival } from '@/lib/discord/notifications';
import { hasManageGuild } from '@/lib/discord/permissions';
import { createDiscordRestClient, DiscordApiError } from '@/lib/discord/rest-client';
import { verifyInteractionRequest } from '@/lib/discord/verify-interaction';
import { createClipService } from '@/lib/clip/service';
import type { Env } from '@/lib/env';
import { parseEnv } from '@/lib/env';
import { logClipEvent } from '@/lib/logging/safe-log';

// Discord's PING (type 1) handshake, answered with PONG (type 1), is what
// lets Discord accept this URL as the app's interaction endpoint.
const PING_INTERACTION_TYPE = 1;
const APPLICATION_COMMAND_INTERACTION_TYPE = 2;
const MESSAGE_COMPONENT_INTERACTION_TYPE = 3;

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

/**
 * The fields a `Clip` / `Unclip` / `Remove from Clip Archive` invocation
 * needs. All three are MESSAGE (context menu) commands, guild-only, so
 * Discord always sends `guild_id`, `member`, and the invoked-on message
 * under `data.resolved.messages`. A payload that does not match this shape
 * cannot come from a real Discord invocation of one of these commands; the
 * schema exists to fail closed on that rather than to reach into `undefined`.
 *
 * `channel.name` is included when Discord sends it (documented for the
 * interaction's own channel) and is used only to word the first-archival DM;
 * its absence never blocks the command itself, only that DM's wording.
 *
 * The resolved message's own `channel_id` is Discord's Message object field
 * and is expected on every message context command payload, but it is kept
 * optional here with two fallbacks -- the interaction's own `channel.id` and
 * its legacy top-level `channel_id` -- either of which names the same
 * channel by construction: a message context menu is invoked from within
 * the channel its target message lives in. One source failing to carry the
 * id (a documentation-level assumption this file cannot fully verify without
 * a live payload) should not turn every invocation into `transientFailure`.
 */
const MessageContextInvocationSchema = z.object({
  guild_id: z.string().min(1),
  token: z.string().min(1),
  channel_id: z.string().min(1).optional(),
  channel: z.object({ id: z.string().min(1), name: z.string().min(1) }).partial().optional(),
  member: z.object({
    permissions: z.string().min(1),
    roles: z.array(z.string()),
    user: z.object({ id: z.string().min(1) }),
  }),
  data: z.object({
    target_id: z.string().min(1),
    resolved: z.object({
      messages: z.record(
        z.string(),
        z.object({
          id: z.string().min(1),
          channel_id: z.string().min(1).optional(),
          author: z.object({ id: z.string().min(1) }),
        }),
      ),
    }),
  }),
});

/**
 * The fields a click on the DM's `아카이브에서 제거` button needs. This
 * interaction is delivered to a DM, which Discord never attaches a `guild_id`
 * or `member` to -- the interacting member is only available as `user`, and
 * the guild/message the button acts on travel in `custom_id`, encoded and
 * re-verified server-side by `parseRemoveFromArchiveCustomId` rather than
 * trusted from this payload.
 */
const RemoveButtonInvocationSchema = z.object({
  token: z.string().min(1),
  user: z.object({ id: z.string().min(1) }),
  data: z.object({ custom_id: z.string().min(1) }),
});

/**
 * The fields the three context commands share, lifted out of the raw
 * interaction once so each command's background handler works with named
 * values instead of re-deriving them from the payload.
 */
type ContextCommandContext = {
  guildId: string;
  interactionToken: string;
  sourceChannelId: string;
  sourceMessageId: string;
  sourceAuthorUserId: string;
  invokingUserId: string;
  invokingUserRoleIds: readonly string[];
  invokingUserHasManageGuild: boolean;
  channelName: string | null;
};

function parseContextCommand(interaction: unknown): ContextCommandContext | null {
  const parsed = MessageContextInvocationSchema.safeParse(interaction);
  if (!parsed.success) {
    return null;
  }
  const { data, member } = parsed.data;
  const message = data.resolved.messages[data.target_id];
  if (message === undefined) {
    return null;
  }
  const sourceChannelId = message.channel_id ?? parsed.data.channel?.id ?? parsed.data.channel_id;
  if (sourceChannelId === undefined) {
    return null;
  }
  return {
    guildId: parsed.data.guild_id,
    interactionToken: parsed.data.token,
    sourceChannelId,
    sourceMessageId: message.id,
    sourceAuthorUserId: message.author.id,
    invokingUserId: member.user.id,
    invokingUserRoleIds: member.roles,
    invokingUserHasManageGuild: hasManageGuild(member.permissions),
    channelName: parsed.data.channel?.name ?? null,
  };
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

/**
 * Sends the deferred interaction's real answer, logging rather than
 * throwing on failure: by the time this runs the only response surface
 * Discord offers (the follow-up webhook) is the one being used, so there is
 * nothing left to fall back to.
 */
async function sendFollowupSafely(env: Env, interactionToken: string, content: string): Promise<void> {
  try {
    await patchFollowupMessage(content, {
      botToken: env.DISCORD_BOT_TOKEN,
      fetchImpl: fetch,
      applicationId: env.DISCORD_APPLICATION_ID,
      interactionToken,
    });
  } catch (error) {
    logClipEvent({
      event: 'discord.followup_failed',
      errorCode: discordErrorCode(error),
    });
  }
}

/**
 * The error code for a log line, never the message: `DiscordApiError`'s
 * message interpolates the request path, and the follow-up path carries the
 * interaction token -- a live 15-minute credential that must not end up in
 * logs (spec §12). Mirrors `lib/discord/marker.ts`'s own `errorCode` logging.
 */
function discordErrorCode(error: unknown): string {
  return error instanceof DiscordApiError ? String(error.code ?? error.status) : 'unknown';
}

/**
 * The guild's display name for the first-archival DM, best-effort.
 *
 * Discord's interaction payload does not carry the guild's name (only `id`,
 * `locale`, `features`), unlike the channel it was sent from. A lookup
 * failure falls back to the guild id rather than blocking the DM: the DM
 * itself is already best-effort (spec §11.1), and this is one more way it
 * can degrade without becoming a failure.
 */
async function lookupGuildName(env: Env, guildId: string): Promise<string> {
  const client = createDiscordRestClient({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });
  try {
    const body = await client.request('GET', `/guilds/${guildId}`);
    if (typeof body === 'object' && body !== null && 'name' in body) {
      const name = (body as { name: unknown }).name;
      if (typeof name === 'string' && name.length > 0) {
        return name;
      }
    }
  } catch {
    // Best-effort: fall through to the id.
  }
  return guildId;
}

/**
 * Runs `Clip` after its deferred reply has already gone out.
 *
 * The follow-up carrying `result`'s outcome is sent before the marker and
 * the DM are attempted, and neither of those can throw past this point --
 * `ArchiveMarker.add` and `notifyAuthorOfFirstArchival` are both contracted
 * never to throw. What the member was already told about their own clip can
 * therefore never change because a side effect failed.
 */
async function runClipCommand(ctx: ContextCommandContext, env: Env): Promise<void> {
  const gateway = createDiscordArchiveGateway({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });
  const service = createClipService(gateway);

  const result = await service.clip({
    guildId: ctx.guildId,
    sourceChannelId: ctx.sourceChannelId,
    sourceMessageId: ctx.sourceMessageId,
    sourceAuthorUserId: ctx.sourceAuthorUserId,
    clipperUserId: ctx.invokingUserId,
    clipperRoleIds: ctx.invokingUserRoleIds,
    clipperHasManageGuild: ctx.invokingUserHasManageGuild,
  });

  await sendFollowupSafely(env, ctx.interactionToken, clipResultCopy(result));

  if (result.kind !== 'CREATED') {
    return;
  }

  const marker = createArchiveMarker({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });
  await marker.add(ctx.sourceChannelId, ctx.sourceMessageId);

  const guildName = await lookupGuildName(env, ctx.guildId);
  await notifyAuthorOfFirstArchival(
    {
      guildId: ctx.guildId,
      sourceMessageId: ctx.sourceMessageId,
      guildName,
      channelName: ctx.channelName ?? ctx.sourceChannelId,
    },
    { botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch },
  );
}

/**
 * Runs `Unclip` after its deferred reply has already gone out.
 *
 * `remaining === 0` is the signal that this was the last preservation
 * signal on the Clip and `ClipService` has already torn its archive down
 * (or attempted to -- the marker removal below is non-fatal either way);
 * a positive `remaining` means the archive is still active and the marker
 * must stay.
 */
async function runUnclipCommand(ctx: ContextCommandContext, env: Env): Promise<void> {
  const gateway = createDiscordArchiveGateway({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });
  const service = createClipService(gateway);

  const result = await service.unclip({
    guildId: ctx.guildId,
    sourceMessageId: ctx.sourceMessageId,
    clipperUserId: ctx.invokingUserId,
  });

  await sendFollowupSafely(env, ctx.interactionToken, unclipResultCopy(result));

  if (result.kind === 'UNCLIPPED' && result.remaining === 0) {
    const marker = createArchiveMarker({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });
    await marker.remove(ctx.sourceChannelId, ctx.sourceMessageId);
  }
}

/**
 * Runs `Remove from Clip Archive` after its deferred reply has already gone
 * out. Authorization (source author or a guild manager) is `ClipService`'s
 * own `removeByAuthorOrAdmin` check, re-derived from the locked Clip row --
 * never from anything this payload claims about who the source author is.
 */
async function runRemoveCommand(ctx: ContextCommandContext, env: Env): Promise<void> {
  const gateway = createDiscordArchiveGateway({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });
  const service = createClipService(gateway);

  const result = await service.removeByAuthorOrAdmin({
    guildId: ctx.guildId,
    sourceMessageId: ctx.sourceMessageId,
    invokerUserId: ctx.invokingUserId,
    invokerHasManageGuild: ctx.invokingUserHasManageGuild,
  });

  await sendFollowupSafely(env, ctx.interactionToken, removeResultCopy(result));

  if (result.kind === 'REMOVED') {
    const marker = createArchiveMarker({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });
    await marker.remove(ctx.sourceChannelId, ctx.sourceMessageId);
  }
}

/**
 * Runs the DM's `아카이브에서 제거` button after its deferred reply has
 * already gone out. Mirrors `runRemoveCommand`, but there is no marker
 * reaction to retract here: `custom_id` carries only the guild and source
 * message id (never the source channel), so this path has no source channel
 * id to remove the marker with. That is an existing limitation of the DM
 * button's encoding, not something this handler can fix.
 */
async function runRemoveButtonInteraction(
  interactionToken: string,
  customId: string,
  interactingUserId: string,
  env: Env,
): Promise<void> {
  const gateway = createDiscordArchiveGateway({ botToken: env.DISCORD_BOT_TOKEN, fetchImpl: fetch });

  const result = await handleRemoveButtonInteraction(
    { customId, interactingUserId },
    { gateway },
  );

  await sendFollowupSafely(env, interactionToken, removeButtonResultCopy(result));
}

/**
 * Answers a click on the DM's `아카이브에서 제거` button (interaction type 3,
 * MESSAGE_COMPONENT).
 *
 * Deferred the same way the context commands are: `handleRemoveButtonInteraction`
 * does a locked read and a Discord delete, which does not reliably fit
 * Discord's 3-second budget for the initial response.
 *
 * The interacting user's id is read from `interaction.user.id`, never
 * `interaction.member.user.id` -- a DM interaction carries no `member` at
 * all, so reaching for it here would either throw or (if a caller made this
 * field optional in the schema instead) authorize a click no one made.
 */
function handleMessageComponent(interaction: unknown, env: Env): Response {
  const invocation = RemoveButtonInvocationSchema.safeParse(interaction);
  if (!invocation.success) {
    // Unreachable from a real Discord invocation of this button; kept as a
    // fail-closed answer rather than a thrown error on the (untrusted)
    // chance the payload does not match what Discord signed.
    return ephemeralReply(DISCORD_COPY.transientFailure);
  }
  const { token, user, data } = invocation.data;

  const response = deferredEphemeralReply();
  runRemoveButtonInteraction(token, data.custom_id, user.id, env).catch((error: unknown) => {
    logClipEvent({
      event: 'discord.remove_button_failed',
      userId: user.id,
      errorCode: discordErrorCode(error),
    });
    // Best-effort: the deferred placeholder should not stay unanswered.
    void sendFollowupSafely(env, token, DISCORD_COPY.transientFailure);
  });
  return response;
}

const CONTEXT_COMMAND_RUNNERS: Record<
  string,
  (ctx: ContextCommandContext, env: Env) => Promise<void>
> = {
  [CLIP_COMMAND_NAME]: runClipCommand,
  [UNCLIP_COMMAND_NAME]: runUnclipCommand,
  [REMOVE_FROM_CLIP_ARCHIVE_COMMAND_NAME]: runRemoveCommand,
};

/**
 * Answers `Clip`, `Unclip`, and `Remove from Clip Archive`.
 *
 * All three defer immediately (interaction callback type 5) and finish the
 * work afterward: archiving a message is a source-message read, two posts,
 * and sometimes a DM, which does not reliably fit Discord's 3-second budget
 * for the initial response. The background run is deliberately not awaited
 * here -- this process is a persistent server (`next.config.ts`'s `output:
 * standalone`, run under Node in `k8s/`, never a request-scoped serverless
 * function), so it keeps running after the deferred response is returned.
 * A runner that throws unexpectedly is still caught here so the member gets
 * `transientFailure` instead of the follow-up webhook silently going unused.
 */
function handleContextCommand(
  name: string,
  interaction: unknown,
  env: Env,
): Response | null {
  const runner = CONTEXT_COMMAND_RUNNERS[name];
  if (runner === undefined) {
    return null;
  }

  const ctx = parseContextCommand(interaction);
  if (ctx === null) {
    // Unreachable from a real Discord invocation of these guild-only MESSAGE
    // commands; kept as a fail-closed answer rather than a thrown error on
    // the (untrusted) chance the payload does not match what Discord signed.
    return ephemeralReply(DISCORD_COPY.transientFailure);
  }

  const response = deferredEphemeralReply();
  runner(ctx, env).catch((error: unknown) => {
    logClipEvent({
      event: 'discord.context_command_failed',
      guildId: ctx.guildId,
      sourceMessageId: ctx.sourceMessageId,
      userId: ctx.invokingUserId,
      errorCode: discordErrorCode(error),
    });
    // Best-effort: the deferred placeholder should not stay unanswered.
    // If `sendFollowupSafely` inside the runner already answered it with the
    // real outcome, this overwrites it -- but reaching here means the runner
    // threw before producing that outcome, so there was no real answer to
    // preserve.
    void sendFollowupSafely(env, ctx.interactionToken, DISCORD_COPY.transientFailure);
  });
  return response;
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

  if (interaction.type === APPLICATION_COMMAND_INTERACTION_TYPE) {
    const name = interaction.data?.name;
    if (name === SETUP_COMMAND_NAME) {
      return handleSetupCommand(interaction, env.PUBLIC_BASE_URL);
    }
    if (typeof name === 'string') {
      const response = handleContextCommand(name, interaction, env);
      if (response !== null) {
        return response;
      }
    }
  }

  if (interaction.type === MESSAGE_COMPONENT_INTERACTION_TYPE) {
    return handleMessageComponent(interaction, env);
  }

  return new Response(null, { status: 501 });
}
