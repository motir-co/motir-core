// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// Board completeness (Subtask 3.2.6) — the empty-board state, the
// unmapped-statuses tray (present/absent), the mobile pager, and (MOTIR-10535)
// the per-lane scroll-to-load paging that replaced 3.8.4's over-cap banner. Like the
// 3.2.2/3.2.4 board tests this drives the real BoardContainer under happy-dom
// (DB-free): stub next/navigation (the usePeekOpen push) + global fetch, wrap in
// ToastProvider (the dnd-kit container reads it). The empty-state CTA reuses the
// shipped NewIssueButton → useCreateIssue, so stub that context to a live
// project rather than mounting the whole CreateIssueProvider + modal.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/boards',
  useSearchParams: () => new URLSearchParams(),
}));

// `issuesChangedAt` is mutable so a test can simulate the provider ticking it
// after a successful create (the signal BoardContainer refetches on).
const createState = vi.hoisted(() => ({ openCreateIssue: vi.fn(), issuesChangedAt: 0 }));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({
    open: false,
    setOpen: vi.fn(),
    openCreateIssue: createState.openCreateIssue,
    canCreate: true,
    issuesChangedAt: createState.issuesChangedAt,
  }),
  useNotifyIssuesChanged: () => () => {},
}));

import { BoardContainer } from '@/app/(authed)/boards/_components/BoardContainer';
import type {
  BoardCardDto,
  BoardColumnDto,
  BoardColumnPageDto,
  BoardProjectionDto,
  BoardSwimlaneDto,
} from '@/lib/dto/boards';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';

function column(over: Partial<BoardColumnDto> & { id: string; name: string }): BoardColumnDto {
  return {
    position: 'a0',
    wipLimit: null,
    statusKeys: ['todo'],
    cards: [],
    totalCount: 0,
    cursor: null,
    ...over,
  };
}

function card(over: Partial<BoardCardDto> & { id: string; key: number }): BoardCardDto {
  return {
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    identifier: `PROD-${over.key}`,
    title: `Card ${over.key}`,
    status: 'todo',
    ciState: null,
    fixReason: null,
    obsolescence: null,
    statusCategory: 'todo',
    priority: 'medium',
    assigneeId: null,
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    position: 'a0',
    ready: true,
    readyToStart: false,
    statusLabel: 'To Do',
    hasChildren: false,
    type: null,
    executor: null,
    pendingDecision: null,
    planHold: null,
    ...over,
  };
}

function status(
  over: Partial<WorkflowStatusDto> & { id: string; label: string },
): WorkflowStatusDto {
  return {
    projectId: 'p1',
    key: over.id,
    category: 'todo',
    color: null,
    position: 'a0',
    isInitial: false,
    ...over,
  };
}

function projection(over: Partial<BoardProjectionDto> = {}): BoardProjectionDto {
  return {
    boardId: 'b1',
    name: 'Default',
    type: 'kanban',
    swimlaneGroupBy: 'none',
    swimlanes: [],
    unmappedStatuses: [],
    sprint: null,
    planHolds: {},
    columns: [column({ id: 'c1', name: 'To Do' }), column({ id: 'c2', name: 'In Progress' })],
    ...over,
  };
}

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

function mockFetchOk(data: BoardProjectionDto) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => data });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.useRealTimers();
  createState.issuesChangedAt = 0;
});

