'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SearchX, Settings2 } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';
import { buildBoardFilterHref } from '@/lib/boards/boardFilterHref';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// The board's FILTERED-EMPTY state (Story 6.15 · Subtask 6.15.3 · design
// board-filter.mock.html panel 4). When an active filter matches no card, the
// board shows THIS — a distinct `EmptyState` ("No work items match this filter"
// + a search-x glyph + a Clear filter CTA) — NOT the 3.2 brand-new-board empty
// state (which offers "New work item"): the board is not empty, the FILTER is
// over-narrow, so the action is to clear it, not create. The active toolbar +
// the applied-filter summary row stay visible (they're rendered by the page,
// outside BoardContainer), so the user can see and edit what they filtered on.
//
// Clear returns to the board with no filter (the `?board=` selection preserved),
// reusing the same board-scoped href builder the filter controls navigate
// through. When only the board's STORED filter narrows it (MOTIR-11335, design
// board--stored-filter.mock.html panel 8a) Clear would do nothing, so the state
// says so in its own copy and offers a board admin "Edit board filter" instead.

export function BoardFilteredEmptyState({
  selectedBoardId,
  toolbarFilterActive = true,
  editHref,
}: {
  selectedBoardId?: string;
  /** Whether the TOOLBAR filter is active (MOTIR-11335). `false` means only the
   * board's stored filter narrows it: Clear would change nothing, so the state
   * says the board filter leaves nothing and offers a board admin Edit instead. */
  toolbarFilterActive?: boolean;
  /** Board settings for this board — present only for a board admin. */
  editHref?: string;
}) {
  const routes = useReaderRoutes();
  const t = useTranslations('boards');
  const linkClass =
    'inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-btn) border border-(--el-border) px-(--spacing-control-x-12) font-sans text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';
  if (!toolbarFilterActive) {
    return (
      <EmptyState
        icon={<SearchX className="h-12 w-12" aria-hidden />}
        title={t('boardFilterEmptyTitle')}
        description={t('boardFilterEmptyDescription')}
        data-testid="board-filtered-empty"
        action={
          editHref ? (
            <Link href={editHref} className={linkClass}>
              <Settings2 className="size-4 text-(--el-text-secondary)" aria-hidden />
              {t('boardFilterEmptyEdit')}
            </Link>
          ) : undefined
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
