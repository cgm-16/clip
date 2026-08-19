import { describe, expect, test } from 'vitest';
import { hasManageGuild } from '@/lib/discord/permissions';

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
