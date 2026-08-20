import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { WEB_COPY_AUTHORED } from '@/lib/ui/copy';
import { Wordmark } from './Wordmark';
import styles from './SetupStatusCard.module.css';

export function ScreenLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <Wordmark />
        <Callout variant="error">{WEB_COPY_AUTHORED.setupDataLoadFailed}</Callout>
        <Button variant="primary" onClick={onRetry}>
          {WEB_COPY_AUTHORED.retry}
        </Button>
      </div>
    </div>
  );
}
