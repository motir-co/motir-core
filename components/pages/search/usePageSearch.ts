'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageSearchHitDto, PageSearchMode, PageSearchResultDto } from '@/lib/dto/pages';
import { PageSearchRequestError, searchPages } from './pageSearchClient';

// THE `/pages` SEARCH BOX'S STATE (Story MOTIR-9491 · MOTIR-9637) — one query
// in, one settled state out, so the box draws from `state.kind` and fetches
// nothing itself. `design/pages/pages--tree--search.mock.html` is what draws it.
//
// ── ORDERING ───────────────────────────────────────────────────────────────
// Answers can arrive late or out of order: a debounced query replaced while in
// flight, a Load more that returns after the query changed, a cursor the
// service rejects. Every request takes the next number of `seq` and its own
// AbortController; a new request, a clear or an unmount aborts the previous one,
// and any answer whose number is not the latest is dropped. An `AbortError` is
// never the error state.
//
// ── NO RULE OF ITS OWN ─────────────────────────────────────────────────────
// The hook sends the trimmed query and never checks its length: a too-long
// query is the service's 422, carried here as `tooLong` with the service's
// `limit`. A degraded `mode` is data on `results` / `noResults`, never an error.

export type PageSearchState =
  | { kind: 'idle' }
  /** A first page in flight; `previous` keeps the last hits on screen until it lands. */
  | { kind: 'loading'; query: string; previous: PageSearchHitDto[] | null }
  | {
      kind: 'results';
      query: string;
      items: PageSearchHitDto[];
      mode: PageSearchMode;
      message: string | null;
      hasMore: boolean;
      loadingMore: boolean;
      loadMoreFailed: boolean;
    }
  | { kind: 'noResults'; query: string; mode: PageSearchMode; message: string | null }
  | { kind: 'tooLong'; limit: number | null }
  | { kind: 'error'; code: string; status: number };

type ResultsState = Extract<PageSearchState, { kind: 'results' }>;

export interface UsePageSearchOptions {
  projectId: string;
  fetchImpl?: typeof fetch;
  /** How long the input must be still before it is searched. */
  debounceMs?: number;
}

const IDLE: PageSearchState = { kind: 'idle' };
const TOO_LONG = 'PAGE_SEARCH_QUERY_TOO_LONG';
const CURSOR_INVALID = 'PAGE_CURSOR_INVALID';

/** The state a first page's answer settles into. */
export function toFirstPageState(query: string, page: PageSearchResultDto): PageSearchState {
  if (page.items.length === 0) {
    return { kind: 'noResults', query, mode: page.mode, message: page.message };
  }
  return {
    kind: 'results',
    query,
    items: page.items,
    mode: page.mode,
    message: page.message,
    hasMore: page.nextCursor !== null,
    loadingMore: false,
    loadMoreFailed: false,
  };
}

/** The listed hits with the next page appended, never listing an id twice. */
export function appendPage(current: ResultsState, page: PageSearchResultDto): ResultsState {
  const listed = new Set(current.items.map((hit) => hit.id));
  const fresh = page.items.filter((hit) => !listed.has(hit.id));
  return {
    ...current,
    items: [...current.items, ...fresh],
    hasMore: page.nextCursor !== null,
    loadingMore: false,
    loadMoreFailed: false,
  };
}

/** A failed first page: the service's too-long refusal, or an error. */
function toFailureState(err: unknown): PageSearchState {
  if (err instanceof PageSearchRequestError) {
    if (err.code === TOO_LONG) return { kind: 'tooLong', limit: err.limit ?? null };
    return { kind: 'error', code: err.code, status: err.status };
  }
  return { kind: 'error', code: 'NETWORK', status: 0 };
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === 'AbortError');
}

export function usePageSearch({ projectId, fetchImpl, debounceMs = 250 }: UsePageSearchOptions) {
  const [query, setQueryState] = useState('');
  const [state, setState] = useState<PageSearchState>(IDLE);
  const stateRef = useRef<PageSearchState>(IDLE);
  const seq = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const cursor = useRef<string | null>(null);
  const settled = useRef('');
  const busy = useRef(false);
  const request = useRef({ projectId, fetchImpl });
  useEffect(() => {
    request.current = { projectId, fetchImpl };
  }, [projectId, fetchImpl]);

  const commit = useCallback((next: PageSearchState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  /** Abort whatever is in flight and claim the next sequence number. */
  const begin = useCallback(() => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    seq.current += 1;
    busy.current = true;
    return { id: seq.current, signal: next.signal };
  }, []);

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    seq.current += 1;
    busy.current = false;
  }, []);

  const send = useCallback((q: string, from: string | null, signal: AbortSignal) => {
    const { projectId: id, fetchImpl: impl } = request.current;
    return searchPages(id, q, from, { fetchImpl: impl, signal });
  }, []);

  const fetchFirst = useCallback(
    (q: string) => {
      const { id, signal } = begin();
      const current = stateRef.current;
      cursor.current = null;
      commit({
        kind: 'loading',
        query: q,
        previous: current.kind === 'results' ? current.items : null,
      });
      send(q, null, signal).then(
        (page) => {
          if (id !== seq.current) return;
          busy.current = false;
          cursor.current = page.nextCursor;
          commit(toFirstPageState(q, page));
        },
        (err: unknown) => {
          if (id !== seq.current || isAbort(err, signal)) return;
          busy.current = false;
          commit(toFailureState(err));
        },
      );
    },
    [begin, commit, send],
  );

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (busy.current || current.kind !== 'results' || !current.hasMore) return;
    const q = settled.current;
    const { id, signal } = begin();
    commit({ ...current, loadingMore: true, loadMoreFailed: false });
    send(q, cursor.current, signal).then(
      (page) => {
        const now = stateRef.current;
        if (id !== seq.current || now.kind !== 'results') return;
        busy.current = false;
        cursor.current = page.nextCursor;
        commit(appendPage(now, page));
      },
      (err: unknown) => {
        const now = stateRef.current;
        if (id !== seq.current || isAbort(err, signal) || now.kind !== 'results') return;
        busy.current = false;
        // A cursor the service no longer honours restarts the search: the first
        // page is read again and REPLACES the list rather than doubling it.
        if (err instanceof PageSearchRequestError && err.code === CURSOR_INVALID) fetchFirst(q);
        else commit({ ...now, loadingMore: false, loadMoreFailed: true });
      },
    );
  }, [begin, commit, send, fetchFirst]);

  // A blank query never searches: it cancels what is in flight at once and
  // goes idle, which is what brings the tree back.
  const setQuery = useCallback(
    (next: string) => {
      setQueryState(next);
      if (next.trim() !== '') return;
      cancel();
      settled.current = '';
      commit(IDLE);
    },
    [cancel, commit],
  );

  // The settled query: searched once the input has been still for `debounceMs`.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === '') return;
    if (trimmed === settled.current && stateRef.current.kind !== 'idle') return;
    const timer = setTimeout(() => {
      settled.current = trimmed;
      fetchFirst(trimmed);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [query, debounceMs, fetchFirst]);

  useEffect(() => cancel, [cancel]);

  const retry = useCallback(() => {
    if (settled.current !== '') fetchFirst(settled.current);
  }, [fetchFirst]);

  const clear = useCallback(() => setQuery(''), [setQuery]);

  return { query, setQuery, clear, state, loadMore, retry };
}
