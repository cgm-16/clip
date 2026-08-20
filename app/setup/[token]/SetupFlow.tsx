'use client';

import { useEffect, useState } from 'react';
import type { SetupChannel } from '@/lib/discord/guild-lookup';
import { ScreenA } from './ScreenA';
import { ScreenB, type SetupSubmission } from './ScreenB';

type FlowState =
  | { status: 'loading' }
  | { status: 'expired' }
  | { status: 'ready'; guildId: string; channels: SetupChannel[] };

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

  return <ScreenB channels={state.channels} onSubmit={handleSubmit} />;
}

// Persisting the chosen destination (writing GuildConfig, and for "create"
// actually creating the Discord archive channel) is DAG node 4.4's concern,
// not this task's — see task-6-report.md. This wires the form's submit to a
// save endpoint that does not exist yet, so a real submit currently 404s;
// ScreenB's own tests inject their own `onSubmit` and never exercise this.
async function handleSubmit(submission: SetupSubmission): Promise<boolean> {
  const response = await fetch('/setup/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submission),
  });
  return response.ok;
}
