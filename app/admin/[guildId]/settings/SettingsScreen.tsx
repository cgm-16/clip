'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AdminHeader } from '@/components/admin/AdminHeader';
import { ConfigTable } from '@/components/admin/ConfigTable';
import { SessionExpired } from '@/components/admin/SessionExpired';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { MonoChip } from '@/components/ui/MonoChip';
import { TextTag } from '@/components/ui/TextTag';
import { WEB_COPY, WEB_COPY_AUTHORED, WEB_COPY_TEMPLATES } from '@/lib/ui/copy';
import styles from './SettingsScreen.module.css';

const RETRY_COMMAND = '/setup';
const [RECOVERY_BEFORE, RECOVERY_AFTER] = WEB_COPY.expiredSetupLink.recovery.split(RETRY_COMMAND);

type DeleteFlow = 'idle' | 'confirming' | 'deleting' | 'failed' | 'deleted' | 'expired';

export type SettingsScreenProps = {
  guildId: string;
  guildLabel: string;
  /** Channel name, or the id when Discord has no such channel. */
  archiveChannelLabel: string;
  archiveChannelMissing: boolean;
  allowedRoles: { id: string; name: string }[];
  clipCount: number;
  /** `?saved=1`: an edit just saved, so the 설정을 저장했습니다. toast shows. */
  saved: boolean;
};

/**
 * Screen E. Kept separate from Screen B by design: repeat-visit
 * configuration with a destructive action serves a different purpose from
 * first-run setup. Deletion is always two steps (handoff "Deletion"), and
 * the server enforces the acknowledgement too.
 */
export function SettingsScreen(props: SettingsScreenProps) {
  const copy = WEB_COPY.deleteData;
  const [flow, setFlow] = useState<DeleteFlow>('idle');
  const [acknowledged, setAcknowledged] = useState(false);

  if (flow === 'expired') {
    return <SessionExpired />;
  }

  async function confirmDeletion() {
    setFlow('deleting');
    try {
      const response = await fetch(`/api/admin/guilds/${props.guildId}/delete-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledged: true }),
      });
      setFlow(response.ok ? 'deleted' : response.status === 401 ? 'expired' : 'failed');
    } catch {
      setFlow('failed');
    }
  }

  function cancel() {
    setFlow('idle');
    setAcknowledged(false);
  }

  const panelOpen = flow === 'confirming' || flow === 'deleting' || flow === 'failed';
  const consequences = [
    { mark: copy.removedMark, text: copy.removedConfiguration },
    { mark: copy.removedMark, text: copy.removedClipRecords },
    {
      mark: copy.keptMark,
      text: WEB_COPY_TEMPLATES.keptArchiveChannel.replace('{channel}', props.archiveChannelLabel),
    },
    { mark: copy.keptMark, text: copy.keptSourceMessages },
  ];

  return (
    <div className={styles.page}>
      <AdminHeader guildId={props.guildId} guildLabel={props.guildLabel} active="settings" />
      <div aria-live="polite" className={styles.toast}>
        {props.saved && flow === 'idle' && <Callout variant="ok">{WEB_COPY.setup.saved}</Callout>}
      </div>
      {flow === 'deleted' ? (
        <section className={styles.done}>
          <Callout variant="ok">{WEB_COPY_AUTHORED.deletionCompleted}</Callout>
          <Callout variant="note">
            {RECOVERY_BEFORE}
            <MonoChip>{RETRY_COMMAND}</MonoChip>
            {RECOVERY_AFTER}
          </Callout>
        </section>
      ) : (
        <div className={styles.columns}>
          <section className={styles.main}>
            <span className={styles.label}>{copy.currentSettingsLabel}</span>
            <h1 className={styles.title}>{props.guildLabel}</h1>
            <ConfigTable
              archiveChannelLabel={props.archiveChannelLabel}
              allowedRoles={props.allowedRoles}
              clipCount={props.clipCount}
            />
            <div>
              <Link className={styles.secondaryLink} href={`/admin/${props.guildId}/setup`}>
                {copy.editSettings}
              </Link>
            </div>
            <fieldset className={styles.danger}>
              <legend className={styles.dangerLegend}>{copy.dangerZoneLegend}</legend>
              <p className={styles.dangerText}>{copy.dangerZoneExplanation}</p>
              <div>
                <Button variant="danger" onClick={() => setFlow('confirming')} disabled={panelOpen}>
                  {copy.startDeletion}
                </Button>
              </div>
            </fieldset>
          </section>

          {panelOpen && (
            <section className={styles.confirm} aria-labelledby="delete-confirm-title">
              <h2 id="delete-confirm-title" className={styles.confirmTitle}>
                {copy.confirmTitle}
              </h2>
              <ul className={styles.consequences}>
                {consequences.map(({ mark, text }) => (
                  <li key={text} className={styles.consequence}>
                    <TextTag color={mark === copy.removedMark ? 'var(--error-text)' : 'var(--success-text)'}>
                      {mark}
                    </TextTag>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
              <p className={styles.dangerText}>{WEB_COPY_AUTHORED.deletionLosesControlState}</p>
              <label className={styles.acknowledge}>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                {copy.acknowledgement}
              </label>
              <div aria-live="polite">
                {flow === 'failed' && <Callout variant="error">{WEB_COPY_AUTHORED.deletionFailed}</Callout>}
              </div>
              <div className={styles.actions}>
                <Button variant="danger" onClick={confirmDeletion} disabled={!acknowledged || flow === 'deleting'}>
                  {copy.confirmDeletion}
                </Button>
                <Button variant="secondary" onClick={cancel}>
                  {copy.cancel}
                </Button>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
