// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PageSearchHitDto, PageSearchResultDto } from '@/lib/dto/pages';
import { usePageSearch } from '@/components/pages/search/usePageSearch';

// `usePageSearch` (Story MOTIR-9491 · MOTIR-9637) — the ordering of answers that
// arrive late or out of order: the debounce, aborts, stale first pages, stale
// Load mores and the rejected-cursor restart. The network is an injected
// `fetchImpl` whose answers the test releases by hand; nothing is mocked.

const DEBOUNCE = 200;

interface Call {
  url: URL;
  signal: AbortSignal;
  aborted: boolean;
  answer: (status: number, body: unknown) => void;
  fail: (err: unknown) => void;
}

/** A fetch whose every call waits until the test answers it. */
function controllableFetch() {
  const calls: Call[] = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init!.signal!;
    return new Promise<Response>((resolve, reject) => {
      const call: Call = {
        url: new URL(String(input), 'http://localhost'),
        signal,
        aborted: false,
        answer: (status, body) =>
          resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json' },
            }),
          ),
        fail: reject,
      };
      signal.addEventListener('abort', () => {
        call.aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
      calls.push(call);
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const hit = (id: string): PageSearchHitDto => ({
  id,
  title: `Page ${id}`,
  place: { folderPath: [], parentPageTitle: null },
  snippet: `about ${id}`,
  rank: 1,
});

function page(
  ids: string[],
  nextCursor: string | null = null,
  mode: PageSearchResultDto['mode'] = 'merged',
): PageSearchResultDto {
  return {
    items: ids.map(hit),
    nextCursor,
    mode,
    message: mode === 'merged' ? null : 'Meaning search did not run.',
  };
}

function mount() {
  const net = controllableFetch();
  const view = renderHook(() =>
    usePageSearch({ projectId: 'proj_1', fetchImpl: net.fetchImpl, debounceMs: DEBOUNCE }),
  );
  return { ...net, view };
}

/** Type a query and let it settle. */
async function settle(view: ReturnType<typeof mount>['view'], q: string) {
  act(() => view.result.current.setQuery(q));
  await act(async () => {
    vi.advanceTimersByTime(DEBOUNCE);
  });
}

async function answer(call: Call, status: number, body: unknown) {
  await act(async () => {
    call.answer(status, body);
  });
}

const ids = (state: ReturnType<typeof mount>['view']['result']['current']['state']) =>
  state.kind === 'results' ? state.items.map((h) => h.id) : null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the client function', () => {
  it('is the only file under components/ or app/ naming /api/pages/search', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !p.includes(join('app', 'api'))) {
          if (readFileSync(p, 'utf8').includes('/api/pages/search')) hits.push(p);
        }
      }
    };
    walk('components');
    walk('app');
    expect(hits).toEqual([join('components', 'pages', 'search', 'pageSearchClient.ts')]);
  });
});

describe('the settled query', () => {
  it('sends ONE request, for the last text, once the input is still', async () => {
    const { calls, view } = mount();
    act(() => view.result.current.setQuery('z'));
    act(() => vi.advanceTimersByTime(DEBOUNCE - 50));
    act(() => view.result.current.setQuery('ze'));
    act(() => vi.advanceTimersByTime(DEBOUNCE - 50));
    act(() => view.result.current.setQuery('zephyr'));
    expect(view.result.current.query).toBe('zephyr');
    act(() => vi.advanceTimersByTime(DEBOUNCE - 1));
    expect(calls).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe('/api/pages/search');
    expect(calls[0]!.url.searchParams.get('q')).toBe('zephyr');
    expect(calls[0]!.url.searchParams.get('projectId')).toBe('proj_1');
    expect(calls[0]!.url.searchParams.has('cursor')).toBe(false);
    expect(view.result.current.state).toEqual({ kind: 'loading', query: 'zephyr', previous: null });
  });

  it('sends the trimmed text', async () => {
    const { calls, view } = mount();
    await settle(view, '  zephyr  ');
    expect(calls[0]!.url.searchParams.get('q')).toBe('zephyr');
  });

  it('never sends an empty or whitespace query, and stays idle', async () => {
    const { calls, view } = mount();
    await settle(view, '   ');
    await settle(view, '');
    expect(calls).toHaveLength(0);
    expect(view.result.current.state).toEqual({ kind: 'idle' });
  });

  it('clear() aborts the request in flight and its late answer changes nothing', async () => {
    const { calls, view } = mount();
    await settle(view, 'zephyr');
    act(() => view.result.current.clear());
    expect(view.result.current.query).toBe('');
    expect(calls[0]!.aborted).toBe(true);
    expect(view.result.current.state).toEqual({ kind: 'idle' });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE * 2);
    });
    expect(calls).toHaveLength(1);
    expect(view.result.current.state).toEqual({ kind: 'idle' });
  });

  it("shows beta's hits when alpha's answer lands after beta's, and alpha was aborted", async () => {
    const { calls, view } = mount();
    await settle(view, 'alpha');
    await settle(view, 'beta');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.aborted).toBe(true);
    await answer(calls[1]!, 200, page(['b1']));
    // A late alpha answer (the abort already rejected it) cannot land.
    await act(async () => {
      calls[0]!.answer(200, page(['a1']));
    });
    expect(ids(view.result.current.state)).toEqual(['b1']);
    expect(view.result.current.state.kind).not.toBe('error');
  });

  it('keeps the previous hits visible while a refined query loads', async () => {
    const { calls, view } = mount();
    await settle(view, 'zephyr');
    await answer(calls[0]!, 200, page(['p1']));
    await settle(view, 'zephyr launch');
    expect(view.result.current.state).toMatchObject({ kind: 'loading', query: 'zephyr launch' });
    const s = view.result.current.state;
    expect(s.kind === 'loading' && s.previous?.map((h) => h.id)).toEqual(['p1']);
  });
});

