'use client';

import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/Button';

// CellLoadMore (MOTIR-11450) — a grouped board cell's own paging control, built to
// design MOTIR-11443 panel 4 (design-notes § *The cell*): an EXPLICIT button, not
// a scroll sentinel — cells sit side by side, so a sentinel would fire for every
// visible cell at once.
//
//   - `more`    — the design-system `Button` (`secondary`, `sm`, trailing
//                 `ChevronDown`), "Load more", named by its column and lane.
//   - `loading` — the same button in place, `loading` (its own spinner, disabled,
//                 `aria-busy`) so the cell's height holds and a second press cannot
//                 ask for the same page; a polite status carries "Loading…".
//   - `failed`  — the shipped retry grammar (`--el-link`, `text-xs`, underline on
//                 hover, the focus ring), its visible line the shipped retry and its
//                 accessible name that line followed by the cell.
//   - `none`    — nothing: the cell is complete.
//
// It renders no count of its own; the cell's badge is beside it.

export type CellControl = 'more' | 'loading' | 'failed' | 'none';

export function CellLoadMore({
  columnId,
  laneKey,
  columnName,
  laneLabel,
  control,
  onLoadMore,
  onRetry,
}: {
  columnId: string;
  laneKey: string;
  columnName: string;
  laneLabel: string;
  control: CellControl;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const t = useTranslations('boards');
  const names = { column: columnName, lane: laneLabel };
  const id = `${columnId}-${laneKey}`;
  if (control === 'none') return null;
  if (control === 'failed') {
    return (
      <button
        type="button"
        onClick={onRetry}
        aria-label={t('cellLoadRetryAria', names)}
        className="rounded-(--radius-control) px-(--spacing-control-x-6) text-xs font-medium text-(--el-link) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        data-testid={`cell-retry-${id}`}
      >
        {t('laneLoadRetry')}
      </button>
    );
  }
  const loading = control === 'loading';
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        loading={loading}
        rightIcon={<ChevronDown />}
        aria-label={t('cellLoadMoreAria', names)}
        onClick={onLoadMore}
        data-testid={`cell-load-more-${id}`}
      >
        {t('cellLoadMore')}
      </Button>
      {loading ? (
        <span role="status" className="sr-only" data-testid={`cell-loading-${id}`}>
          {t('laneLoading')}
        </span>
      ) : null}
    </>
  );
}
