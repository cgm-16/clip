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
 * session (`lib/admin-session`), then branches between Screen A (dead link)
 * and Screen B (destination form). The link's token always decides which
 * guild the page is for, never a session the browser happens to hold: a
 * reload, re-click or retry of a link already spent is sent to the exchange
 * again, which re-opens it only for the session that token paid for (#72).
 */
export function SetupFlow({ token }: { token: string }) {
  const router = useRouter();
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
        // A live session is trusted without asking only for a token this
        // mount already spent. Otherwise it may belong to another guild's link
        // (#62), or have replaced this link's own since (#72), so the token is
        // sent to the exchange, which knows its guild and decides.
        if (!capability.canExchangeToken) {
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
        // dropped; a retry exchanges again, and the server re-opens the token
        // for the session it created (#72).
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
