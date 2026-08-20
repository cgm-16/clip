'use client';

import { useEffect, useState } from 'react';
import type { SetupChannel } from '@/lib/discord/guild-lookup';
import { ScreenA } from './ScreenA';
import { ScreenB, type SetupSubmission } from './ScreenB';
import { ScreenC } from './ScreenC';

/** `/setup/save`'s success body — see `app/setup/save/route.ts`. */
type SaveResult = {
  archiveChannelId: string;
  archiveChannelName: string;
  autoCreated: boolean;
  clipCount: number;
};

type FlowState =
  | { status: 'loading' }
  | { status: 'expired' }
  | { status: 'ready'; guildId: string; channels: SetupChannel[] }
  | ({ status: 'complete'; guildId: string; channels: SetupChannel[] } & SaveResult);

type SetupData = { guildId: string; channels: SetupChannel[] };

async function fetchSetupData(): Promise<SetupData | null> {
  const response = await fetch('/setup/data');
  if (!response.ok) {
    return null;
  }
  return response.json();
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

  useEffect(() => {
    let cancelled = false;

    async function run() {
      // A cookie from an earlier visit may already carry a live session —
      // try it first so a reload never re-spends the (one-time) setup token.
      const existing = await fetchSetupData();
      if (existing) {
        if (!cancelled) {
          setState({ status: 'ready', ...existing });
        }
        return;
      }

      const exchangeResponse = await fetch('/api/setup/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!exchangeResponse.ok) {
        if (!cancelled) {
          setState({ status: 'expired' });
        }
        return;
      }

      const data = await fetchSetupData();
      if (!cancelled) {
        setState(data ? { status: 'ready', ...data } : { status: 'expired' });
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === 'loading') {
    return null;
  }

  if (state.status === 'expired') {
    return <ScreenA />;
  }

  if (state.status === 'complete') {
    return (
      <ScreenC
        guildId={state.guildId}
        archiveChannelId={state.archiveChannelId}
        archiveChannelName={state.archiveChannelName}
        autoCreated={state.autoCreated}
        clipCount={state.clipCount}
        onReviewSettings={() =>
          setState({ status: 'ready', guildId: state.guildId, channels: state.channels })
        }
      />
    );
  }

  // Only 'ready' remains at this point. Captured as plain locals, not
  // repeated `state.x` reads, since TypeScript's narrowing of `state` above
  // does not extend into the nested `handleSubmit` closure below.
  const { guildId, channels } = state;

  // Posts the chosen destination to `/setup/save`
  // (`docs/06_DESIGN_HANDOFF.md` "Setup form": "success → Screen C"). A save
  // that fails leaves the admin on Screen B to retry; `onSubmit`'s boolean is
  // how ScreenB knows to render its save-failed error callout
  // (`WEB_COPY_AUTHORED.saveFailed`) rather than silently doing nothing (see
  // `ScreenB.tsx`'s own doc comment on `onSubmit`).
  async function handleSubmit(submission: SetupSubmission): Promise<boolean> {
    let response: Response;
    try {
      response = await fetch('/setup/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      });
    } catch {
      // An offline or reset connection rejects instead of answering. That is
      // still a failed save, so it has to leave here as `false`; thrown, it
      // would escape ScreenB's submit handler and the admin would be left
      // with no error callout at all.
      return false;
    }
    if (!response.ok) {
      return false;
    }
    const result: SaveResult = await response.json();
    setState({ status: 'complete', guildId, channels, ...result });
    return true;
  }

  return <ScreenB channels={channels} onSubmit={handleSubmit} />;
}
