'use client';

import type { KeyboardEvent, RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, ChevronDown, Info, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import type { PageSearchMode } from '@/lib/dto/pages';
import type { PageSearchState } from '@/components/pages/search/usePageSearch';
import { PageSearchHitRow } from './PageSearchHitRow';

// THE RESULT LIST (Story MOTIR-9491 · MOTIR-9638) — what replaces the tree body
// while a query is active, per `pages--tree--search.mock.html` panels 3–9. It
// draws from the hook's state and fetches nothing.
//
// The Degraded note is the app's own translated sentence, chosen by `mode`; the
// service's English `message` is never rendered. It is informational (the sky
// tint, an Info glyph), never the error tone. The Error state is the tree's own
// failed-read row, so a failed search looks like a failed tree read, and it
// shows no title, snippet or count.

type Shown = Extract<PageSearchState, { kind: 'results' | 'noResults' | 'error' | 'loading' }>;

export interface PageSearchResultsProps {
  state: Shown;
  /** The last list rendered, kept on screen while a newer query loads. */
  kept: Extract<PageSearchState, { kind: 'results' }> | null;
  listRef: RefObject<HTMLUListElement | null>;
  onListKeyDown: (event: KeyboardEvent<HTMLUListElement>) => void;
  onClear: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
}

const FRAME =
  'mt-3 overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-card)';

function DegradedNote({ mode }: { mode: PageSearchMode }) {
  const t = useTranslations('pages.search');
  if (mode === 'merged') return null;
  return (
    <p
      role="note"
      data-testid="page-search-degraded"
      className="mt-3 flex items-center gap-2 rounded-(--radius-control) bg-(--el-tint-sky) px-(--spacing-control-x-12) py-(--spacing-control-y) text-[13px] text-(--el-text-strong)"
    >
      <Info className="h-4 w-4 shrink-0" aria-hidden />
      {mode === 'full-text-only' ? t('mode.fullText') : t('mode.notIndexed')}
    </p>
  );
}

function Skeleton() {
  return (
    <ul className={FRAME} aria-hidden data-testid="page-search-skeleton">
      {[180, 140, 210].map((w) => (
        <li
          key={w}
          className="flex flex-col gap-1.5 border-(--el-border-soft) px-(--spacing-control-x-12) py-(--spacing-control-y-8) not-first:border-t"
        >
          <span className="h-3 rounded-(--radius-control) bg-(--el-muted)" style={{ width: w }} />
          <span className="h-2.5 w-[120px] rounded-(--radius-control) bg-(--el-muted)" />
          <span className="h-2.5 w-4/5 rounded-(--radius-control) bg-(--el-muted)" />
        </li>
      ))}
    </ul>
  );
}

function LoadMoreBand({
  state,
  onLoadMore,
}: {
  state: Extract<PageSearchState, { kind: 'results' }>;
  onLoadMore: () => void;
}) {
  const t = useTranslations();
  if (!state.hasMore) return null;
  const linkButton =
    'inline-flex items-center gap-1.5 rounded-(--radius-control) text-(--el-link) underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';
  return (
    <div
      data-testid="page-search-more"
      className="flex h-10 items-center gap-2 border-t border-(--el-border-soft) px-(--spacing-control-x-12) text-[13px] text-(--el-text-secondary)"
    >
      {state.loadingMore ? (
        <span role="status" className="inline-flex items-center gap-2">
          <Spinner size="sm" aria-hidden />
          {t('pages.search.loading')}
        </span>
      ) : state.loadMoreFailed ? (
        // A failed next page: the Error state's sentence, and Retry for the same page.
        <>
          <span role="alert" className="inline-flex flex-1 items-center gap-2 text-(--el-text)">
            <AlertCircle className="h-4 w-4 shrink-0 text-(--el-danger)" aria-hidden />
            {t('pages.search.failed')}
          </span>
          <Button variant="secondary" size="sm" onClick={onLoadMore}>
            {t('common.retry')}
          </Button>
        </>
      ) : (
        <button type="button" onClick={onLoadMore} className={linkButton}>
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          {t('pages.tree.loadMore')}
        </button>
      )}
    </div>
  );
}

export function PageSearchResults(props: PageSearchResultsProps) {
  const { state, kept, listRef, onListKeyDown, onClear, onRetry, onLoadMore } = props;
  const t = useTranslations('pages.search');
  const tc = useTranslations('common');
  if (state.kind === 'error') {
    return (
      <div className={FRAME} data-testid="page-search-failed">
        <div
          role="alert"
          className="flex items-center gap-2.5 px-(--spacing-card-padding) py-4 text-sm text-(--el-text)"
        >
          <AlertCircle className="h-4 w-4 shrink-0 text-(--el-danger)" aria-hidden />
          <span className="flex-1">{t('failed')}</span>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {tc('retry')}
          </Button>
        </div>
      </div>
    );
  }
  if (state.kind === 'noResults') {
    return (
      <>
        <DegradedNote mode={state.mode} />
        <div
          className={`${FRAME} px-(--spacing-card-padding) py-7 text-center`}
          data-testid="page-search-none"
        >
          <p className="m-0 text-sm text-(--el-text)">{t('noResults', { query: state.query })}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            leftIcon={<X className="h-3.5 w-3.5" />}
            onClick={onClear}
          >
            {t('clear')}
          </Button>
        </div>
      </>
    );
  }
  const list = state.kind === 'results' ? state : kept;
  if (list === null) return <Skeleton />;
  return (
    <>
      <DegradedNote mode={list.mode} />
      <div className={FRAME}>
        <ul
          ref={listRef}
          aria-label={t('results')}
          onKeyDown={onListKeyDown}
          className="m-0 list-none p-0"
        >
          {list.items.map((hit) => (
            <PageSearchHitRow key={hit.id} hit={hit} query={list.query} />
          ))}
        </ul>
        {state.kind === 'results' ? <LoadMoreBand state={state} onLoadMore={onLoadMore} /> : null}
      </div>
    </>
  );
}
