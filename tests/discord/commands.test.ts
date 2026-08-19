import { describe, expect, test } from 'vitest';
import {
  CLIP_COMMAND,
  CLIP_COMMAND_NAME,
  CommandPayloadSchema,
  DISCORD_COMMANDS,
  REMOVE_FROM_CLIP_ARCHIVE_COMMAND,
  REMOVE_FROM_CLIP_ARCHIVE_COMMAND_NAME,
  SETUP_COMMAND,
  SETUP_COMMAND_NAME,
  UNCLIP_COMMAND,
  UNCLIP_COMMAND_NAME,
} from '@/lib/discord/commands';

// These names are stable identifiers the interaction router matches on
// (product spec §4); pinning them here means a later task that retypes the
// literal breaks this test rather than silently diverging.
describe('command name constants', () => {
  test('match the names fixed by the product spec', () => {
    expect(SETUP_COMMAND_NAME).toBe('setup');
    expect(CLIP_COMMAND_NAME).toBe('Clip');
    expect(UNCLIP_COMMAND_NAME).toBe('Unclip');
    expect(REMOVE_FROM_CLIP_ARCHIVE_COMMAND_NAME).toBe('Remove from Clip Archive');
  });
});

describe('command payloads', () => {
  test.each([
    ['setup', SETUP_COMMAND],
    ['Clip', CLIP_COMMAND],
    ['Unclip', UNCLIP_COMMAND],
    ['Remove from Clip Archive', REMOVE_FROM_CLIP_ARCHIVE_COMMAND],
  ])('%s validates against the Discord command schema', (_label, payload) => {
    expect(CommandPayloadSchema.safeParse(payload).success).toBe(true);
  });

  test('DISCORD_COMMANDS is exactly the four commands this app registers', () => {
    expect(DISCORD_COMMANDS).toEqual([
      SETUP_COMMAND,
      CLIP_COMMAND,
      UNCLIP_COMMAND,
      REMOVE_FROM_CLIP_ARCHIVE_COMMAND,
    ]);
  });

  test('rejects a CHAT_INPUT command with no description', () => {
    expect(CommandPayloadSchema.safeParse({ ...SETUP_COMMAND, description: '' }).success).toBe(
      false,
    );
  });

  test('rejects a MESSAGE context menu command with a non-empty description', () => {
    expect(
      CommandPayloadSchema.safeParse({ ...CLIP_COMMAND, description: 'not allowed' }).success,
    ).toBe(false);
  });

  test('rejects a context menu command name with leading whitespace', () => {
    expect(CommandPayloadSchema.safeParse({ ...CLIP_COMMAND, name: ' Clip' }).success).toBe(
      false,
    );
  });

  test('rejects a CHAT_INPUT command name containing uppercase letters', () => {
    expect(CommandPayloadSchema.safeParse({ ...SETUP_COMMAND, name: 'Setup' }).success).toBe(
      false,
    );
  });

  test('rejects a CHAT_INPUT command name containing spaces', () => {
    expect(CommandPayloadSchema.safeParse({ ...SETUP_COMMAND, name: 'set up' }).success).toBe(
      false,
    );
  });

  test('rejects an unsupported command type', () => {
    expect(CommandPayloadSchema.safeParse({ ...CLIP_COMMAND, type: 2 }).success).toBe(false);
  });
});
