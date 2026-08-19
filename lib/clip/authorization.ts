export type CanClipInput = {
  hasManageGuild: boolean;
  memberRoleIds: readonly string[];
  allowedRoleIds: readonly string[];
};

/**
 * `canClip = hasManageGuild OR (memberRoleIds ∩ allowedRoleIds ≠ ∅)` (product spec).
 *
 * Takes a single input object rather than positional role-id lists: two adjacent
 * `readonly string[]` parameters are a silent swap hazard, since a transposed call
 * still typechecks and an admin test still passes while every role check inverts.
 *
 * An empty `allowedRoleIds` intersects with nothing, so "no roles configured" denies
 * every non-admin rather than defaulting to "everyone may clip".
 */
export function canClip(input: CanClipInput): boolean {
  if (input.hasManageGuild) {
    return true;
  }
  return input.memberRoleIds.some((roleId) => input.allowedRoleIds.includes(roleId));
}