describe('the first page', () => {
  it('a 200 with hits gives results, with hasMore read from nextCursor', async () => {
    const { calls, view } = mount();
    await settle(view, 'zephyr');
    await answer(calls[0]!, 200, page(['p1', 'p2'], 'c1'));
    expect(view.result.current.state).toEqual({
      kind: 'results',
      query: 'zephyr',
      items: [hit('p1'), hit('p2')],
      mode: 'merged',
      message: null,
      hasMore: true,
      loadingMore: false,
      loadMoreFailed: false,
    });
  });

  it('a 200 with no hits gives noResults carrying the trimmed query', async () => {
    const { calls, view } = mount();
    await settle(view, ' quarterly forecast ');
    await answer(calls[0]!, 200, page([]));
    expect(view.result.current.state).toEqual({
      kind: 'noResults',
      query: 'quarterly forecast',
      mode: 'merged',
      message: null,
    });
  });

  it('carries a degraded mode and its message as data, never as an error', async () => {
    const { calls, view } = mount();
    await settle(view, 'zephyr');
    await answer(calls[0]!, 200, page(['p1'], null, 'full-text-only'));
    expect(view.result.current.state).toMatchObject({
      kind: 'results',
      mode: 'full-text-only',
      message: 'Meaning search did not run.',
      hasMore: false,
    });
    await settle(view, 'nothing');
    await answer(calls[1]!, 200, page([], null, 'not-indexed'));
    expect(view.result.current.state).toMatchObject({
      kind: 'noResults',
      mode: 'not-indexed',
      message: 'Meaning search did not run.',
    });
  });

  it('sends a 201-character query and reads the 422 as tooLong with the limit', async () => {
    const { calls, view } = mount();
    const long = 'z'.repeat(201);
    await settle(view, long);
    expect(calls[0]!.url.searchParams.get('q')).toBe(long);
    await answer(calls[0]!, 422, {
      code: 'PAGE_SEARCH_QUERY_TOO_LONG',
      error: 'Too long',
      limit: 200,
    });
    expect(view.result.current.state).toEqual({ kind: 'tooLong', limit: 200 });
  });

  it.each([
    [500, { code: 'INTERNAL', error: 'boom' }, 'INTERNAL'],
    [404, { code: 'PAGE_NOT_FOUND', error: 'Page not found.' }, 'PAGE_NOT_FOUND'],
    [403, { code: 'PROJECT_ACCESS_DENIED', error: 'No.' }, 'PROJECT_ACCESS_DENIED'],
  ])(
    'a %i gives error with its status and code, and retry() recovers',
    async (status, body, code) => {
      const { calls, view } = mount();
      await settle(view, 'zephyr');
      await answer(calls[0]!, status, body);
      expect(view.result.current.state).toEqual({ kind: 'error', code, status });
      act(() => view.result.current.retry());
      expect(calls).toHaveLength(2);
      expect(calls[1]!.url.searchParams.get('q')).toBe('zephyr');
      await answer(calls[1]!, 200, page(['p1']));
      expect(view.result.current.state.kind).toBe('results');
    },
  );

  it('a body that is not JSON reads as UNKNOWN', async () => {
    const { calls, view } = mount();
    await settle(view, 'zephyr');
    // `JSON.stringify(undefined)` is no body at all.
    await answer(calls[0]!, 502, undefined);
    expect(view.result.current.state).toEqual({ kind: 'error', code: 'UNKNOWN', status: 502 });
  });

  it('a network failure gives error, and retry() re-sends', async () => {
    const { calls, view } = mount();
    await settle(view, 'zephyr');
    await act(async () => {
      calls[0]!.fail(new TypeError('Failed to fetch'));
    });
    expect(view.result.current.state).toEqual({ kind: 'error', code: 'NETWORK', status: 0 });
    act(() => view.result.current.retry());
    await answer(calls[1]!, 200, page(['p1']));
    expect(ids(view.result.current.state)).toEqual(['p1']);
  });
});

