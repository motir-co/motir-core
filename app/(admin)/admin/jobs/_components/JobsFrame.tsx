import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { JobsTabs } from './JobsTabs';

/**
 * Page header and Tab bar — the monitoring page's header pattern: a secondary
 * uppercase breadcrumb _Platform · Jobs_, a serif `h1`, one secondary sentence.
 */
export function JobsFrame({
  tab,
  waiting,
  children,
}: {
  tab: 'runs' | 'dlq';
  waiting: number | null;
  children: ReactNode;
}) {
  const t = useTranslations('platformAdmin');
  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('jobs.breadcrumb')}
      </p>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('jobs.title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
          {t('jobs.subtitle')}
        </p>
      </div>
      <JobsTabs activeTab={tab} waiting={waiting} />
      {children}
    </div>
  );
}
