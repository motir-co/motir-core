'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * A failed read, in place of its table: the shell, the tabs and the filters
 * stay usable, and Try again re-reads the page.
 */
export function SectionError({ which }: { which: 'runs' | 'dlq' }) {
  const t = useTranslations('platformAdmin');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <ErrorState
      title={which === 'runs' ? t('jobs.runsError.title') : t('jobs.dlqError.title')}
      description={t('jobs.error.body')}
      retryLabel={t('jobs.retry')}
      retryPending={pending}
      retry={() => startTransition(() => router.refresh())}
    />
  );
}
