'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SessionExpired } from '@/components/admin/SessionExpired';
import { ScreenB, type SaveOutcome, type SetupSubmission } from '@/app/setup/[token]/ScreenB';
import { ScreenLoadError } from '@/app/setup/[token]/ScreenLoadError';
import { fetchSetupData, parseSaveResult, saveOutcomeOf, type SetupData } from '@/app/setup/[token]/setup-client';

type State = { status: 'loading' } | { status: 'expired' } | { status: 'failed' } | { status: 'ready'; data: SetupData };

/**
 * The explicit edit reached from Screen E's 설정 변경 (decision D1): the
 * prefilled Screen B on the existing session, with no setup token involved.
 * A successful save returns to Screen E, which shows 설정을 저장했습니다.
 */
export function AdminSetupEdit({ guildId }: { guildId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const settingsHref = `/admin/${guildId}/settings`;

  useEffect(() => {
    let cancelled = false;
    fetchSetupData().then((result) => {
      if (cancelled) {
        return;
      }
      if (result.status === 'ready') {
        setState({ status: 'ready', data: result.data });
      } else {
        setState({ status: result.status === 'unauthenticated' ? 'expired' : 'failed' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (state.status === 'loading') {
    return null;
  }
  if (state.status === 'expired') {
    return <SessionExpired />;
  }
  if (state.status === 'failed') {
    return (
      <ScreenLoadError
        onRetry={() => {
          setState({ status: 'loading' });
          setAttempt((count) => count + 1);
        }}
      />
    );
  }

  const { data } = state;
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
      if (!parseSaveResult(await response.json())) {
        return { kind: 'failed' };
      }
      router.push(`${settingsHref}?saved=1`);
      return { kind: 'saved' };
    } catch {
      return { kind: 'failed' };
    }
  }

  return (
    <ScreenB
      channels={data.channels}
      roles={data.roles}
      initial={data.config}
      archiveChannelMissing={data.archiveChannelMissing}
      archiveHref={`/admin/${guildId}/archive`}
      guildName={data.guildName ?? data.guildId}
      adminHandle={data.adminHandle ?? undefined}
      onSubmit={handleSubmit}
      onCancel={() => router.push(settingsHref)}
    />
  );
}
