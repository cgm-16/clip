import Link from 'next/link';
import { Callout } from '@/components/ui/Callout';
import { MonoChip } from '@/components/ui/MonoChip';
import { TextTag } from '@/components/ui/TextTag';
import { ConfigTable } from '@/components/admin/ConfigTable';
import { WEB_COPY } from '@/lib/ui/copy';
import styles from './ScreenC.module.css';

// The `채널 관리` permission constant inside `manageChannelNoLongerNeeded`
// renders in mono, matching design/Clip P0 Screens.dc.html:156's inline
// `font-family:'JetBrains Mono'` span -- the same split-around-a-literal-token
// pattern ScreenA uses for its `/setup` command.
const MANAGE_CHANNELS_LABEL = '채널 관리';

// `usageSteps` (`메시지 우클릭 → 앱 → Clip`) is a fixed three-part string, not
// a general list -- only the last part ever renders as the mono chip
// (design/Clip P0 Screens.dc.html:147-151). Split into exactly its three
// segments rather than mapping generically, the same fixed-shape approach
// ScreenA takes splitting its `/setup` sentence.
const USAGE_STEP_SEPARATOR = ' → ';

export interface ScreenCProps {
  guildId: string;
  archiveChannelId: string;
  archiveChannelName: string;
  /** Whether Clip created the archive channel itself, vs. an existing one was chosen. */
  autoCreated: boolean;
  clipCount: number;
  allowedRoles: { id: string; name: string }[];
}

/**
 * Screen C — setup complete (`docs/06_DESIGN_HANDOFF.md` "Screen C").
 * Reached once `/setup/save` succeeds. The 허용 역할 row lists the configured
 * roles and is omitted when none are configured -- the 관리자 row already says
 * who can clip then, and the handoff has no empty-roles string.
 *
 * Its two actions open the web archive (Screen D) and the current settings
 * (Screen E).
 */
export function ScreenC({
  guildId,
  archiveChannelName,
  autoCreated,
  clipCount,
  allowedRoles,
}: ScreenCProps) {
  const copy = WEB_COPY.setupComplete;
  const [rightClickStep, appStep, clipStep] = copy.usageSteps.split(USAGE_STEP_SEPARATOR);
  const [beforeManage, afterManage] = copy.manageChannelNoLongerNeeded.split(MANAGE_CHANNELS_LABEL);

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.heading}>
          <TextTag color="var(--success-text)">{copy.readyTag}</TextTag>
          <h1 className={styles.title}>{copy.title}</h1>
        </div>

        <ConfigTable
          archiveChannelLabel={archiveChannelName}
          allowedRoles={allowedRoles}
          clipCount={clipCount}
        />

        <div className={styles.usage}>
          <span className={styles.usageHeading}>{copy.usageHeading}</span>
          <div className={styles.usageRow}>
            <span className={styles.usageStep}>{rightClickStep}</span>
            <span className={styles.usageArrow} aria-hidden="true">
              →
            </span>
            <span className={styles.usageStep}>{appStep}</span>
            <span className={styles.usageArrow} aria-hidden="true">
              →
            </span>
            <MonoChip>{clipStep}</MonoChip>
          </div>
        </div>

        {autoCreated && (
          <Callout variant="ok">
            {beforeManage}
            <span className={styles.mono}>{MANAGE_CHANNELS_LABEL}</span>
            {afterManage}
          </Callout>
        )}

        <div className={styles.actions}>
          {/*
           * Links, not the `Button` primitive: both are navigation, and
           * `Button` only renders a `<button>`. Styled to match `Button`'s
           * primary and secondary variants (components/ui/Button.module.css),
           * since the mockup draws them as buttons.
           */}
          <Link className={styles.primaryLink} href={`/admin/${guildId}/archive`}>
            {copy.openArchive}
          </Link>
          <Link className={styles.secondaryLink} href={`/admin/${guildId}/settings`}>
            {copy.reviewSettings}
          </Link>
        </div>
      </div>
    </div>
  );
}
