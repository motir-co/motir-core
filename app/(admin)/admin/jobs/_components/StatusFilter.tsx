import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { JobRunStatus } from '@/lib/dto/jobs';
import { cn } from '@/lib/utils/cn';
import { jobsHref } from './href';

/** The shipped run statuses, in the order the design draws the chips. */
export const RUN_STATUSES: readonly JobRunStatus[] = [
  'running',
  'succeeded',
  'failed',
  'abandoned',
] as const;

/**
 * Status filter — chips **All · Running · Succeeded · Failed · Abandoned**, each
 * a link (`?status=`) that resets the page; the current chip carries
 * `aria-current`. There is no dead-lettered run status: that work is on the
 * Dead letters tab.
 */
export function StatusFilter({ status }: { status?: JobRunStatus }) {
  const t = useTranslations('platformAdmin');
  const chips = [
    { value: undefined, label: t('jobs.status.all') },
    ...RUN_STATUSES.map((value) => ({ value, label: t(`jobs.status.${value}`) })),
  ];
  return (
    <div
      role="group"
      aria-label={t('jobs.status.label')}
      className="flex flex-wrap items-center gap-1.5"
    >
      {chips.map(({ value, label }) => {
        const active = value === status;
        return (
          <Link
            key={value ?? 'all'}
            href={jobsHref({ tab: 'runs', status: value })}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'rounded-(--radius-badge) border px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
              active
                ? 'border-(--el-accent) bg-(--el-tint-lavender) text-(--el-text-strong)'
                : 'border-(--el-border) text-(--el-text-secondary) hover:bg-(--el-surface)',
            )}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}
