import { describe, expect, test } from 'vitest';
import { canClip } from '@/lib/clip/authorization';

describe('canClip', () => {
  test('an admin is allowed regardless of roles', () => {
    expect(
      canClip({ hasManageGuild: true, memberRoleIds: [], allowedRoleIds: ['role-1'] })
    ).toBe(true);
    expect(
      canClip({
        hasManageGuild: true,
        memberRoleIds: ['role-unrelated'],
        allowedRoleIds: ['role-1'],
      })
    ).toBe(true);
  });

  test('a member holding one of the configured roles is allowed', () => {
    expect(
      canClip({
        hasManageGuild: false,
        memberRoleIds: ['role-2', 'role-1'],
        allowedRoleIds: ['role-1', 'role-3'],
      })
    ).toBe(true);
  });

  test('a member holding roles, none of them configured, is denied', () => {
    expect(
      canClip({
        hasManageGuild: false,
        memberRoleIds: ['role-2', 'role-4'],
        allowedRoleIds: ['role-1', 'role-3'],
      })
    ).toBe(false);
  });

  test('an empty allowedRoleIds list permits an admin and denies every non-admin, including one with roles', () => {
    expect(canClip({ hasManageGuild: true, memberRoleIds: [], allowedRoleIds: [] })).toBe(true);
    expect(
      canClip({ hasManageGuild: false, memberRoleIds: ['role-1'], allowedRoleIds: [] })
    ).toBe(false);
  });

  test('a member holding no roles at all is denied', () => {
    expect(
      canClip({ hasManageGuild: false, memberRoleIds: [], allowedRoleIds: ['role-1'] })
    ).toBe(false);
  });
});
