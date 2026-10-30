'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

// The Production panel's ERROR state (Story MOTIR-9797 · MOTIR-10037, design
// MOTIR-10024 panel 15): the read failed, so the error replaces both cards and
// nothing stale is shown as live. Try again re-renders the server section, which
// reads the panel again.

export function ProductionError() {
  const t = useTranslations('settings.production');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <ErrorState
      data-testid="production-load-error"
      title={t('loadError.title')}
      description={t('loadError.body')}
      retry={() => startTransition(() => router.refresh())}
      retryLabel={t('retry')}
      retryPending={pending}
    />
  );
}
