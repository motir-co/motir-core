import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FINDING_FILTER_KEYS, FINDINGS_PAGE_SIZE, oneParam } from './filterKeys';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The cursor pager — the lessons console's, unchanged, shared by the list, the
 * grouped view and a group's page. There is no total: Next carries the answered
 * cursor and pushes the current one onto `trail`; Previous pops it, so every
 * page a walk left is reachable again. Every link keeps the filter keys and the
 * `keep` params (the view), in that order, and lands on `basePath`.
 */
export async function FindingsPager({
  basePath,
  params,
  keep = {},
  pageNumber,
  trail,
  cursor,
  nextCursor,
}: {
  basePath: string;
  params: SearchParams;
  keep?: Record<string, string>;
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
    for (const [key, value] of Object.entries(keep)) url.set(key, value);
    if (nextCursorValue) url.set('cursor', nextCursorValue);
    if (nextCursorValue && nextTrail.length > 0) url.set('trail', nextTrail.join(','));
    const qs = url.toString();
    return qs ? `${basePath}?${qs}` : basePath;
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

/** The page number and trail a URL carries: page 1 without a cursor. */
export function pagerPosition(params: SearchParams): {
  cursor: string | undefined;
  trail: string[];
  pageNumber: number;
} {
  const trail = (oneParam(params['trail']) ?? '').split(',').filter(Boolean);
  const cursor = oneParam(params['cursor']);
  return { cursor, trail, pageNumber: cursor ? trail.length + 2 : 1 };
}
