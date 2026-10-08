// Discord permission flags, as documented at
// https://discord.com/developers/docs/topics/permissions#permissions-bitwise-permission-flags
// Only the flags this app actually tests belong here.
const MANAGE_GUILD = 1n << 5n;

/**
 * Answers whether a Discord-computed permission bitfield carries
 * `MANAGE_GUILD`, which is the guild administrator authority `/setup`
 * requires (product spec §3).
 *
 * `permissions` arrives on the interaction payload as a *decimal string*
 * because the flags run past 2^53: parsing it as a Number would silently
 * round, so it is parsed as a BigInt or not at all.
 *
 * MANAGE_GUILD alone is the whole check. Discord computes this field per
 * interaction with the guild's overwrites already applied, so an
 * ADMINISTRATOR holder and the guild owner arrive with every bit set and
 * need no separate case.
 *
 * A missing or unparseable field grants nothing: an interaction with no
 * member (a DM) has no permission set to read, and failing closed is the
 * only safe reading of an absent authorization claim.
 */
export function hasManageGuild(permissions: string | undefined): boolean {
  if (!permissions) {
    return false;
  }
  let bitfield: bigint;
  try {
    bitfield = BigInt(permissions);
  } catch {
    return false;
  }
  return (bitfield & MANAGE_GUILD) === MANAGE_GUILD;
}

/** The permission flags the archive-channel check reads. Same source as above. */
export const PERMISSION = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  READ_MESSAGE_HISTORY: 1n << 16n,
} as const;

const ALL_PERMISSIONS = (1n << 64n) - 1n;

/** A channel permission overwrite; `type` 0 targets a role, 1 a member. */
export type PermissionOverwrite = { id: string; type: 0 | 1; allow: bigint; deny: bigint };

export type ChannelPermissionInput = {
  /** Also the id of the guild's `@everyone` role. */
  guildId: string;
  memberId: string;
  /** The member's roles, not including `@everyone`. */
  memberRoleIds: readonly string[];
  /** Guild-level permissions per role id, including `@everyone`. */
  rolePermissions: ReadonlyMap<string, bigint>;
  overwrites: readonly PermissionOverwrite[];
};

/**
 * A member's effective permissions in one channel, following Discord's
 * documented order (developers.discord.com/docs/topics/permissions#permission-overwrites):
 * guild-level role permissions, ADMINISTRATOR short-circuit, the `@everyone`
 * overwrite, all role overwrites combined (every deny, then every allow),
 * then the member overwrite. Without VIEW_CHANNEL nothing else applies.
 * Guild ownership is not modelled: the bot is never the owner.
 */
export function computeChannelPermissions(input: ChannelPermissionInput): bigint {
  let permissions = input.rolePermissions.get(input.guildId) ?? 0n;
  for (const roleId of input.memberRoleIds) {
    permissions |= input.rolePermissions.get(roleId) ?? 0n;
  }
  if ((permissions & PERMISSION.ADMINISTRATOR) === PERMISSION.ADMINISTRATOR) {
    return ALL_PERMISSIONS;
  }

  const everyone = input.overwrites.find((o) => o.type === 0 && o.id === input.guildId);
  if (everyone) {
    permissions = (permissions & ~everyone.deny) | everyone.allow;
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of input.overwrites) {
    if (overwrite.type === 0 && input.memberRoleIds.includes(overwrite.id)) {
      roleAllow |= overwrite.allow;
      roleDeny |= overwrite.deny;
    }
  }
  permissions = (permissions & ~roleDeny) | roleAllow;

  const member = input.overwrites.find((o) => o.type === 1 && o.id === input.memberId);
  if (member) {
    permissions = (permissions & ~member.deny) | member.allow;
  }

  if ((permissions & PERMISSION.VIEW_CHANNEL) !== PERMISSION.VIEW_CHANNEL) {
    return 0n;
  }
  return permissions;
}

/** What the archive channel's provenance posts, forwards and content reads need. */
export const ARCHIVE_CHANNEL_PERMISSIONS = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'] as const;
export type ArchiveChannelPermission = (typeof ARCHIVE_CHANNEL_PERMISSIONS)[number];

/** The archive-channel permissions `permissions` lacks, in a fixed order. */
export function missingArchivePermissions(permissions: bigint): ArchiveChannelPermission[] {
  return ARCHIVE_CHANNEL_PERMISSIONS.filter(
    (name) => (permissions & PERMISSION[name]) !== PERMISSION[name],
  );
}
