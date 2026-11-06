'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * motir-ai could not be reached — design MOTIR-10362 Panel 7. The console's error
 * card with Retry and NO rows: an unreadable store never reads as an empty one.
 * Retry re-runs the server read. Exported for the finding detail page too.
 */
export function FindingsUnavailable() {
  const t = useTranslations('platformAdmin.plannerFindings');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <ErrorState
      data-testid="planner-findings-unavailable"
      title={t('unavailable.title')}
      description={t('unavailable.body')}
      retryLabel={t('unavailable.retry')}
      retry={() => startTransition(() => router.refresh())}
      retryPending={pending}
    />
  );
}
