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
