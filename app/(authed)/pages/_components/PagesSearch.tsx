'use client';

import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Info, Search, X } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { usePageSearch } from '@/components/pages/search/usePageSearch';
import type { PageSearchState } from '@/components/pages/search/usePageSearch';
import { PageSearchResults } from './PageSearchResults';

// THE `/pages` SEARCH BOX (Story MOTIR-9491 · MOTIR-9638) — the Search box above
// the tree, drawn by `design/pages/pages--tree--search.mock.html`. Every state
// comes from `usePageSearch`; nothing here fetches.
//
// ── THE TREE IS HIDDEN, NEVER UNMOUNTED ────────────────────────────────────
// `children` is the tree's in-page <Suspense>. While a query is active it sits
// under the `hidden` attribute, so its expanded rows and loaded levels survive
// a search, and clearing the box shows the same instance again.
//
// ── THE LAST LIST STAYS ON SCREEN ──────────────────────────────────────────
// The hook's `loading` carries no mode or query, so the box keeps the last
// `results` it rendered (`kept`) and draws it under the Pending indicator until
// the newer answer lands — and under the Too-long hint, which leaves the list
// in place. It is dropped on idle, on no results and on an error.
//
// ── KEYBOARD (panel 10) ────────────────────────────────────────────────────
// ArrowDown from the box focuses the first hit; Up and Down move between hits;
// Up from the first hit, or Escape on a hit, returns to the box; Escape in the
// box clears it. Tab after the last hit reaches Load more by document order.

type Kept = Extract<PageSearchState, { kind: 'results' }> | null;

export interface PagesSearchProps {
  projectId: string;
  children: ReactNode;
  /** Test seam, passed through to `usePageSearch`. */
  fetchImpl?: typeof fetch;
  debounceMs?: number;
}

/** The live region's sentence for a settled state, or '' for none. */
function useAnnouncement(state: PageSearchState): string {
  const t = useTranslations('pages.search');
  if (state.kind !== 'results' && state.kind !== 'noResults') return '';
  const note =
    state.mode === 'full-text-only'
      ? t('mode.fullText')
      : state.mode === 'not-indexed'
        ? t('mode.notIndexed')
        : '';
  const head = state.kind === 'results' ? t('updated') : t('noResults', { query: state.query });
  return note ? `${head} ${note}` : head;
}

export function PagesSearch({ projectId, children, fetchImpl, debounceMs }: PagesSearchProps) {
  const t = useTranslations('pages.search');
  const { query, setQuery, clear, state, loadMore, retry } = usePageSearch({
    projectId,
    fetchImpl,
    debounceMs,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const hintId = useId();
  const [focused, setFocused] = useState(false);

  // The last list rendered, derived during render (never in an effect).
  const [kept, setKept] = useState<Kept>(null);
  const [seen, setSeen] = useState<PageSearchState>(state);
  if (seen !== state) {
    setSeen(state);
    if (state.kind === 'results') setKept(state);
    else if (state.kind !== 'loading' && state.kind !== 'tooLong') setKept(null);
  }

  const announcement = useAnnouncement(state);
  const blank = query.trim() === '';
  const showTree = state.kind === 'idle' || (state.kind === 'tooLong' && kept === null);

  const hits = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('a[data-page-hit]') ?? []);

  const onBoxKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      clear();
    } else if (event.key === 'ArrowDown') {
      const first = hits()[0];
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const links = hits();
    const at = links.indexOf(event.target as HTMLElement);
    if (at === -1) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      links[Math.min(at + 1, links.length - 1)]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (at === 0) inputRef.current?.focus();
      else links[at - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      inputRef.current?.focus();
    }
  };

  const onClear = () => {
    clear();
    inputRef.current?.focus();
  };

  const hint =
    state.kind === 'tooLong' ? (
      <p
        id={hintId}
        className="mt-2 flex items-center gap-2 text-[12.5px] text-(--el-text-secondary)"
      >
        <Info className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />
        {t('tooLong', { limit: state.limit ?? 200 })}
      </p>
    ) : focused && blank ? (
      <p
        id={hintId}
        className="mt-2 flex items-center gap-2 text-[12.5px] text-(--el-text-secondary)"
      >
        <Info className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />
        {t('emptyHint')}
      </p>
    ) : null;

  return (
    <div className="flex flex-col">
      <div role="search" aria-label={t('label')} className="w-full max-w-[520px]">
        <div className="relative flex h-(--height-input) items-center rounded-(--radius-input) border border-(--el-input-border) bg-(--el-page-bg) px-(--spacing-input-x) focus-within:ring-2 focus-within:ring-(--focus-ring-color)">
          <Search className="h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            aria-label={t('label')}
            aria-describedby={hint ? hintId : undefined}
            placeholder={t('placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onBoxKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="h-full min-w-0 flex-1 bg-transparent px-2 text-sm text-(--el-text) outline-none placeholder:text-(--el-text-secondary) [&::-webkit-search-cancel-button]:hidden"
          />
          {state.kind === 'loading' ? (
            <Spinner
              size="sm"
              aria-label={t('pending')}
              className="mr-1 text-(--el-text-secondary)"
            />
          ) : null}
          {query !== '' ? (
            <button
              type="button"
              aria-label={t('clear')}
              onClick={onClear}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-icon-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
        {hint}
      </div>
      <div aria-live="polite" className="sr-only" data-testid="page-search-live">
        {announcement}
      </div>
      {showTree ? null : (
        <PageSearchResults
          state={state.kind === 'tooLong' ? { kind: 'loading', query: '', previous: null } : state}
          kept={kept}
          listRef={listRef}
          onListKeyDown={onListKeyDown}
          onClear={onClear}
          onRetry={retry}
          onLoadMore={loadMore}
        />
      )}
      <div hidden={!showTree} className="mt-4" data-testid="page-search-tree">
        {children}
      </div>
    </div>
  );
}