describe('board completeness (3.2.6)', () => {
  it('shows the empty-board state (not blank columns) when every column is empty', async () => {
    // All columns totalCount 0, no unmapped statuses → the board empty state.
    vi.stubGlobal('fetch', mockFetchOk(projection()));
    render(<BoardContainer />);

    await waitFor(() => expect(screen.getByText('No work items yet')).toBeTruthy());
    // The column row is NOT rendered — the empty state replaces it.
    expect(screen.queryByTestId('board')).toBeNull();
    // The CTA reuses the shipped create flow (NewIssueButton → openCreateIssue).
    const cta = screen.getByRole('button', { name: 'New work item' });
    fireEvent.click(cta);
    expect(createState.openCreateIssue).toHaveBeenCalledTimes(1);
  });

  it('refetches and leaves the empty state when a work item is created', async () => {
    // The board is client-fetched, so router.refresh() can't update it — it
    // watches the provider's issuesChangedAt tick instead. Empty first, then a
    // create bumps the tick → refetch returns a populated board → the empty
    // state is gone. (Regression: creating from the empty state used to leave
    // the board stuck on "No work items yet".)
    const populated = projection({
      columns: [column({ id: 'c1', name: 'To Do', totalCount: 1 })],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => projection() })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => populated });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<BoardContainer />);
    await waitFor(() => expect(screen.getByText('No work items yet')).toBeTruthy());

    // Simulate the provider's post-create tick + re-render (what a real create does).
    createState.issuesChangedAt = 1;
    rerender(
      <ToastProvider>
        <BoardContainer />
      </ToastProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.queryByText('No work items yet')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refetches when the active project changes (project / workspace switch)', async () => {
    // Switching project persists a new WorkspaceMembership.activeProjectId then
    // router.refresh() — which only re-runs Server Components. The board page
    // re-renders with the new activeProjectId prop; the client container must
    // refetch for the new project instead of showing the previous one's board.
    // (Regression: switching project left /boards on the old project's data.)
    const populated = projection({
      columns: [column({ id: 'c1', name: 'To Do', totalCount: 1 })],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => projection() })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => populated });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<BoardContainer activeProjectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('No work items yet')).toBeTruthy());

    // The refresh re-renders the page with the newly-active project's id.
    rerender(
      <ToastProvider>
        <BoardContainer activeProjectId="proj-2" />
      </ToastProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.queryByText('No work items yet')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the columns (not the empty state) when work items are hidden in unmapped statuses', async () => {
    // Every column is empty BUT a status is unmapped — work items may be hidden,
    // so the board must NOT claim "no work items" (the rung-2 guard).
    vi.stubGlobal(
      'fetch',
      mockFetchOk(projection({ unmappedStatuses: [status({ id: 's-hold', label: 'On Hold' })] })),
    );
    render(<BoardContainer />);

    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.queryByText('No work items yet')).toBeNull();
    expect(screen.getByTestId('board-unmapped-tray')).toBeTruthy();
  });

  it('renders the unmapped-statuses tray with the status names + a Map columns → link to board settings (3.6.3)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk(
        projection({
          columns: [column({ id: 'c1', name: 'To Do', totalCount: 1 })],
          unmappedStatuses: [
            status({ id: 's-triage', label: 'Needs Triage' }),
            status({ id: 's-hold', label: 'On Hold' }),
          ],
        }),
      ),
    );
    render(<BoardContainer />);

    await waitFor(() => expect(screen.getByTestId('board-unmapped-tray')).toBeTruthy());
    expect(screen.getByText('Needs Triage')).toBeTruthy();
    expect(screen.getByText('On Hold')).toBeTruthy();
    const link = screen.getByTestId('board-unmapped-link');
    // Repointed in 3.6.3: from the interim "Manage statuses →" (workflow editor)
    // to "Map columns →" → the real board-config admin. Carries the viewed board
    // (`?board=`) as of 3.7.8 so it opens THIS board's settings, not the default.
    expect(link.getAttribute('href')).toBe('/settings/project/board?board=b1');
    expect(link.textContent).toContain('Map columns');
  });

  it('omits the unmapped tray when every status is mapped', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk(projection({ columns: [column({ id: 'c1', name: 'To Do', totalCount: 1 })] })),
    );
    render(<BoardContainer />);

    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.queryByTestId('board-unmapped-tray')).toBeNull();
  });

  it('renders the mobile column pager (decorative) with the active column position', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk(projection({ columns: [column({ id: 'c1', name: 'To Do', totalCount: 1 })] })),
    );
    render(<BoardContainer />);

    // A single column → nothing to page through, so the pager is absent.
    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.queryByTestId('board-pager')).toBeNull();
  });

  it('shows the pager (with a dot per column) when there is more than one column', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk(
        projection({
          columns: [
            column({ id: 'c1', name: 'To Do', totalCount: 1 }),
            column({ id: 'c2', name: 'In Progress', totalCount: 1 }),
            column({ id: 'c3', name: 'Done', totalCount: 1 }),
          ],
        }),
      ),
    );
    render(<BoardContainer />);

    const pager = await screen.findByTestId('board-pager');
    // The position label defaults to the first column before any scroll.
    expect(pager.textContent).toContain('To Do · 1 of 3');
  });
});

// ── Per-lane paging (MOTIR-10535) ──────────────────────────────────────────
// happy-dom has no layout, so the lane sentinel's IntersectionObserver is a
// controllable fake: `scrollIntoView(columnId)` reports the newest LIVE observer
// watching that lane's sentinel as intersecting — what the browser does when the
// user scrolls the lane to its bottom.

