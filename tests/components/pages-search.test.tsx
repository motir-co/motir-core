// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { renderWithIntl } from '@/tests/helpers/renderWithIntl';
import type { PageSearchHitDto, PageSearchResultDto } from '@/lib/dto/pages';
import { PagesSearch } from '@/app/(authed)/pages/_components/PagesSearch';
import { emphasise } from '@/app/(authed)/pages/_components/snippetEmphasis';

// The `/pages` Search box and result list (Story MOTIR-9491 · MOTIR-9638), per
// design/pages/pages--tree--search.mock.html. Everything runs through the real
// `usePageSearch` over an injected fetch whose answers the test releases by
// hand; no module is mocked.

interface Call {
  url: URL;
  answer: (status: number, body: unknown) => void;
  fail: (err: unknown) => void;
}

function heldFetch() {
  const calls: Call[] = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init!.signal!;
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      calls.push({
        url: new URL(String(input), 'http://localhost'),
        answer: (status, body) =>
          resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json' },
            }),
          ),
        fail: reject,
      });
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const hit = (id: string, over: Partial<PageSearchHitDto> = {}): PageSearchHitDto => ({
  id,
  title: `Page ${id}`,
  place: { folderPath: [], parentPageTitle: null },
  snippet: `about ${id}`,
  rank: 1,
  ...over,
});

const result = (
  items: PageSearchHitDto[],
  nextCursor: string | null = null,
  mode: PageSearchResultDto['mode'] = 'merged',
): PageSearchResultDto => ({
  items,
  nextCursor,
  mode,
  message: mode === 'merged' ? null : 'Meaning search did not run (English, server-side).',
});

function mount() {
  const net = heldFetch();
  renderWithIntl(
    <PagesSearch projectId="proj_1" fetchImpl={net.fetchImpl} debounceMs={0}>
      <div data-testid="tree">the tree</div>
    </PagesSearch>,
  );
  const input = screen.getByRole('searchbox', { name: 'Search pages' }) as HTMLInputElement;
  const tree = screen.getByTestId('tree');
  return { ...net, input, tree };
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

async function nth(calls: Call[], n: number) {
  await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(n));
  await act(async () => {});
  return calls[n - 1]!;
}

async function answer(call: Call, status: number, body: unknown) {
  await act(async () => {
    call.answer(status, body);
  });
}

const treeShown = (tree: HTMLElement) => !tree.parentElement!.hidden;
const hitLinks = () => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-page-hit]'));

afterEach(() => {
  cleanup();
});

describe('emphasise', () => {
  it('marks each query word at a word start, case-insensitively, and nothing else', () => {
    const segs = emphasise('Zephyr rota; the azephyr ROTA zeph', 'zeph rota');
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual([
      'Zeph',
      'rota',
      'ROTA',
      'zeph',
    ]);
    expect(segs.map((s) => s.text).join('')).toBe('Zephyr rota; the azephyr ROTA zeph');
  });

  it('treats RegExp characters in a query word literally', () => {
    expect(() => emphasise('learn c++ today', 'c++ (a')).not.toThrow();
    expect(emphasise('learn c++ today', 'c++').filter((s) => s.match)).toEqual([
      { text: 'c++', match: true },
    ]);
    expect(emphasise('abc', '.*').some((s) => s.match)).toBe(false);
  });

  it('returns nothing for an empty snippet', () => {
    expect(emphasise('', 'x')).toEqual([]);
  });
});

