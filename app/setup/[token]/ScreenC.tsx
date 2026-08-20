import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { MonoChip } from '@/components/ui/MonoChip';
import { TextTag } from '@/components/ui/TextTag';
import { WEB_COPY, WEB_COPY_TEMPLATES } from '@/lib/ui/copy';
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
  onReviewSettings?: () => void;
}

/**
 * Screen C — setup complete (`docs/06_DESIGN_HANDOFF.md` "Screen C").
 * Reached once `/setup/save` succeeds. The 허용 역할 row from the mockup is
 * omitted: allowed-role configuration is cut from P0 per the task brief, and
 * admin-only clipping (the 관리자 row) is what ships.
 *
 * `아카이브 열기` points directly at the Discord archive channel -- Wave 5's
 * web archive view is cut, so there is no web page for it to open, and the
 * archive genuinely lives in Discord.
 */
export function ScreenC({
  guildId,
  archiveChannelId,
  archiveChannelName,
  autoCreated,
  clipCount,
  onReviewSettings,
}: ScreenCProps) {
  const copy = WEB_COPY.setupComplete;
  const archiveUrl = `https://discord.com/channels/${guildId}/${archiveChannelId}`;
  const [rightClickStep, appStep, clipStep] = copy.usageSteps.split(USAGE_STEP_SEPARATOR);
  const [beforeManage, afterManage] = copy.manageChannelNoLongerNeeded.split(MANAGE_CHANNELS_LABEL);

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.heading}>
          <TextTag color="var(--success-text)">{copy.readyTag}</TextTag>
          <h1 className={styles.title}>{copy.title}</h1>
        </div>

        <div className={styles.summary}>
          <div className={styles.row}>
            <span className={styles.key}>{copy.archiveChannelKey}</span>
            <span className={`${styles.value} ${styles.mono}`}>{`#${archiveChannelName}`}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>{copy.adminsKey}</span>
            <span className={styles.value}>{copy.adminsValue}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>{copy.clipCountKey}</span>
            <span className={`${styles.value} ${styles.mono}`}>
              {WEB_COPY_TEMPLATES.clipCount.replace('{count}', String(clipCount))}
            </span>
          </div>
        </div>

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
           * A real `<a>`, not the `Button` primitive: this is navigation to
           * the Discord archive channel, not an in-page action, and `Button`
           * only renders a `<button>`. Styled to match `Button`'s primary
           * variant (components/ui/Button.module.css) since the mockup draws
           * it identically to a primary button.
           */}
          <a
            className={styles.primaryLink}
            href={archiveUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {copy.openArchive}
          </a>
          <Button variant="secondary" onClick={onReviewSettings}>
            {copy.reviewSettings}
          </Button>
        </div>
      </div>
    </div>
  );
}
