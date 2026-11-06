import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FINDING_FILTER_KEYS, FINDINGS_PAGE_SIZE, oneParam } from './filterKeys';

const BASE = '/admin/planner-findings';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The cursor pager — the lessons console's, unchanged. Next carries the answered
 * cursor and pushes the current one onto `trail`; Previous pops it. Both keep
 * every filter and the view. Shared by the grouped view.
 */
export async function FindingsPager({
  params,
  pageNumber,
  trail,
  cursor,
  nextCursor,
}: {
  params: SearchParams;
  pageNumber: number;
  trail: string[];
  cursor: string | undefined;
  nextCursor: string | null;
}) {
  const t = await getTranslations('platformAdmin.plannerFindings.pager');
  const href = (nextCursorValue: string | undefined, nextTrail: string[]) => {
    const url = new URLSearchParams();
    for (const key of FINDING_FILTER_KEYS) {
      const value = oneParam(params[key]);
      if (value) url.set(key, value);
    }
    const view = oneParam(params['view']);
    if (view) url.set('view', view);
    if (nextCursorValue) url.set('cursor', nextCursorValue);
    if (nextCursorValue && nextTrail.length > 0) url.set('trail', nextTrail.join(','));
    const qs = url.toString();
    return qs ? `${BASE}?${qs}` : BASE;
  };
  const previous = pageNumber > 1 ? href(trail[trail.length - 1], trail.slice(0, -1)) : null;
  const next = nextCursor ? href(nextCursor, cursor ? [...trail, cursor] : trail) : null;
  const link =
    'inline-flex h-(--height-btn-sm) items-center rounded-(--radius-btn) border border-(--el-border) px-(--spacing-btn-x-sm) font-sans text-sm text-(--el-text) hover:bg-(--el-surface-soft)';
  return (
    <nav
      aria-label={t('label', { n: FINDINGS_PAGE_SIZE })}
      data-testid="planner-findings-pager"
      className="flex flex-wrap items-center justify-between gap-2 border-t border-(--el-border-soft) pt-3 font-sans text-xs text-(--el-text-secondary)"
    >
      <span>{t('label', { n: FINDINGS_PAGE_SIZE })}</span>
      <div className="flex items-center gap-2">
        <span className="text-(--el-text)">{t('page', { n: pageNumber })}</span>
        {previous ? (
          <Link className={link} href={previous}>
            {t('previous')}
          </Link>
        ) : null}
        {next ? (
          <Link className={link} href={next}>
            {t('next')}
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
