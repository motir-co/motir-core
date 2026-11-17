'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SearchX } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';
import { buildBoardFilterHref } from '@/lib/boards/boardFilterHref';
import { boardFilterResetHref } from '@/lib/boards/boardHeaderFilter';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { useSavedFilterSession } from '../../items/_components/SavedFilterContext';

// The board's FILTERED-EMPTY state (Story 6.15 · Subtask 6.15.3 · design
// board-filter.mock.html panel 4). When an active filter matches no card, the
// board shows THIS — a distinct `EmptyState` ("No work items match this filter"
// + a search-x glyph) — NOT the 3.2 brand-new-board empty state (which offers
// "New work item"): the board is not empty, the FILTER is over-narrow. The
// toolbar and the applied-filter row stay visible (they're rendered by the page,
// outside BoardContainer), so the reader can see and edit what they filtered on.
//
// Three variants (MOTIR-11565, design board--header-board-filter.mock.html
// panel 13):
// - `filter` — a board with no stored filter: Clear returns to the board with no
//   filter (the `?board=` selection preserved), as shipped;
// - `board`  — the board's OWN filter leaves nothing: nothing to clear, and the
//   copy says the filter is changed in the filter bar above;
// - `reset`  — a header filter that differs from the board filter leaves nothing:
//   Reset to board filter returns to it.

export type BoardFilteredEmptyVariant = 'filter' | 'board' | 'reset';

export function BoardFilteredEmptyState({
  selectedBoardId,
  variant = 'filter',
}: {
  selectedBoardId?: string;
  variant?: BoardFilteredEmptyVariant;
}) {
  const routes = useReaderRoutes();
  const session = useSavedFilterSession();
  const t = useTranslations('boards');
  const linkClass =
    'inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-btn) border border-(--el-border) px-(--spacing-control-x-12) font-sans text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';
  if (variant === 'board') {
    return (
      <EmptyState
        icon={<SearchX className="h-12 w-12" aria-hidden />}
        title={t('boardFilterEmptyTitle')}
        description={t('boardFilterEmptyDescription')}
        data-testid="board-filtered-empty"
      />
    );
  }
  if (variant === 'reset') {
    return (
      <EmptyState
        icon={<SearchX className="h-12 w-12" aria-hidden />}
        title={t('filteredEmptyTitle')}
        description={t('filteredEmptyDescriptionBoard')}
        data-testid="board-filtered-empty"
        action={
          <Link
            href={routes.view(boardFilterResetHref(selectedBoardId))}
            onClick={() => session?.setApplied(null)}
            className={linkClass}
          >
            {t('filteredEmptyReset')}
          </Link>
        }
      />
    );
  }
  return (
    <EmptyState
      icon={<SearchX className="h-12 w-12" aria-hidden />}
      title={t('filteredEmptyTitle')}
      description={t('filteredEmptyDescription')}
      data-testid="board-filtered-empty"
      action={
        <Link
          href={routes.view(
            buildBoardFilterHref({ boardId: selectedBoardId, filter: EMPTY_FILTER }),
          )}
          className={linkClass}
        >
          {t('filteredEmptyClear')}
        </Link>
      }
    />
  );
}
