'use client';

import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';
import type { PlatformCapacityUnavailableReason } from '@/lib/dto/platformCapacity';

/**
 * The PAGE ERROR PANEL (MOTIR-9614, design `platform-admin` AMENDMENT
 * 2026-10-25, Panels 8–9): the gateway gave no read, so no entry is drawn — no
 * limit, no usage, and nothing of the credential. Retry re-reads the route.
 *
 * The read names only `credential`, not which of the gateway's three credential
 * codes refused it, so the credential panel says the one sentence true of all
 * three rather than guessing among the design's per-code lines.
 */
export function CapacityErrorPanel({
  reason,
  onRetry,
  retrying,
}: {
  reason: PlatformCapacityUnavailableReason;
  onRetry: () => void;
  retrying: boolean;
}) {
  const t = useTranslations('platformAdmin.capacity');
  const copy =
    reason === 'credential'
      ? { title: t('error.auth.title'), description: t('error.auth.body') }
      : { title: t('error.unreachable.title'), description: t('error.unreachable.body') };
  return (
    <ErrorState
      data-testid={`capacity-error-${reason}`}
      title={copy.title}
      description={copy.description}
      retry={onRetry}
      retryLabel={t('error.retry')}
      retryPending={retrying}
    />
  );
}
