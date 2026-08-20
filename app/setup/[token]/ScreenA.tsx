import { Callout } from '@/components/ui/Callout';
import { MonoChip } from '@/components/ui/MonoChip';
import { WEB_COPY } from '@/lib/ui/copy';
import { Wordmark } from './Wordmark';
import styles from './ScreenA.module.css';

const RECOVERY_COMMAND = '/setup';

/**
 * Screen A — the setup link is expired, already used, or unknown. Reachable
 * without a session, deliberately a dead end with a recovery path rather
 * than a retry form: `docs/06_DESIGN_HANDOFF.md` "Screen A" — "recover,
 * never dead-end."
 *
 * `SetupFlow` renders this for all three failure causes alike (unknown,
 * used, expired) — `lib/admin-session/service.ts`'s `exchangeSetupToken`
 * already collapses them into one indistinguishable outcome so a guess
 * cannot be confirmed by which message comes back.
 */
export function ScreenA() {
  const copy = WEB_COPY.expiredSetupLink;
  // The recovery sentence wraps a mono `/setup` token. Splitting on the
  // literal command and rendering the halves around a MonoChip keeps the
  // callout's rendered text identical to the copy string character for
  // character, rather than hand-writing the sentence around the chip.
  const [beforeCommand, afterCommand] = copy.recovery.split(RECOVERY_COMMAND);

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <Wordmark />
        <div className={styles.body}>
          <h1 className={styles.title}>{copy.title}</h1>
          <p className={styles.explanation}>{copy.explanation}</p>
        </div>
        <Callout variant="note">
          {beforeCommand}
          <MonoChip>{RECOVERY_COMMAND}</MonoChip>
          {afterCommand}
        </Callout>
        <p className={styles.footnote}>{copy.archiveStillWorks}</p>
      </div>
    </div>
  );
}
