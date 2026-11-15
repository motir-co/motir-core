'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * Model serving Panel 7 — the gateway did not answer, so no list is drawn
 * half-known: the console's error card with Retry, and no rows.
 */
export function ModelServingUnavailable() {
  const t = useTranslations('platformAdmin.modelServing');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <ErrorState
      data-testid="model-serving-unavailable"
      title={t('error.unreachable.title')}
      description={t('error.unreachable.body')}
      retryLabel={t('error.retry')}
      retry={() => startTransition(() => router.refresh())}
      retryPending={pending}
    />
  );
}
