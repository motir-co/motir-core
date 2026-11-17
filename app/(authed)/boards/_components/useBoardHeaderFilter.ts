'use client';

import { useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import type { FilterAst } from '@/lib/filters/ast';
import type { LabelDto } from '@/lib/dto/labels';
import {
  boardFilterResetHref,
  buildBoardHeaderFilterHref,
  resolveBoardHeaderFilter,
  type BoardHeaderFilterState,
} from '@/lib/boards/boardHeaderFilter';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { useSavedFilterSession } from '../../items/_components/SavedFilterContext';
import { useBoardStoredFilter, type BoardStoredFilterRead } from './BoardHeaderFilterContext';

// The board's header filter as the toolbar controls and the applied bar render
// it (MOTIR-11565): the URL's filter resolved against the board's own stored
// filter (`resolveBoardHeaderFilter`), the board-scoped href every header
// change navigates through (which carries `?boardFilter=off` when a change
// leaves no condition on a board that has a stored filter), and Reset to board
// filter.

export interface BoardHeaderFilter extends BoardHeaderFilterState {
  read: BoardStoredFilterRead;
  buildHref: (next: IssueFilter) => string;
  /** The board with no filter params — the board filter itself. */
  resetHref: string;
  /** Navigate to the board filter, leaving any applied saved filter. */
  reset: () => void;
  /** The page's referenced labels plus the stored filter's own, so a seeded
   * Label condition names its values. */
  labels: LabelDto[];
}

export function useBoardHeaderFilter(input: {
  selectedBoardId?: string;
  filter: IssueFilter;
  ast: FilterAst | null;
  boardFilterOff: boolean;
  referencedLabels: LabelDto[];
}): BoardHeaderFilter {
  const { selectedBoardId, filter, ast, boardFilterOff, referencedLabels } = input;
  const routes = useReaderRoutes();
  const router = useRouter();
  const session = useSavedFilterSession();
  const read = useBoardStoredFilter(selectedBoardId);
  const state = useMemo(
    () =>
      resolveBoardHeaderFilter({ filter, ast, boardFilterOff, storedFilter: read.storedFilter }),
    [filter, ast, boardFilterOff, read.storedFilter],
  );
  const { hasStoredFilter } = state;
  const buildHref = useCallback(
    (next: IssueFilter) =>
      routes.view(
        buildBoardHeaderFilterHref({ boardId: selectedBoardId, filter: next, hasStoredFilter }),
      ),
    [routes, selectedBoardId, hasStoredFilter],
  );
  const resetHref = routes.view(boardFilterResetHref(selectedBoardId));
  const setApplied = session?.setApplied;
  const reset = useCallback(() => {
    setApplied?.(null);
    router.push(resetHref);
  }, [setApplied, router, resetHref]);
  const storedLabels = read.storedFilter?.labels;
  const labels = useMemo(() => {
    if (!storedLabels || storedLabels.length === 0) return referencedLabels;
    const seen = new Set(referencedLabels.map((l) => l.id));
    return [...referencedLabels, ...storedLabels.filter((l) => !seen.has(l.id))];
  }, [referencedLabels, storedLabels]);
  return { ...state, read, buildHref, resetHref, reset, labels };
}
