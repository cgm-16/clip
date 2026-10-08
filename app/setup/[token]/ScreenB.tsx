'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { MonoChip } from '@/components/ui/MonoChip';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { RoleMultiSelect } from '@/components/ui/RoleMultiSelect';
import { Select } from '@/components/ui/Select';
import { WEB_COPY, WEB_COPY_AUTHORED, WEB_COPY_TEMPLATES } from '@/lib/ui/copy';
import type { SetupChannel, SetupRole } from '@/lib/discord/guild-lookup';
import { Wordmark } from './Wordmark';
import styles from './ScreenB.module.css';

type Destination = 'create' | 'existing';

const RETRY_COMMAND = '/setup';
// The save-failed copy wraps a mono "/setup" token; split on the literal
// command and render the halves around a MonoChip, the same technique
// ScreenA's recovery callout uses for `WEB_COPY.expiredSetupLink.recovery`.
const [SAVE_FAILED_BEFORE, SAVE_FAILED_AFTER] =
  WEB_COPY_AUTHORED.saveFailed.split(RETRY_COMMAND);

export type SetupSubmission = {
  destination: Destination;
  /** Only set for `existing`; `create` never carries a caller-chosen id. */
  channelId: string | null;
  /** Roles allowed to clip. Empty means admins only. */
  allowedRoleIds: string[];
};

/** How a save attempt settled — see `app/setup/save/route.ts` for the statuses behind each. */
export type SaveOutcome =
  | { kind: 'saved' }
  | { kind: 'missing-permissions'; missingPermissions: string[] }
  | { kind: 'live-clips' }
  | { kind: 'failed' };

/** The guild's saved configuration, used to prefill an edit. */
export type InitialSetup = { archiveChannelId: string; allowedRoleIds: string[] };

export interface ScreenBProps {
  channels: SetupChannel[];
  roles?: SetupRole[];
  /** The saved configuration; null (the default) for a first setup. */
  initial?: InitialSetup | null;
  /**
   * Persists the chosen destination and roles. Resolves once the attempt is
   * settled. Anything but `saved` renders its error callout and keeps the
   * admin on this screen so they can retry; `saved` clears any prior failure
   * and leaves post-save navigation (Screen C) to whichever screen owns that
   * transition.
   */
  onSubmit: (submission: SetupSubmission) => Promise<SaveOutcome>;
  onCancel?: () => void;
  /**
   * Guild identity bar content (`docs/06_DESIGN_HANDOFF.md` Screen B). Both
   * are optional and the bar is omitted without them: nothing in this task's
   * data flow (`/setup/data` returns only `guildId` and `channels`) supplies
   * a guild display name or the admin's Discord handle yet.
   */
  guildName?: string;
  adminHandle?: string;
}

const DESTINATION_OPTIONS = [
  {
    value: 'create' as const,
    label: WEB_COPY.setup.destinationCreateLabel,
    description: WEB_COPY.setup.destinationCreateDescription,
  },
  {
    value: 'existing' as const,
    label: WEB_COPY.setup.destinationExistingLabel,
  },
];

/**
 * Screen B — archive destination and clipping-role configuration
 * (`docs/06_DESIGN_HANDOFF.md` "Screen B"). A configured guild opens
 * prefilled with its current channel (as `existing`) and roles, so a
 * roles-only edit never creates a second channel.
 */
