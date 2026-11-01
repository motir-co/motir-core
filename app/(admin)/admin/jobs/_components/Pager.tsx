import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button, buttonVariants } from '@/components/ui/Button';
import type { JobRunStatus } from '@/lib/dto/jobs';
import { jobsHref } from './href';

/**
 * Pager — _Page {n}_ and secondary **Previous** / **Next**, 50 rows a page.
 * `hasMore` decides Next; an end with no page is a disabled button. The links
 * keep the status.
 */
export function Pager({
  page,
  hasMore,
  status,
}: {
  page: number;
  hasMore: boolean;
  status?: JobRunStatus;
}) {
  const t = useTranslations('platformAdmin');
  if (page === 1 && !hasMore) return null;
  const link = (target: number, label: string) => (
    <Link
      href={jobsHref({ tab: 'runs', status, page: target })}
      className={buttonVariants({ variant: 'secondary', size: 'sm' })}
    >
      {label}
    </Link>
  );
  const dead = (label: string) => (
    <Button variant="secondary" size="sm" disabled>
      {label}
    </Button>
  );
  return (
    <nav aria-label={t('jobs.pagerLabel')} className="flex items-center justify-end gap-2">
      <span className="font-sans text-xs text-(--el-text-secondary)">
        {t('jobs.pageLabel', { page })}
      </span>
      {page > 1 ? link(page - 1, t('jobs.previous')) : dead(t('jobs.previous'))}
      {hasMore ? link(page + 1, t('jobs.next')) : dead(t('jobs.next'))}
    </nav>
  );
}