describe('PagesSearch', () => {
  it('renders the box in a search region above the tree, and an empty or blank query sends nothing', async () => {
    const { calls, input, tree } = mount();
    expect(screen.getByRole('search', { name: 'Search pages' })).toBeTruthy();
    expect(input.placeholder).toBe('Search pages by a word or by meaning');
    await act(async () => {
      fireEvent.focus(input);
    });
    expect(
      screen.getByText('Type a word or a phrase to search titles and page text.'),
    ).toBeTruthy();
    await type(input, '   ');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(calls).toHaveLength(0);
    expect(treeShown(tree)).toBe(true);
  });

  it('draws a body-word hit with its link, place and emphasised snippet, then clear restores the same tree', async () => {
    const { calls, input, tree } = mount();
    await type(input, 'zephyr');
    const call = await nth(calls, 1);
    expect(call.url.searchParams.get('q')).toBe('zephyr');
    expect(call.url.searchParams.get('projectId')).toBe('proj_1');
    await answer(
      call,
      200,
      result([
        hit('p1', {
          title: 'Release plan',
          snippet: 'The Zephyr launch moves to May',
          place: { folderPath: ['Ops'], parentPageTitle: 'Roadmap' },
        }),
        hit('p2', { title: '', snippet: '' }),
      ]),
    );
    expect(treeShown(tree)).toBe(false);
    const links = hitLinks();
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute('href')).toBe('/pages/p1');
    expect(screen.getByRole('link', { name: 'Release plan' })).toBe(links[0]);
    const row = links[0]!;
    expect(within(row).getByText('Ops')).toBeTruthy();
    expect(within(row).getByText('Roadmap')).toBeTruthy();
    const marks = row.querySelectorAll('mark');
    expect(Array.from(marks).map((m) => m.textContent)).toEqual(['Zephyr']);
    // An untitled page reads the untitled string; an empty snippet draws no line.
    expect(within(links[1]!).getByText('Untitled')).toBeTruthy();
    expect(within(links[1]!).queryByTestId('page-hit-snippet')).toBeNull();
    expect(screen.queryByText(/Load more/)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    });
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(treeShown(tree)).toBe(true);
    expect(screen.getByTestId('tree')).toBe(tree);
    expect(calls).toHaveLength(1);
  });

  it('keeps the previous hits while a newer query loads, with the Pending indicator', async () => {
    const { calls, input } = mount();
    await type(input, 'alpha');
    const first = await nth(calls, 1);
    expect(screen.getByRole('status', { name: 'Searching…' })).toBeTruthy();
    expect(screen.getByTestId('page-search-skeleton')).toBeTruthy();
    await answer(first, 200, result([hit('a1')]));
    expect(screen.queryByRole('status', { name: 'Searching…' })).toBeNull();
    await type(input, 'beta');
    await nth(calls, 2);
    expect(screen.getByRole('status', { name: 'Searching…' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Page a1' })).toBeTruthy();
    await answer(calls[1]!, 200, result([hit('b1')]));
    expect(screen.queryByRole('link', { name: 'Page a1' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Page b1' })).toBeTruthy();
  });

  it('names the query when nothing matches, and its Clear brings the tree back', async () => {
    const { calls, input, tree } = mount();
    await type(input, 'nothing here');
    await answer(await nth(calls, 1), 200, result([]));
    const none = screen.getByTestId('page-search-none');
    expect(within(none).getByText('No pages match “nothing here”.')).toBeTruthy();
    expect(screen.queryByTestId('page-search-failed')).toBeNull();
    expect(screen.queryByTestId('page-search-degraded')).toBeNull();
    await act(async () => {
      fireEvent.click(within(none).getByRole('button', { name: 'Clear search' }));
    });
    expect(input.value).toBe('');
    expect(treeShown(tree)).toBe(true);
  });

  it.each([
    ['full-text-only', 'Showing word matches only — meaning search didn’t run this time.'],
    ['not-indexed', 'Showing word matches only — pages aren’t indexed for meaning search yet.'],
  ] as const)(
    'draws the %s note on results and on no results, never the server message',
    async (mode, text) => {
      const { calls, input } = mount();
      await type(input, 'one');
      await answer(await nth(calls, 1), 200, result([hit('x')], null, mode));
      const note = screen.getByTestId('page-search-degraded');
      expect(note.textContent).toBe(text);
      expect(note.className).not.toMatch(/danger/);
      expect(screen.queryByText(/English, server-side/)).toBeNull();
      await type(input, 'two');
      await answer(await nth(calls, 2), 200, result([], null, mode));
      expect(screen.getByTestId('page-search-degraded').textContent).toBe(text);
      expect(
        within(screen.getByTestId('page-search-none')).getByText('No pages match “two”.'),
      ).toBeTruthy();
    },
  );

  it('draws no note on a merged answer', async () => {
    const { calls, input } = mount();
    await type(input, 'one');
    await answer(await nth(calls, 1), 200, result([hit('x')]));
    expect(screen.queryByTestId('page-search-degraded')).toBeNull();
  });

  it('shows the Too-long hint under the box, keeping the text and the list, with no error or Retry', async () => {
    const { calls, input } = mount();
    await type(input, 'ok');
    await answer(await nth(calls, 1), 200, result([hit('k1')]));
    const long = 'x'.repeat(201);
    await type(input, long);
    await answer(await nth(calls, 2), 422, {
      code: 'PAGE_SEARCH_QUERY_TOO_LONG',
      status: 422,
      limit: 200,
    });
    expect(
      screen.getByText('Searches are limited to 200 characters — shorten it to search.'),
    ).toBeTruthy();
    expect(input.value).toBe(long);
    expect(screen.getByRole('link', { name: 'Page k1' })).toBeTruthy();
    expect(screen.queryByTestId('page-search-failed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it.each([500, 403, 404])(
    'draws the Error state for a %s, and Retry sends the same query again',
    async (status) => {
      const { calls, input } = mount();
      await type(input, 'roadmap');
      await answer(await nth(calls, 1), status, { code: 'SOMETHING', status });
      const failed = screen.getByTestId('page-search-failed');
      expect(within(failed).getByText('Couldn’t search the pages.')).toBeTruthy();
      expect(hitLinks()).toHaveLength(0);
      await act(async () => {
        fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }));
      });
      const again = await nth(calls, 2);
      expect(again.url.searchParams.get('q')).toBe('roadmap');
      await answer(again, 200, result([hit('r1')]));
      expect(screen.getByRole('link', { name: 'Page r1' })).toBeTruthy();
    },
  );

  it('draws a network failure as the Error state', async () => {
    const { calls, input } = mount();
    await type(input, 'net');
    const call = await nth(calls, 1);
    await act(async () => {
      call.fail(new TypeError('Failed to fetch'));
    });
    expect(screen.getByTestId('page-search-failed')).toBeTruthy();
  });

  it('loads more with the cursor, appending without repeats, and retries a failed page', async () => {
    const { calls, input } = mount();
    await type(input, 'many');
    await answer(await nth(calls, 1), 200, result([hit('m1'), hit('m2')], 'c1'));
    const more = screen.getByRole('button', { name: 'Load more' });
    await act(async () => {
      fireEvent.click(more);
    });
    const second = await nth(calls, 2);
    expect(second.url.searchParams.get('cursor')).toBe('c1');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(within(screen.getByTestId('page-search-more')).getByText('Loading…')).toBeTruthy();
    await answer(second, 500, { code: 'BOOM', status: 500 });
    expect(hitLinks()).toHaveLength(2);
    const band = screen.getByTestId('page-search-more');
    expect(within(band).getByText('Couldn’t search the pages.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(band).getByRole('button', { name: 'Try again' }));
    });
    const third = await nth(calls, 3);
    expect(third.url.searchParams.get('cursor')).toBe('c1');
    await answer(third, 200, result([hit('m2'), hit('m3')]));
    expect(hitLinks().map((a) => a.getAttribute('href'))).toEqual([
      '/pages/m1',
      '/pages/m2',
      '/pages/m3',
    ]);
    expect(screen.queryByTestId('page-search-more')).toBeNull();
  });

  it('moves focus box → hits → box with the arrow keys, and Escape clears the box', async () => {
    const { calls, input, tree } = mount();
    await type(input, 'keys');
    await answer(await nth(calls, 1), 200, result([hit('k1'), hit('k2')], 'c'));
    const [first, second] = hitLinks();
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(input);
    // Load more follows the last hit in document order, so Tab reaches it.
    const more = screen.getByRole('button', { name: 'Load more' });
    expect(second!.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.keyDown(first!, { key: 'Escape' });
    expect(document.activeElement).toBe(input);
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(treeShown(tree)).toBe(true);
  });

  it('announces settled results politely', async () => {
    const { calls, input } = mount();
    const live = screen.getByTestId('page-search-live');
    expect(live.getAttribute('aria-live')).toBe('polite');
    await type(input, 'live');
    await answer(await nth(calls, 1), 200, result([hit('l1')], null, 'not-indexed'));
    expect(live.textContent).toBe(
      'Search results updated. Showing word matches only — pages aren’t indexed for meaning search yet.',
    );
  });

  it('uses no dangerouslySetInnerHTML in the new files', () => {
    for (const f of [
      'PagesSearch.tsx',
      'PageSearchResults.tsx',
      'PageSearchHitRow.tsx',
      'snippetEmphasis.ts',
    ]) {
      const src = readFileSync(`app/(authed)/pages/_components/${f}`, 'utf8');
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });
});