interface FakeObserver {
  callback: IntersectionObserverCallback;
  targets: Element[];
  live: boolean;
  root: Element | Document | null;
}
const observers: FakeObserver[] = [];

class FakeIntersectionObserver {
  private readonly self: FakeObserver;
  constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {
    this.self = { callback, targets: [], live: true, root: init?.root ?? null };
    observers.push(this.self);
  }
  observe(el: Element) {
    this.self.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.self.live = false;
  }
  takeRecords() {
    return [];
  }
}

function liveObserverFor(columnId: string): FakeObserver | undefined {
  return [...observers]
    .reverse()
    .find(
      (o) =>
        o.live &&
        o.targets.some(
          (t) => (t as HTMLElement).dataset['testid'] === `board-lane-sentinel-${columnId}`,
        ),
    );
}

function scrollIntoView(columnId: string) {
  const o = liveObserverFor(columnId);
  if (!o) throw new Error(`no live sentinel observer for ${columnId}`);
  o.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
}

function cardsFrom(from: number, n: number, over: Partial<BoardCardDto> = {}): BoardCardDto[] {
  return Array.from({ length: n }, (_, i) => card({ id: `w${from + i}`, key: from + i, ...over }));
}

/** A fetch that answers the board read with `board` and each page read from
 * `pages` in turn (a `Response`-like `{ ok: false }` entry is a failed page). */
function routedFetch(board: BoardProjectionDto, pages: Array<BoardColumnPageDto | { ok: false }>) {
  return vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/board/columns/')) {
      const next = pages.shift();
      if (!next || 'ok' in next) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => next };
    }
    return { ok: true, status: 200, json: async () => board };
  });
}

