import { describe, expect, test } from 'vitest';
import {
  computeChannelPermissions,
  hasManageGuild,
  missingArchivePermissions,
  PERMISSION,
  type ChannelPermissionInput,
} from '@/lib/discord/permissions';

describe('hasManageGuild', () => {
  test('reads MANAGE_GUILD out of a decimal permission bitfield', () => {
    expect(hasManageGuild((1n << 5n).toString())).toBe(true);
    expect(hasManageGuild(((1n << 5n) - 1n).toString())).toBe(false);
  });

  test('keeps its precision above 2^53', () => {
    // A Number-based implementation cannot represent these values, so both
    // of these answers would be arbitrary if the bitfield were not a BigInt.
    expect(hasManageGuild(((1n << 60n) + (1n << 5n)).toString())).toBe(true);
    expect(hasManageGuild((1n << 60n).toString())).toBe(false);
  });

  test('an administrator holds MANAGE_GUILD in the computed set', () => {
    // Discord computes `member.permissions` per interaction, so ADMINISTRATOR
    // and guild ownership already arrive with every bit set; MANAGE_GUILD
    // alone is therefore the whole check (product spec §3).
    expect(hasManageGuild(((1n << 64n) - 1n).toString())).toBe(true);
  });

  test('an absent or unparseable permission field grants nothing', () => {
    expect(hasManageGuild(undefined)).toBe(false);
    expect(hasManageGuild('')).toBe(false);
    expect(hasManageGuild('not-a-bitfield')).toBe(false);
  });
});

const GUILD = '100';
const BOT = '200';
const ROLE_A = '300';
const ROLE_B = '301';
const { ADMINISTRATOR, VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY } = PERMISSION;
const ARCHIVE = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY;

function input(over: Partial<ChannelPermissionInput>): ChannelPermissionInput {
  return {
    guildId: GUILD,
    memberId: BOT,
    memberRoleIds: [ROLE_A, ROLE_B],
    rolePermissions: new Map([
      [GUILD, 0n],
      [ROLE_A, 0n],
      [ROLE_B, 0n],
    ]),
    overwrites: [],
    ...over,
  };
}

const EVERYONE_HAS_ARCHIVE = new Map([
  [GUILD, ARCHIVE],
  [ROLE_A, 0n],
  [ROLE_B, 0n],
]);

describe('computeChannelPermissions', () => {
  test.each<[string, ChannelPermissionInput, bigint | 'all']>([
    [
      'guild-level role grants apply with no overwrites',
      input({
        rolePermissions: new Map([
          [GUILD, VIEW_CHANNEL],
          [ROLE_A, SEND_MESSAGES | READ_MESSAGE_HISTORY],
          [ROLE_B, 0n],
        ]),
      }),
      ARCHIVE,
    ],
    [
      '@everyone overwrite is keyed by the guild id',
      input({
        rolePermissions: EVERYONE_HAS_ARCHIVE,
        overwrites: [{ id: GUILD, type: 0, allow: 0n, deny: VIEW_CHANNEL }],
      }),
      0n,
    ],
    [
      'a role allow beats another role deny',
      input({
        rolePermissions: EVERYONE_HAS_ARCHIVE,
        // Allow listed first: applying role overwrites one by one in array
        // order would let the later deny win, so this order catches it.
        overwrites: [
          { id: ROLE_B, type: 0, allow: SEND_MESSAGES, deny: 0n },
          { id: ROLE_A, type: 0, allow: 0n, deny: SEND_MESSAGES },
        ],
      }),
      ARCHIVE,
    ],
    [
      'a role deny with no counter-allow removes the permission',
      input({
        rolePermissions: EVERYONE_HAS_ARCHIVE,
        overwrites: [{ id: ROLE_A, type: 0, allow: 0n, deny: READ_MESSAGE_HISTORY }],
      }),
      VIEW_CHANNEL | SEND_MESSAGES,
    ],
    [
      'a role allow restores VIEW_CHANNEL denied to @everyone (the usual private channel)',
      input({
        rolePermissions: EVERYONE_HAS_ARCHIVE,
        overwrites: [
          { id: ROLE_A, type: 0, allow: VIEW_CHANNEL, deny: 0n },
          { id: GUILD, type: 0, allow: 0n, deny: VIEW_CHANNEL },
        ],
      }),
      ARCHIVE,
    ],
    [
      'a member overwrite beats role overwrites',
      input({
        rolePermissions: EVERYONE_HAS_ARCHIVE,
        // Member overwrite listed first, so an implementation that ignores
        // `type` and applies in array order lets the role allow win.
        overwrites: [
          { id: BOT, type: 1, allow: 0n, deny: READ_MESSAGE_HISTORY },
          { id: ROLE_A, type: 0, allow: READ_MESSAGE_HISTORY, deny: 0n },
        ],
      }),
      VIEW_CHANNEL | SEND_MESSAGES,
    ],
    [
      'a denied VIEW_CHANNEL leaves nothing',
      input({
        rolePermissions: EVERYONE_HAS_ARCHIVE,
        overwrites: [{ id: BOT, type: 1, allow: 0n, deny: VIEW_CHANNEL }],
      }),
      0n,
    ],
    [
      'ADMINISTRATOR short-circuits every overwrite',
      input({
        rolePermissions: new Map([
          [GUILD, 0n],
          [ROLE_A, ADMINISTRATOR],
          [ROLE_B, 0n],
        ]),
        overwrites: [{ id: BOT, type: 1, allow: 0n, deny: VIEW_CHANNEL }],
      }),
      'all',
    ],
    [
      'an overwrite for a role the member lacks is ignored',
      input({
        memberRoleIds: [ROLE_A],
        rolePermissions: new Map([
          [GUILD, ARCHIVE],
          [ROLE_A, 0n],
        ]),
        overwrites: [{ id: ROLE_B, type: 0, allow: 0n, deny: VIEW_CHANNEL }],
      }),
      ARCHIVE,
    ],
  ])('%s', (_name, permissionInput, expected) => {
    const result = computeChannelPermissions(permissionInput);
    if (expected === 'all') {
      expect(missingArchivePermissions(result)).toEqual([]);
      expect(result & ADMINISTRATOR).toBe(ADMINISTRATOR);
    } else {
      expect(result).toBe(expected);
    }
  });
});

describe('missingArchivePermissions', () => {
  test('names each missing archive permission in a fixed order', () => {
    expect(missingArchivePermissions(VIEW_CHANNEL)).toEqual(['SEND_MESSAGES', 'READ_MESSAGE_HISTORY']);
    expect(missingArchivePermissions(ARCHIVE)).toEqual([]);
  });
});