describe('load more', () => {
  async function withFirstPage(ids: string[], cursor: string | null) {
    const m = mount();
    await settle(m.view, 'zephyr');
    await answer(m.calls[0]!, 200, page(ids, cursor));
    return m;
  }

  it('sends the cursor with the query, appends, and never lists an id twice', async () => {
    const { calls, view } = await withFirstPage(['p1', 'p2'], 'c1');
    act(() => view.result.current.loadMore());
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('c1');
    expect(calls[1]!.url.searchParams.get('q')).toBe('zephyr');
    expect(view.result.current.state).toMatchObject({ kind: 'results', loadingMore: true });
    await answer(calls[1]!, 200, page(['p2', 'p3'], null));
    expect(ids(view.result.current.state)).toEqual(['p1', 'p2', 'p3']);
    expect(view.result.current.state).toMatchObject({ hasMore: false, loadingMore: false });
  });

  it('sends nothing while a first page or another load more is in flight, or with no next page', async () => {
    const { calls, view } = mount();
    await settle(view, 'zephyr');
    act(() => view.result.current.loadMore());
    expect(calls).toHaveLength(1);
    await answer(calls[0]!, 200, page(['p1'], 'c1'));
    act(() => view.result.current.loadMore());
    act(() => view.result.current.loadMore());
    expect(calls).toHaveLength(2);
    await answer(calls[1]!, 200, page(['p2'], null));
    act(() => view.result.current.loadMore());
    expect(calls).toHaveLength(2);
  });

  it('drops a load-more answer that lands after the query changed', async () => {
    const { calls, view } = await withFirstPage(['p1'], 'c1');
    act(() => view.result.current.loadMore());
    await settle(view, 'beta');
    expect(calls[1]!.aborted).toBe(true);
    await answer(calls[2]!, 200, page(['b1']));
    await act(async () => {
      calls[1]!.answer(200, page(['p2']));
    });
    expect(ids(view.result.current.state)).toEqual(['b1']);
  });

  it('restarts on PAGE_CURSOR_INVALID: the first page again, replacing the list', async () => {
    const { calls, view } = await withFirstPage(['p1', 'p2'], 'c1');
    act(() => view.result.current.loadMore());
    await answer(calls[1]!, 400, { code: 'PAGE_CURSOR_INVALID', error: 'Bad cursor.' });
    expect(calls).toHaveLength(3);
    expect(calls[2]!.url.searchParams.has('cursor')).toBe(false);
    expect(calls[2]!.url.searchParams.get('q')).toBe('zephyr');
    await answer(calls[2]!, 200, page(['n1', 'n2'], null));
    expect(ids(view.result.current.state)).toEqual(['n1', 'n2']);
  });

  it('keeps the hits on any other failure, and the next loadMore() retries the same cursor', async () => {
    const { calls, view } = await withFirstPage(['p1'], 'c1');
    act(() => view.result.current.loadMore());
    await answer(calls[1]!, 500, { code: 'INTERNAL', error: 'boom' });
    expect(view.result.current.state).toMatchObject({
      kind: 'results',
      loadingMore: false,
      loadMoreFailed: true,
    });
    expect(ids(view.result.current.state)).toEqual(['p1']);
    act(() => view.result.current.loadMore());
    expect(calls[2]!.url.searchParams.get('cursor')).toBe('c1');
    await answer(calls[2]!, 200, page(['p2'], null));
    expect(ids(view.result.current.state)).toEqual(['p1', 'p2']);
    expect(view.result.current.state).toMatchObject({ loadMoreFailed: false });
  });
});

describe('unmount', () => {
  it('aborts the request in flight, and no update follows', async () => {
    const { calls, view } = mount();
    await settle(view, 'zephyr');
    const before = view.result.current.state;
    view.unmount();
    expect(calls[0]!.aborted).toBe(true);
    await act(async () => {
      calls[0]!.answer(200, page(['p1']));
    });
    expect(view.result.current.state).toBe(before);
  });
});