describe('per-lane scroll-to-load paging (MOTIR-10535)', () => {
  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  });

  const pagedBoard = () =>
    projection({
      columns: [
        column({
          id: 'c1',
          name: 'To Do',
          totalCount: 2830,
          cursor: 'CUR-1',
          cards: cardsFrom(1, 10),
        }),
        column({ id: 'c2', name: 'In Progress', totalCount: 2, cards: cardsFrom(100, 2) }),
      ],
    });

  it('reads "{loaded} of {total}" on a lane with more, and the plain total on a complete one', async () => {
    vi.stubGlobal('fetch', routedFetch(pagedBoard(), []));
    render(<BoardContainer />);

    const badge = await screen.findByTestId('board-count-c1');
    expect(badge.textContent).toBe('10 of 2,830');
    expect(screen.getByTestId('board-count-c2').textContent).toBe('2');
    // Only the lane with a cursor has a footer + sentinel; no "Load more" button.
    expect(screen.getByTestId('board-lane-sentinel-c1')).toBeTruthy();
    expect(screen.queryByTestId('board-lane-footer-c2')).toBeNull();
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('loads the next page when the sentinel scrolls into view, then stops at the last page', async () => {
    const fetchMock = routedFetch(pagedBoard(), [
      { columnId: 'c1', cards: cardsFrom(11, 10), totalCount: 25, cursor: 'CUR-2', planHolds: {} },
      { columnId: 'c1', cards: cardsFrom(21, 5), totalCount: 25, cursor: null, planHolds: {} },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<BoardContainer />);
    await screen.findByTestId('board-count-c1');

    scrollIntoView('c1');
    await waitFor(() => expect(screen.getByTestId('board-count-c1').textContent).toBe('20 of 25'));
    const pageUrl = String(fetchMock.mock.calls[1]![0]);
    expect(pageUrl).toBe('/api/board/columns/c1/cards?boardId=b1&cursor=CUR-1');
    expect(screen.getByText('Card 20')).toBeTruthy();

    // The observer is rebuilt for the new generation — the next report asks for
    // the page after CUR-2.
    scrollIntoView('c1');
    await waitFor(() => expect(screen.getByTestId('board-count-c1').textContent).toBe('25'));
    expect(String(fetchMock.mock.calls[2]![0])).toContain('cursor=CUR-2');
    // Every card is loaded: the footer (and its sentinel) is gone, so nothing
    // can ask for another page.
    expect(screen.queryByTestId('board-lane-footer-c1')).toBeNull();
    expect(liveObserverFor('c1')).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('shows the in-flight spinner while a page loads, and stops watching until it lands', async () => {
    let resolvePage!: (v: unknown) => void;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith('/api/board/columns/')) {
        return new Promise((r) => {
          resolvePage = r;
        });
      }
      return { ok: true, status: 200, json: async () => pagedBoard() };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<BoardContainer />);
    await screen.findByTestId('board-count-c1');

    scrollIntoView('c1');
    const spinner = await screen.findByTestId('board-lane-loading-c1');
    expect(spinner.getAttribute('role')).toBe('status');
    expect(spinner.textContent).toContain('Loading…');
    // While the page is in flight the lane watches nothing, so a scroll cannot
    // ask for the same page twice.
    expect(liveObserverFor('c1')).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolvePage({
      ok: true,
      status: 200,
      json: async () => ({
        columnId: 'c1',
        cards: cardsFrom(11, 3),
        totalCount: 13,
        cursor: null,
        planHolds: {},
      }),
    });
    await waitFor(() => expect(screen.getByTestId('board-count-c1').textContent).toBe('13'));
    expect(screen.queryByTestId('board-lane-loading-c1')).toBeNull();
  });

  it('leaves a focusable inline retry when a page fails, and retrying loads it', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch(pagedBoard(), [
        { ok: false },
        { columnId: 'c1', cards: cardsFrom(11, 2), totalCount: 12, cursor: null, planHolds: {} },
      ]),
    );
    render(<BoardContainer />);
    await screen.findByTestId('board-count-c1');

    scrollIntoView('c1');
    const retry = (await screen.findByTestId('board-lane-retry-c1')) as HTMLButtonElement;
    expect(retry.tagName).toBe('BUTTON');
    expect(retry.textContent).toContain('Retry');
    // The cards already loaded stay put.
    expect(screen.getByTestId('board-count-c1').textContent).toBe('10 of 2,830');

    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId('board-count-c1').textContent).toBe('12'));
    expect(screen.queryByTestId('board-lane-retry-c1')).toBeNull();
  });

  it('never renders a card twice when a page repeats one already on the board', async () => {
    // w100 sits in In Progress; it moved into To Do between two page reads, so
    // the next To Do page holds it too. The board keeps its one copy.
    vi.stubGlobal(
      'fetch',
      routedFetch(pagedBoard(), [
        {
          columnId: 'c1',
          cards: [card({ id: 'w100', key: 100 }), ...cardsFrom(11, 1)],
          totalCount: 12,
          cursor: null,
          planHolds: {},
        },
      ]),
    );
    render(<BoardContainer />);
    await screen.findByTestId('board-count-c1');

    scrollIntoView('c1');
    await waitFor(() => expect(screen.getByText('Card 11')).toBeTruthy());
    expect(screen.getAllByText('Card 100')).toHaveLength(1);
  });

  it('pages a lane of the swimlane board from its footer row, against the viewport', async () => {
    const SWIMLANES: BoardSwimlaneDto[] = [
      { key: 'u1', label: 'Ana Ruiz', kind: 'assignee', count: 11 },
    ];
    const board = projection({
      swimlaneGroupBy: 'assignee',
      swimlanes: SWIMLANES,
      columns: [
        column({
          id: 'c1',
          name: 'To Do',
          totalCount: 11,
          cursor: 'CUR-1',
          cards: cardsFrom(1, 10, { swimlaneKey: 'u1', assigneeId: 'u1' }),
        }),
        column({ id: 'c2', name: 'In Progress' }),
      ],
    });
    vi.stubGlobal(
      'fetch',
      routedFetch(board, [
        {
          columnId: 'c1',
          cards: cardsFrom(11, 1, { swimlaneKey: 'u1', assigneeId: 'u1' }),
          totalCount: 11,
          cursor: null,
          planHolds: {},
        },
      ]),
    );
    render(<BoardContainer />);

    await waitFor(() => expect(screen.getByText('Ana Ruiz')).toBeTruthy());
    expect(screen.getByTestId('swimlane-load-row')).toBeTruthy();
    expect(screen.getByTestId('board-count-c1').textContent).toBe('10 of 11');
    // The swimlane board scrolls as a whole, so the lane sentinel's root is the
    // viewport (null), not a column body.
    expect(liveObserverFor('c1')!.root).toBeNull();

    scrollIntoView('c1');
    await waitFor(() => expect(screen.getByTestId('board-count-c1').textContent).toBe('11'));
    expect(screen.getByText('Card 11')).toBeTruthy();
  });
});
