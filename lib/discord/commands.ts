import { z } from 'zod';

/**
 * Discord application command types this app registers.
 * https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-types
 */
export const ApplicationCommandType = {
  CHAT_INPUT: 1,
  MESSAGE: 3,
} as const;

// Stable identifiers the interaction router matches on (product spec §4).
// Exported as named constants so no later task retypes the literal.
export const SETUP_COMMAND_NAME = 'setup';
export const CLIP_COMMAND_NAME = 'Clip';
export const UNCLIP_COMMAND_NAME = 'Unclip';
export const REMOVE_FROM_CLIP_ARCHIVE_COMMAND_NAME = 'Remove from Clip Archive';

// CHAT_INPUT command names must be lowercase letters, digits, hyphens or
// underscores, 1-32 characters.
const ChatInputCommandSchema = z.object({
  name: z.string().min(1).max(32).regex(/^[-_a-z0-9]+$/),
  type: z.literal(ApplicationCommandType.CHAT_INPUT),
  description: z.string().min(1).max(100),
});

// MESSAGE (context menu) command names may contain spaces and mixed case,
// but Discord rejects leading/trailing whitespace. `description` must be
// empty for non-CHAT_INPUT commands per the application command object spec.
const MessageContextMenuCommandSchema = z.object({
  name: z.string().min(1).max(32).regex(/^\S(?:.*\S)?$/),
  type: z.literal(ApplicationCommandType.MESSAGE),
  description: z.literal(''),
});

export const CommandPayloadSchema = z.discriminatedUnion('type', [
  ChatInputCommandSchema,
  MessageContextMenuCommandSchema,
]);

export type CommandPayload = z.infer<typeof CommandPayloadSchema>;

export const SETUP_COMMAND: CommandPayload = {
  name: SETUP_COMMAND_NAME,
  type: ApplicationCommandType.CHAT_INPUT,
  description: 'Configure Clip for this server.',
};

export const CLIP_COMMAND: CommandPayload = {
  name: CLIP_COMMAND_NAME,
  type: ApplicationCommandType.MESSAGE,
  description: '',
};

export const UNCLIP_COMMAND: CommandPayload = {
  name: UNCLIP_COMMAND_NAME,
  type: ApplicationCommandType.MESSAGE,
  description: '',
};

export const REMOVE_FROM_CLIP_ARCHIVE_COMMAND: CommandPayload = {
  name: REMOVE_FROM_CLIP_ARCHIVE_COMMAND_NAME,
  type: ApplicationCommandType.MESSAGE,
  description: '',
};

// All commands this app registers, guild-scoped. Order is the order
// Discord's command list shows them in.
export const DISCORD_COMMANDS: readonly CommandPayload[] = [
  SETUP_COMMAND,
  CLIP_COMMAND,
  UNCLIP_COMMAND,
  REMOVE_FROM_CLIP_ARCHIVE_COMMAND,
];