export function ScreenB({
  channels,
  roles = [],
  initial = null,
  onSubmit,
  onCancel,
  guildName,
  adminHandle,
}: ScreenBProps) {
  const [destination, setDestination] = useState<Destination>(initial ? 'existing' : 'create');
  const [channelId, setChannelId] = useState(initial?.archiveChannelId ?? '');
  const [allowedRoleIds, setAllowedRoleIds] = useState<string[]>(initial?.allowedRoleIds ?? []);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome | null>(null);

  function handleDestinationChange(value: string) {
    const next = value as Destination;
    setDestination(next);
    if (next === 'create') {
      // The field disappears with the "create" destination; an error left
      // over from a previous "existing" attempt would otherwise be orphaned.
      setChannelError(null);
    }
  }

  function validateChannelSelection(currentChannelId: string): boolean {
    if (destination === 'existing' && !currentChannelId) {
      setChannelError(WEB_COPY.setup.destinationChannelRequired);
      return false;
    }
    setChannelError(null);
    return true;
  }

  function handleChannelChange(value: string) {
    setChannelId(value);
    if (value) {
      setChannelError(null);
    }
  }

  function handleChannelBlur() {
    validateChannelSelection(channelId);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validateChannelSelection(channelId)) {
      return;
    }

    // Clear a stale failure from an earlier attempt up front, so it never
    // sits under this attempt's outcome — including while it is pending.
    setSaveOutcome(null);
    setPending(true);
    try {
      const outcome = await onSubmit({
        destination,
        channelId: destination === 'existing' ? channelId : null,
        allowedRoleIds,
      });
      if (outcome.kind !== 'saved') {
        setSaveOutcome(outcome);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.page}>
      {guildName && (
        <div className={styles.identityBar}>
          <div className={styles.identityLeft}>
            <Wordmark />
            <span className={styles.divider} aria-hidden="true" />
            <span className={styles.guildName}>{guildName}</span>
          </div>
          {adminHandle && (
            <span className={styles.adminIdentity}>
              {WEB_COPY_TEMPLATES.adminIdentity.replace('{handle}', adminHandle)}
            </span>
          )}
        </div>
      )}

      <form className={styles.form} onSubmit={handleSubmit}>
        <RadioGroup
          legend={WEB_COPY.setup.destinationLegend}
          name="destination"
          value={destination}
          onChange={handleDestinationChange}
          options={DESTINATION_OPTIONS}
        />

        {destination === 'existing' && (
          <div className={styles.existingChannel}>
            <Select
              id="archive-channel"
              label={WEB_COPY.archive.channelFilterLabel}
              mono
              value={channelId}
              onChange={(event) => handleChannelChange(event.target.value)}
              onBlur={handleChannelBlur}
              aria-invalid={channelError ? true : undefined}
              options={[
                { value: '', label: WEB_COPY_AUTHORED.setupExistingChannelPlaceholder },
                ...channels.map((channel) => ({
                  value: channel.id,
                  label: `#${channel.name}`,
                })),
              ]}
            />
            {channelError && <Callout variant="confirm">{channelError}</Callout>}
            <p className={styles.warning}>{WEB_COPY.setup.destinationExistingWarning}</p>
          </div>
        )}

        <div className={styles.roles}>
          <RoleMultiSelect
            legend={WEB_COPY.setup.rolesLegend}
            placeholder={WEB_COPY.setup.rolesPlaceholder}
            roles={roles}
            value={allowedRoleIds}
            onChange={setAllowedRoleIds}
          />
          <Callout variant="note">{WEB_COPY.setup.rolesNote}</Callout>
        </div>

        <div className={styles.consequences}>
          <p className={styles.consequencesHeading}>{WEB_COPY.setup.consequencesHeading}</p>
          {[
            WEB_COPY.setup.consequenceClipping,
            WEB_COPY.setup.consequenceStorage,
            WEB_COPY.setup.consequenceAuthorRemoval,
          ].map((text) => (
            <div key={text} className={styles.consequenceRow}>
              <span className={styles.dash} aria-hidden="true">
                —
              </span>
              <p className={styles.consequenceText}>{text}</p>
            </div>
          ))}
        </div>

        {/* Always mounted so a screen reader picks up the region before its
            content changes — the same reasoning the handoff's toast spec
            (line 121) applies to `aria-live="polite"`. `Callout` itself
            supplies no `aria-live`, so it is added here at the call site. */}
        <div className={styles.saveError} aria-live="polite">
          {saveOutcome?.kind === 'failed' && (
            <Callout variant="error">
              {SAVE_FAILED_BEFORE}
              <MonoChip>{RETRY_COMMAND}</MonoChip>
              {SAVE_FAILED_AFTER}
            </Callout>
          )}
          {saveOutcome?.kind === 'missing-permissions' && (
            <>
              <Callout variant="error">{WEB_COPY_AUTHORED.destinationMissingPermissions}</Callout>
              <div className={styles.missingPermissions}>
                {saveOutcome.missingPermissions.map((permission) => (
                  <MonoChip key={permission}>{permission}</MonoChip>
                ))}
              </div>
            </>
          )}
          {saveOutcome?.kind === 'live-clips' && (
            <Callout variant="error">{WEB_COPY_AUTHORED.destinationChangeBlocked}</Callout>
          )}
        </div>

        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={pending}>
            {WEB_COPY.setup.save}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {WEB_COPY.setup.cancel}
          </Button>
        </div>
      </form>
    </div>
  );
}
