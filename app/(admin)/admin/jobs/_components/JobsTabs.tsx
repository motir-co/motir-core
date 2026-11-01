import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';
import { cn } from '@/lib/utils/cn';
import { jobsHref } from './href';

/**
 * Tab bar — **Runs** and **Dead letters**, each a link (`?tab=`), the Dead
 * letters tab carrying the waiting count. A `tablist` of links with
 * `aria-selected`, per the design's accessibility contract.
 */
export function JobsTabs({
  activeTab,
  waiting,
}: {
  activeTab: 'runs' | 'dlq';
  /** Waiting dead letters across every function; `null` when the read failed. */
  waiting: number | null;
}) {
  const t = useTranslations('platformAdmin');
  const tabs = [
    { tab: 'runs' as const, label: t('jobs.tabs.runs'), count: null },
    { tab: 'dlq' as const, label: t('jobs.tabs.dlq'), count: waiting },
  ];
  return (
    <div
      role="tablist"
      aria-label={t('jobs.tabsLabel')}
      className="flex gap-1 border-b border-(--el-border)"
    >
      {tabs.map(({ tab, label, count }) => {
        const active = tab === activeTab;
        return (
          <Link
            key={tab}
            role="tab"
            aria-selected={active}
            href={jobsHref({ tab })}
            className={cn(
              'inline-flex items-center gap-2 px-(--spacing-control-x-12) py-(--spacing-control-y-8) font-sans text-sm font-medium',
              '-mb-px border-b-2 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
              active
                ? 'border-(--el-accent) text-(--el-text)'
                : 'border-transparent text-(--el-text-muted) hover:text-(--el-text)',
            )}
          >
            {label}
            {count !== null && count > 0 ? (
              <Pill tone="neutral" aria-label={t('jobs.tabs.waiting', { count })}>
                {count}
              </Pill>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
