'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
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

// The confirm panel's copy, which describes the acknowledgement that confirms it.
const CONSEQUENCES_ID = 'delete-confirm-consequences';
const LOSES_CONTROL_ID = 'delete-confirm-loses-control';
const FAILED_ID = 'delete-confirm-failed';

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
  // The saved toast greets the arrival from an edit. Opening the deletion
  // panel hides it for good, so 취소 does not announce a save that never ran.
  const [savedToast, setSavedToast] = useState(props.saved);
  // The start button is disabled while the panel is open, so 취소 hands focus
  // back to it once it is enabled again rather than leaving it on the page body.
  const startButton = useRef<HTMLButtonElement>(null);
  const returnFocusToStart = useRef(false);

  // 삭제 실행 and 취소 are disabled while the request runs, so a failure hands
  // focus to the acknowledgement, the panel's first enabled control.
  const acknowledgement = useRef<HTMLInputElement>(null);

  // Success unmounts the confirm panel that held focus, so focus moves to the result.
  const deletionResult = useRef<HTMLDivElement>(null);
  const confirmPanel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (flow === 'idle' && returnFocusToStart.current) {
      returnFocusToStart.current = false;
      startButton.current?.focus();
    }
    // Both rescues are for focus the request dropped (on body, or still in the
    // panel). An admin who moved on while it ran, e.g. to 설정 변경, keeps theirs.
    const active = document.activeElement;
    const focusDropped =
      active === null || active === document.body || confirmPanel.current?.contains(active) === true;
    if (flow === 'failed' && focusDropped) {
      acknowledgement.current?.focus();
    }
    if (flow === 'deleted' && focusDropped) {
      deletionResult.current?.focus();
    }
  }, [flow]);

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
    returnFocusToStart.current = true;
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
      {/* Always mounted, so both the saved toast and the deletion result are announced. */}
      <div aria-live="polite" className={styles.toast}>
        {savedToast && flow === 'idle' && <Callout variant="ok">{WEB_COPY.setup.saved}</Callout>}
        {flow === 'deleted' && (
          <div ref={deletionResult} tabIndex={-1} className={styles.done}>
            <Callout variant="ok">{WEB_COPY_AUTHORED.deletionCompleted}</Callout>
            <Callout variant="note">
              {RECOVERY_BEFORE}
              <MonoChip>{RETRY_COMMAND}</MonoChip>
              {RECOVERY_AFTER}
            </Callout>
          </div>
        )}
      </div>
      {flow !== 'deleted' && (
        <div className={styles.columns}>
          <section className={styles.main}>
            <span className={styles.label}>{copy.currentSettingsLabel}</span>
            <h1 className={styles.title}>{props.guildLabel}</h1>
            {props.archiveChannelMissing && (
              <Callout variant="missing">{WEB_COPY_AUTHORED.archiveChannelMissing}</Callout>
            )}
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
                <Button
                  ref={startButton}
                  variant="danger"
                  onClick={() => {
                    setSavedToast(false);
                    setFlow('confirming');
                  }}
                  disabled={panelOpen}
                >
                  {copy.startDeletion}
                </Button>
              </div>
            </fieldset>
          </section>

          {panelOpen && (
            <section ref={confirmPanel} className={styles.confirm} aria-labelledby="delete-confirm-title">
              <h2 id="delete-confirm-title" className={styles.confirmTitle}>
                {copy.confirmTitle}
              </h2>
              <ul id={CONSEQUENCES_ID} className={styles.consequences}>
                {consequences.map(({ mark, text }) => (
                  <li key={text} className={styles.consequence}>
                    <TextTag color={mark === copy.removedMark ? 'var(--error-text)' : 'var(--success-text)'}>
                      {mark}
                    </TextTag>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
              <p id={LOSES_CONTROL_ID} className={styles.dangerText}>
                {WEB_COPY_AUTHORED.deletionLosesControlState}
              </p>
              <label className={styles.acknowledge}>
                {/* Opening disables the focused start button; focus moves to the panel's first control.
                    That skips the copy above, so the box is described by it, and by a failure once there is one. */}
                <input
                  ref={acknowledgement}
                  type="checkbox"
                  autoFocus
                  aria-describedby={[flow === 'failed' ? FAILED_ID : null, CONSEQUENCES_ID, LOSES_CONTROL_ID]
                    .filter(Boolean)
                    .join(' ')}
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                {copy.acknowledgement}
              </label>
              <div id={FAILED_ID} aria-live="polite">
                {flow === 'failed' && <Callout variant="error">{WEB_COPY_AUTHORED.deletionFailed}</Callout>}
              </div>
              <div className={styles.actions}>
                <Button variant="dangerSolid" onClick={confirmDeletion} disabled={!acknowledged || flow === 'deleting'}>
                  {copy.confirmDeletion}
                </Button>
                <Button variant="secondary" onClick={cancel} disabled={flow === 'deleting'}>
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
