'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ScreenA } from './ScreenA';
import { ScreenB, type SaveOutcome, type SetupSubmission } from './ScreenB';
import { ScreenC } from './ScreenC';
import { ScreenLoadError } from './ScreenLoadError';
import { fetchSetupData, parseSaveResult, saveOutcomeOf, type SaveResult, type SetupData } from './setup-client';

type FlowState =
  | { status: 'loading' }
  | { status: 'expired' }
  | { status: 'load-error'; canExchangeToken: boolean }
  | ({ status: 'ready' } & SetupData)
  | ({ status: 'complete'; setup: SetupData } & SaveResult);

/**
 * `/setup/:token` — exchanges the one-time setup token for the short admin
 * session (`lib/admin-session`) at most once, then branches between Screen A
 * (dead link) and Screen B (destination form). A page reload with a still-live
 * session skips the exchange entirely, since the token behind it is already
 * spent (`lib/admin-session/repository.ts`'s `exchangeSetupTokenForSession`
 * is one-shot).
 */
// Marks a token this tab has exchanged, so a reload reuses the session it
// created instead of re-spending (and being refused) the one-time token.
// sessionStorage can be unavailable; a missing marker only costs a refused
// exchange and Screen A, never another guild's session.
const EXCHANGED_PREFIX = 'clip:setup-exchanged:';

function wasExchangedHere(token: string): boolean {
  try {
    return window.sessionStorage.getItem(EXCHANGED_PREFIX + token) === '1';
  } catch {
    return false;
  }
}

function markExchangedHere(token: string): void {
  try {
    window.sessionStorage.setItem(EXCHANGED_PREFIX + token, '1');
  } catch {
    // See above: the marker is an optimisation, not a guarantee.
  }
}

export function SetupFlow({ token }: { token: string }) {
  const router = useRouter();
  const [state, setState] = useState<FlowState>({ status: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const currentAttempt = useRef(0);
  const tokenCapability = useRef({ token, canExchangeToken: true, exchangeOutcomeUnknown: false });
  const retryPending = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const attempt = ++currentAttempt.current;
    if (tokenCapability.current.token !== token) {
      tokenCapability.current = { token, canExchangeToken: true, exchangeOutcomeUnknown: false };
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
        // A live session is only trusted when it is this link's own: a reload
        // of a link this tab exchanged, a token already spent here, or a retry
        // after an exchange whose response was lost (it may have succeeded).
        // Otherwise it may belong to another guild's earlier link, so the
        // fresh token is exchanged and decides (#62).
        if (!capability.canExchangeToken || wasExchangedHere(token) || capability.exchangeOutcomeUnknown) {
          retryPending.current = false;
          showSetup(existing.data);
          return;
        }
      } else if (existing.status === 'failed') {
        retryPending.current = false;
        setState({ status: 'load-error', canExchangeToken: capability.canExchangeToken });
        return;
      } else if (!capability.canExchangeToken) {
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
        // The exchange may have reached the server before the connection
        // dropped; on retry, a live session is then trusted.
        capability.exchangeOutcomeUnknown = true;
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
      markExchangedHere(token);
      const data = await fetchSetupData();
      if (!ownsAttempt()) {
        return;
      }
      retryPending.current = false;
      if (data.status === 'ready') {
        showSetup(data.data);
      } else if (data.status === 'failed') {
        setState({ status: 'load-error', canExchangeToken: capability.canExchangeToken });
      } else {
        setState({ status: 'expired' });
      }
    }

    // A configured guild's fresh link opens Screen E (decision D1); the
    // setup form is reached from there. Only a first setup stays here.
    function showSetup(data: SetupData) {
      if (data.config !== null) {
        router.replace(`/admin/${data.guildId}/settings`);
        return;
      }
      setState({ status: 'ready', ...data });
    }

    loadSetupData();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, token, router]);

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
      channels={setup.channels}
      roles={setup.roles}
      initial={setup.config}
      archiveChannelMissing={setup.archiveChannelMissing}
      archiveHref={`/admin/${setup.guildId}/archive`}
      guildName={setup.guildName ?? setup.guildId}
      adminHandle={setup.adminHandle ?? undefined}
      onSubmit={handleSubmit}
    />
  );
}
