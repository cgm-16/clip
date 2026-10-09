import type { SetupChannel, SetupRole } from '@/lib/discord/guild-lookup';
import type { InitialSetup, SaveOutcome } from './ScreenB';

/*
 * Client helpers shared by the token setup flow (`SetupFlow`) and the
 * session-based settings edit (`app/admin/[guildId]/setup`): parsers for
 * `/setup/data` and `/setup/save`, and the setup-data fetch.
 */

/** `/setup/save`'s success body — see `app/setup/save/route.ts`. */
export type SaveResult = {
  archiveChannelId: string;
  archiveChannelName: string;
  autoCreated: boolean;
  clipCount: number;
  allowedRoles: { id: string; name: string }[];
};

/** `/setup/data`'s body — see `app/setup/data/route.ts`. */
export type SetupData = {
  guildId: string;
  guildName: string | null;
  adminHandle: string | null;
  channels: SetupChannel[];
  roles: SetupRole[];
  config: InitialSetup | null;
  /** #58: the saved archive channel no longer exists in Discord. */
  archiveChannelMissing: boolean;
};

export type SetupDataResult =
  | { status: 'ready'; data: SetupData }
  | { status: 'unauthenticated' }
  | { status: 'failed' };

function isSetupChannel(value: unknown): value is SetupChannel {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { id, name, type } = value as Record<string, unknown>;
  return typeof id === 'string' && typeof name === 'string' && typeof type === 'number';
}

function isSetupRole(value: unknown): value is SetupRole {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { id, name, selectable } = value as Record<string, unknown>;
  return typeof id === 'string' && typeof name === 'string' && typeof selectable === 'boolean';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseConfig(value: unknown): InitialSetup | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'object') {
    return undefined;
  }
  const { archiveChannelId, allowedRoleIds } = value as Record<string, unknown>;
  if (typeof archiveChannelId !== 'string' || !isStringArray(allowedRoleIds)) {
    return undefined;
  }
  return { archiveChannelId, allowedRoleIds };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function parseSetupData(value: unknown): SetupData | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { guildId, guildName, adminHandle, channels, roles, config, archiveChannelMissing } = value as Record<
    string,
    unknown
  >;
  const parsedConfig = parseConfig(config);
  if (
    typeof guildId !== 'string' ||
    !isNullableString(guildName) ||
    !isNullableString(adminHandle) ||
    !Array.isArray(channels) ||
    !channels.every(isSetupChannel) ||
    !Array.isArray(roles) ||
    !roles.every(isSetupRole) ||
    parsedConfig === undefined
  ) {
    return null;
  }
  return {
    guildId,
    guildName,
    adminHandle,
    channels,
    roles,
    config: parsedConfig,
    archiveChannelMissing: archiveChannelMissing === true,
  };
}

function isNamedRole(value: unknown): value is { id: string; name: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { id, name } = value as Record<string, unknown>;
  return typeof id === 'string' && typeof name === 'string';
}

export function parseSaveResult(value: unknown): SaveResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { archiveChannelId, archiveChannelName, autoCreated, clipCount, allowedRoles } = value as Record<
    string,
    unknown
  >;
  if (
    !Array.isArray(allowedRoles) ||
    !allowedRoles.every(isNamedRole) ||
    typeof archiveChannelId !== 'string' ||
    archiveChannelId.length === 0 ||
    typeof archiveChannelName !== 'string' ||
    typeof autoCreated !== 'boolean' ||
    typeof clipCount !== 'number' ||
    !Number.isInteger(clipCount) ||
    clipCount < 0
  ) {
    return null;
  }
  return { archiveChannelId, archiveChannelName, autoCreated, clipCount, allowedRoles };
}

/** Maps `/setup/save`'s refusal statuses (see its route) to what Screen B shows. */
export async function saveOutcomeOf(response: Response): Promise<SaveOutcome> {
  if (response.status === 409) {
    return { kind: 'live-clips' };
  }
  if (response.status === 422) {
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (body?.reason === 'MISSING_PERMISSIONS' && isStringArray(body.missingPermissions)) {
      return { kind: 'missing-permissions', missingPermissions: body.missingPermissions };
    }
  }
  return { kind: 'failed' };
}

export async function fetchSetupData(): Promise<SetupDataResult> {
  try {
    const response = await fetch('/setup/data');
    if (response.status === 401) {
      return { status: 'unauthenticated' };
    }
    if (!response.ok) {
      return { status: 'failed' };
    }
    const data = parseSetupData(await response.json());
    return data ? { status: 'ready', data } : { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}
