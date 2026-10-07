'use client';

import { useEffect, useRef, useState } from 'react';
import type { SetupChannel, SetupRole } from '@/lib/discord/guild-lookup';
import { ScreenA } from './ScreenA';
import { ScreenB, type InitialSetup, type SaveOutcome, type SetupSubmission } from './ScreenB';
import { ScreenC } from './ScreenC';
import { ScreenLoadError } from './ScreenLoadError';

/** `/setup/save`'s success body — see `app/setup/save/route.ts`. */
type SaveResult = {
  archiveChannelId: string;
  archiveChannelName: string;
  autoCreated: boolean;
  clipCount: number;
  allowedRoles: { id: string; name: string }[];
};

/** `/setup/data`'s body — see `app/setup/data/route.ts`. */
type SetupData = {
  guildId: string;
  guildName: string | null;
  adminHandle: string | null;
  channels: SetupChannel[];
  roles: SetupRole[];
  config: InitialSetup | null;
};

type FlowState =
  | { status: 'loading' }
  | { status: 'expired' }
  | { status: 'load-error'; canExchangeToken: boolean }
  | ({ status: 'ready' } & SetupData)
  | ({ status: 'complete'; setup: SetupData } & SaveResult);

type SetupDataResult =
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

function parseSetupData(value: unknown): SetupData | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { guildId, guildName, adminHandle, channels, roles, config } = value as Record<string, unknown>;
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
  return { guildId, guildName, adminHandle, channels, roles, config: parsedConfig };
}

function isNamedRole(value: unknown): value is { id: string; name: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { id, name } = value as Record<string, unknown>;
  return typeof id === 'string' && typeof name === 'string';
}

function parseSaveResult(value: unknown): SaveResult | null {
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
async function saveOutcomeOf(response: Response): Promise<SaveOutcome> {
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

async function fetchSetupData(): Promise<SetupDataResult> {
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

/**
 * `/setup/:token` — exchanges the one-time setup token for the short admin
 * session (`lib/admin-session`) at most once, then branches between Screen A
 * (dead link) and Screen B (destination form). A page reload with a still-live
 * session skips the exchange entirely, since the token behind it is already
 * spent (`lib/admin-session/repository.ts`'s `exchangeSetupTokenForSession`
 * is one-shot).
 */
export function SetupFlow({ token }: { token: string }) {
  const [state, setState] = useState<FlowState>({ status: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const currentAttempt = useRef(0);
  const tokenCapability = useRef({ token, canExchangeToken: true });
  const retryPending = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const attempt = ++currentAttempt.current;
    if (tokenCapability.current.token !== token) {
      tokenCapability.current = { token, canExchangeToken: true };
    }
    const capability = tokenCapability.current;

    function ownsAttempt() {
      return !cancelled && currentAttempt.current === attempt && tokenCapability.current === capability;
    }

    async function loadSetupData() {
      // A cookie from an earlier visit may already carry a live session —
      // try it first so a reload never re-spends the (one-time) setup token.
      const existing = await fetchSetupData();
      if (!ownsAttempt()) {
        return;
      }
      if (existing.status === 'ready') {
        retryPending.current = false;
        setState({ status: 'ready', ...existing.data });
        return;
      }

      if (existing.status === 'failed') {
        retryPending.current = false;
        setState({ status: 'load-error', canExchangeToken: capability.canExchangeToken });
        return;
      }

      if (!capability.canExchangeToken) {
        retryPending.current = false;
        setState({ status: 'expired' });
        return;
      }

      let exchangeResponse: Response;
      try {
        exchangeResponse = await fetch('/api/setup/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
      } catch {
        if (!ownsAttempt()) {
          return;
        }
        retryPending.current = false;
        setState({ status: 'load-error', canExchangeToken: capability.canExchangeToken });
        return;
      }
      if (!ownsAttempt()) {
        return;
      }
      if (!exchangeResponse.ok) {
        retryPending.current = false;
        setState({ status: 'expired' });
        return;
      }

      capability.canExchangeToken = false;
      const data = await fetchSetupData();
      if (!ownsAttempt()) {
        return;
      }
      retryPending.current = false;
      if (data.status === 'ready') {
        setState({ status: 'ready', ...data.data });
      } else if (data.status === 'failed') {
        setState({ status: 'load-error', canExchangeToken: capability.canExchangeToken });
      } else {
        setState({ status: 'expired' });
      }
    }

    loadSetupData();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, token]);

  if (state.status === 'loading') {
    return null;
  }

  if (state.status === 'expired') {
    return <ScreenA />;
  }

  if (state.status === 'load-error') {
    return (
      <ScreenLoadError
        onRetry={() => {
          if (retryPending.current) {
            return;
          }
          retryPending.current = true;
          setState({ status: 'loading' });
          setLoadAttempt((attempt) => attempt + 1);
        }}
      />
    );
  }

  if (state.status === 'complete') {
    return (
      <ScreenC
        guildId={state.setup.guildId}
        archiveChannelId={state.archiveChannelId}
        archiveChannelName={state.archiveChannelName}
        autoCreated={state.autoCreated}
        clipCount={state.clipCount}
        allowedRoles={state.allowedRoles}
        onReviewSettings={() =>
          setState({
            status: 'ready',
            ...state.setup,
            config: {
              archiveChannelId: state.archiveChannelId,
              allowedRoleIds: state.allowedRoles.map((role) => role.id),
            },
          })
        }
      />
    );
  }

  // Only 'ready' remains at this point. Captured as plain locals, not
  // repeated `state.x` reads, since TypeScript's narrowing of `state` above
  // does not extend into the nested `handleSubmit` closure below.
  const { status: _status, ...setup } = state;

  // Posts the chosen destination to `/setup/save`
  // (`docs/06_DESIGN_HANDOFF.md` "Setup form": "success → Screen C"). A save
  // that fails leaves the admin on Screen B to retry; `onSubmit`'s boolean is
  // how ScreenB knows to render its save-failed error callout
  // (`WEB_COPY_AUTHORED.saveFailed`) rather than silently doing nothing (see
  // `ScreenB.tsx`'s own doc comment on `onSubmit`).
  async function handleSubmit(submission: SetupSubmission): Promise<SaveOutcome> {
    try {
      const response = await fetch('/setup/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      });
      if (!response.ok) {
        return saveOutcomeOf(response);
      }
      const result = parseSaveResult(await response.json());
      if (!result) {
        return { kind: 'failed' };
      }
      setState({ status: 'complete', setup, ...result });
      return { kind: 'saved' };
    } catch {
      // An offline or reset connection rejects instead of answering. That is
      // still a failed save, so it has to leave here as `failed`; thrown, it
      // would escape ScreenB's submit handler and the admin would be left
      // with no error callout at all.
      return { kind: 'failed' };
    }
  }

  return (
    <ScreenB
      // A new configuration (after "설정 다시 보기") remounts the form so its
      // prefill is read again rather than kept from the first mount.
      key={setup.config?.archiveChannelId ?? 'first-setup'}
      channels={setup.channels}
      roles={setup.roles}
      initial={setup.config}
      guildName={setup.guildName ?? setup.guildId}
      adminHandle={setup.adminHandle ?? undefined}
      onSubmit={handleSubmit}
    />
  );
}
