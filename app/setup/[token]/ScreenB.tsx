'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { Select } from '@/components/ui/Select';
import { WEB_COPY, WEB_COPY_TEMPLATES } from '@/lib/ui/copy';
import type { SetupChannel } from '@/lib/discord/guild-lookup';
import { Wordmark } from './Wordmark';
import styles from './ScreenB.module.css';

type Destination = 'create' | 'existing';

export type SetupSubmission = {
  destination: Destination;
  /** Only set for `existing`; `create` never carries a caller-chosen id. */
  channelId: string | null;
};

export interface ScreenBProps {
  channels: SetupChannel[];
  /**
   * Persists the chosen destination. Resolves once the attempt is settled;
   * the boolean is not otherwise interpreted by this component — post-save
   * navigation (Screen C) belongs to whichever screen owns that transition.
   */
  onSubmit: (submission: SetupSubmission) => Promise<boolean>;
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

const DESTINATION_OPTIONS = (channels: SetupChannel[]) => [
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
 * Screen B — first-run archive destination configuration
 * (`docs/06_DESIGN_HANDOFF.md` "Screen B"). Allowed-role configuration is
 * cut from P0 per the task brief; the form persists admin-only clipping,
 * which `docs/01_CLIP_PRODUCT_SPEC.md` already permits.
 */
export function ScreenB({ channels, onSubmit, onCancel, guildName, adminHandle }: ScreenBProps) {
  const [destination, setDestination] = useState<Destination>('create');
  const [channelId, setChannelId] = useState('');
  const [channelError, setChannelError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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

    setPending(true);
    try {
      await onSubmit({
        destination,
        channelId: destination === 'existing' ? channelId : null,
      });
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
          options={DESTINATION_OPTIONS(channels)}
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
              options={channels.map((channel) => ({
                value: channel.id,
                label: `#${channel.name}`,
              }))}
            />
            {channelError && <Callout variant="confirm">{channelError}</Callout>}
            <p className={styles.warning}>{WEB_COPY.setup.destinationExistingWarning}</p>
          </div>
        )}

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
