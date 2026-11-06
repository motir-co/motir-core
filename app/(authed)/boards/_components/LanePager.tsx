'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Spinner } from '@/components/ui/Spinner';

// The board's per-lane paging affordance (MOTIR-10535) — the scroll-to-load
// grammar of `design/boards/board.mock.html` panel 4 (3.2.8): NO "Load more"
// button. A sentinel at the bottom of the lane's scroll area asks for the next
// page when it scrolls into view; while a page is in flight a small in-flow
// `Spinner` + "Loading…" shows (`.load-spin`); a failed page leaves a minimal,
// FOCUSABLE inline retry (`.load-retry`) so it is recoverable without a reload
// and reachable by keyboard.

/** Where one lane's paging stands. `idle` with a cursor means more can load. */
export type LaneLoadState = 'idle' | 'loading' | 'error';

/**
 * Call `onVisible` whenever the sentinel is in view of `root` (the lane's own
 * scroll body; `null` = the viewport) while `enabled`. The observer is rebuilt
 * whenever `generation` changes — pass the lane's loaded-card count — because an
 * IntersectionObserver reports CHANGES only: a page that does not fill the lane
 * leaves the sentinel in view, and a fresh observer's first report is what asks
 * for the page after it.
 */
export function useLaneSentinel(
  sentinelRef: RefObject<HTMLElement | null>,
  rootRef: RefObject<HTMLElement | null> | null,
  enabled: boolean,
  generation: number,
  onVisible: () => void,
): void {
  // The latest callback, so a re-render with a new closure does not rebuild the
  // observer (a rebuild re-reports, which would ask for the same page twice).
  const callbackRef = useRef(onVisible);
  useEffect(() => {
    callbackRef.current = onVisible;
  }, [onVisible]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!enabled || !sentinel || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) callbackRef.current();
      },
      // A little ahead of the bottom, so the next page is usually in by the time
      // the user reaches it.
      { root: rootRef?.current ?? null, rootMargin: '0px 0px 200px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinelRef, rootRef, enabled, generation]);
}

/**
 * The lane's footer: the sentinel (always, while the lane has more), plus the
 * in-flight spinner or the failed-page retry. Renders nothing for a lane whose
 * every card is loaded.
 */
export function LaneLoadFooter({
  columnId,
  hasMore,
  state,
  sentinelRef,
  onRetry,
}: {
  columnId: string;
  hasMore: boolean;
  state: LaneLoadState;
  sentinelRef: RefObject<HTMLDivElement | null>;
  onRetry: () => void;
}) {
  const t = useTranslations('boards');
  if (!hasMore) return null;
  return (
    <div data-testid={`board-lane-footer-${columnId}`}>
      {state === 'loading' ? (
        <div
          role="status"
          className="flex items-center justify-center gap-1.5 pt-2 pb-0.5 text-xs text-(--el-text-secondary)"
          data-testid={`board-lane-loading-${columnId}`}
        >
          <Spinner size="sm" />
          {t('laneLoading')}
        </div>
      ) : state === 'error' ? (
        <div className="flex justify-center pt-2 pb-0.5">
          <button
            type="button"
            onClick={onRetry}
            className="rounded-(--radius-control) px-(--spacing-control-x-6) text-xs font-medium text-(--el-link) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            data-testid={`board-lane-retry-${columnId}`}
          >
            {t('laneLoadRetry')}
          </button>
        </div>
      ) : null}
      {/* The sentinel: 1px, invisible, the thing the observer watches. It stays
          mounted through a load so the observer rebuilt for the next generation
          has something to watch. */}
      <div
        ref={sentinelRef}
        aria-hidden
        className="h-px"
        data-testid={`board-lane-sentinel-${columnId}`}
      />
    </div>
  );
}

/**
 * The lane header's count badge: the FULL total once every card is loaded, and
 * "{loaded} of {total}" while the lane has a next page (MOTIR-10535 — the header
 * reads "10 of 2,830" as the lane pages in). It keys on `hasMore` (the lane's
 * cursor), not on `loaded < total`: an optimistic move can leave the two counts
 * a card apart on a lane that is in fact complete. The flat column and the
 * swimlane board's pinned header both render it, so the two layouts read the
 * same.
 */
export function LaneCountBadge({
  columnId,
  loaded,
  total,
  hasMore,
}: {
  columnId: string;
  loaded: number;
  total: number;
  hasMore: boolean;
}) {
  const t = useTranslations('boards');
  return (
    <span
      className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-(--radius-badge) bg-(--el-count-bg) px-(--spacing-chip-x) text-xs font-semibold whitespace-nowrap text-(--el-count-text)"
      data-testid={`board-count-${columnId}`}
    >
      {hasMore ? t('laneCountLoaded', { loaded, total }) : t('laneCount', { total })}
    </span>
  );
}
