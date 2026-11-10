'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * The Run-side defaults card when motir-ai could not be read (MOTIR-10844): the
 * console's error card with Retry and NO rows, so staff never read a guessed
 * default. The run-model list above it is a separate section and unaffected.
 */
export function RunModelDefaultsUnavailable() {
  const t = useTranslations('platformAdmin.runModels.defaults');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <ErrorState
      data-testid="run-side-defaults-unavailable"
      title={t('unavailable.title')}
      description={t('unavailable.body')}
      retryLabel={t('unavailable.retry')}
      retry={() => startTransition(() => router.refresh())}
      retryPending={pending}
    />
  );
}
