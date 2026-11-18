// @vitest-environment happy-dom
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// A DRAG ACROSS CELLS on a grouped board (MOTIR-11452). The drag reads and writes
// the per-cell store the pager merges into: the move lands at the drop slot, the
// two cells', two columns' and two lanes' counts follow per axis, each axis
// reverts on its own when refused, only a card's latest move applies, and a page
// fetched afterwards never repeats the card.
//
// dnd-kit cannot be driven by pointer in happy-dom (nothing has a layout), so the
// board's OWN handlers are driven: `DndContext` is wrapped to capture the props
// BoardContainer hands it — the `board-plan-hold.test.tsx` harness.

type Announce = (event: unknown) => string | undefined;
interface DragHandlers {
  onDragStart: (event: unknown) => void;
  onDragOver: (event: unknown) => void;
  onDragEnd: (event: unknown) => void;
  onDragCancel: () => void;
  accessibility: {
    announcements: Record<'onDragStart' | 'onDragOver' | 'onDragEnd' | 'onDragCancel', Announce>;
  };
}

const { toastSpy, dnd, updateIssueAction } = vi.hoisted(() => ({
  toastSpy: vi.fn(),
  dnd: { props: null as null | DragHandlers },
  updateIssueAction: vi.fn(),
}));

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  function CapturingDndContext(props: ComponentProps<typeof actual.DndContext>) {
    dnd.props = props as unknown as DragHandlers;
    return <actual.DndContext {...props} />;
  }
  return { ...actual, DndContext: CapturingDndContext };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/boards',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({ updateIssueAction }));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({
    open: false,
    setOpen: vi.fn(),
    openCreateIssue: vi.fn(),
    canCreate: true,
    issuesChangedAt: 0,
  }),
  useNotifyIssuesChanged: () => () => {},
}));
vi.spyOn(window.history, 'pushState').mockImplementation(() => {});

import { BoardContainer } from '@/app/(authed)/boards/_components/BoardContainer';
import type {
  BoardCardDto,
  BoardCellPageDto,
  BoardColumnDto,
  BoardLanePageDto,
  BoardProjectionDto,
} from '@/lib/dto/boards';

// Every lane is "in view" the moment it is observed.
class InViewObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(el: Element) {
    queueMicrotask(() =>
      this.callback(
        [{ isIntersecting: true, target: el } as unknown as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      ),
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', InViewObserver);
  updateIssueAction.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  dnd.props = null;
});

function card(id: string, key: number, laneKey: string): BoardCardDto {
  return {
    id,
    key,
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    identifier: `PROD-${key}`,
    title: `Card ${key}`,
    status: 'todo',
    ciState: null,
    fixReason: null,
    obsolescence: null,
    statusCategory: 'todo',
    priority: 'medium',
    assigneeId: laneKey,
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    position: `a${key}`,
    ready: true,
    readyToStart: false,
    statusLabel: 'To Do',
    hasChildren: false,
    type: null,
    executor: null,
    pendingDecision: null,
    planHold: null,
    swimlaneKey: laneKey,
  };
}

function column(id: string, name: string, totalCount: number): BoardColumnDto {
  return {
    id,
    name,
    position: id,
    wipLimit: null,
    statusKeys: [id === 'c1' ? 'todo' : 'in_progress'],
    cards: [],
    totalCount,
    cursor: null,
  };
}

// Two columns × two assignee lanes, on a grouped projection (no column cards).
//   (c1,u1) w1 w2 · 2        (c2,u1) w3 · 1          lane u1 = 3
//   (c1,u2) w4    · 1 of 5   (c2,u2) —  · 0          lane u2 = 5
const projection: BoardProjectionDto = {
  boardId: 'b1',
  name: 'Default',
  type: 'kanban',
  swimlaneGroupBy: 'assignee',
  swimlanes: [
    { key: 'u1', label: 'Ana', kind: 'assignee', count: 3 },
    { key: 'u2', label: 'Ben', kind: 'assignee', count: 5 },
  ],
  unmappedStatuses: [],
  unmappedStatusesInScope: [],
  sprint: null,
  storedFilter: null,
  planHolds: {},
  columns: [column('c1', 'To Do', 7), column('c2', 'In Progress', 1)],
};

function cell(
  columnId: string,
  laneKey: string,
  cards: BoardCardDto[],
  totalCount: number,
  cursor: string | null = null,
): BoardCellPageDto {
  return { columnId, laneKey, cards, totalCount, cursor, planHolds: {} };
}

const lanePages: Record<string, BoardLanePageDto> = {
  u1: {
    laneKey: 'u1',
    cells: [
      cell('c1', 'u1', [card('w1', 1, 'u1'), card('w2', 2, 'u1')], 2),
      cell('c2', 'u1', [card('w3', 3, 'u1')], 1),
    ],
  } as BoardLanePageDto,
  u2: {
    laneKey: 'u2',
    cells: [cell('c1', 'u2', [card('w4', 4, 'u2')], 5, 'CUR-c1u2'), cell('c2', 'u2', [], 0)],
  } as BoardLanePageDto,
};

type Reply = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

/** Routes the board read, the lane reads, the cell pages and the board move. */
function stubFetch(
  opts: {
    move?: () => Reply;
    cellPage?: (url: string) => Reply;
    failLane?: string;
    board?: BoardProjectionDto;
    lanes?: Record<string, BoardLanePageDto>;
  } = {},
) {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchSpy = vi.fn(async (input: string, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/board/move')) {
      const reply = await (opts.move?.() ?? { status: 200, body: { card: card('w0', 0, 'u1') } });
      return json(reply.status, reply.body);
    }
    const lane = /^\/api\/board\/lanes\/([^/]+)\/cells/.exec(url);
    if (lane) {
      if (lane[1] === opts.failLane) return json(500, {});
      return json(200, (opts.lanes ?? lanePages)[decodeURIComponent(lane[1]!)]);
    }
    if (url.startsWith('/api/board/columns/')) {
      const reply = await (opts.cellPage?.(url) ?? { status: 500, body: {} });
      return json(reply.status, reply.body);
    }
    return json(200, opts.board ?? projection);
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

async function renderBoard(c1u2 = '1 of 5', [l1, l2] = ['u1', 'u2']) {
  render(<BoardContainer projectName="Motir" />);
  await waitFor(() => expect(screen.getByTestId(`cell-count-c1-${l2}`).textContent).toBe(c1u2));
  await waitFor(() => expect(screen.getByTestId(`cell-count-c1-${l1}`)).toBeTruthy());
}

async function drag(activeId: string, overId: string) {
  act(() => dnd.props!.onDragStart({ active: { id: activeId } }));
  act(() => dnd.props!.onDragOver({ active: { id: activeId }, over: { id: overId } }));
  await act(async () => {
    dnd.props!.onDragEnd({ active: { id: activeId }, over: { id: overId } });
  });
  await act(async () => {});
}

const cellOf = (c: string, l: string) => screen.getByTestId(`lane-cell-${c}-${l}`);
const cardsIn = (c: string, l: string) =>
  within(cellOf(c, l))
    .queryAllByTestId(/^board-card-PROD-/)
    .map((el) => el.getAttribute('data-testid')!.replace('board-card-', ''));
const count = (testId: string) => screen.getByTestId(testId).textContent;
const moveCalls = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.filter(([u]) => String(u).startsWith('/api/board/move'));
const pageCalls = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.filter(([u]) => String(u).startsWith('/api/board/columns/'));

/** The counts a move can touch, read off the rendered board. */
function counts() {
  return {
    c1u1: count('cell-count-c1-u1'),
    c1u2: count('cell-count-c1-u2'),
    c2u1: count('cell-count-c2-u1'),
    laneU1: count('swimlane-count-u1'),
    laneU2: count('swimlane-count-u2'),
    colC1: count('board-count-c1'),
    colC2: count('board-count-c2'),
  };
}

describe('a drag across cells on a grouped board', () => {
  it('lights the hovered lane while the pointer is over a card, not only over a cell body', async () => {
    stubFetch();
    await renderBoard();
    const track = () => cellOf('c1', 'u2').parentElement!.parentElement!;
    expect(track().className).not.toContain('bg-(--el-droptarget-bg)');
    act(() => dnd.props!.onDragStart({ active: { id: 'w1' } }));
    act(() => dnd.props!.onDragOver({ active: { id: 'w1' }, over: { id: 'w4' } }));
    expect(track().className).toContain('bg-(--el-droptarget-bg)');
    act(() => dnd.props!.onDragCancel());
    expect(track().className).not.toContain('bg-(--el-droptarget-bg)');
  });

  it('a cross-lane move lands before the card it was dropped on; cells and lanes ±1, the column unchanged; a later page adds no second copy', async () => {
    const fetchSpy = stubFetch({
      cellPage: () => ({
        status: 200,
        body: cell('c1', 'u2', [card('w1', 1, 'u2'), card('w9', 9, 'u2')], 6, 'CUR-2'),
      }),
    });
    await renderBoard();
    const before = counts();

    await drag('w1', 'w4');

    expect(cardsIn('c1', 'u1')).toEqual(['PROD-2']);
    expect(cardsIn('c1', 'u2')).toEqual(['PROD-1', 'PROD-4']);
    expect(counts()).toEqual({
      ...before,
      c1u1: '1',
      c1u2: '2 of 6',
      laneU1: '2',
      laneU2: '6',
    });
    // Lane only: the reassign, never the board move.
    expect(updateIssueAction).toHaveBeenCalledWith({ id: 'w1', assigneeId: 'u2' });
    expect(moveCalls(fetchSpy)).toHaveLength(0);

    // Page the target cell: the cursor the read put there is the one asked with,
    // and the page's copy of the landed card is skipped.
    fireEvent.click(screen.getByTestId('cell-load-more-c1-u2'));
    await waitFor(() => expect(cardsIn('c1', 'u2')).toEqual(['PROD-1', 'PROD-4', 'PROD-9']));
    expect(String(pageCalls(fetchSpy)[0]![0])).toContain('cursor=CUR-c1u2');
    expect(count('cell-count-c1-u2')).toBe('3 of 6');
  });

  it('a cross-column move in one lane: cells ±1, columns ∓1, the lane unchanged', async () => {
    const fetchSpy = stubFetch();
    await renderBoard();
    const before = counts();

    await drag('w1', 'c2::u1');

    expect(cardsIn('c2', 'u1')).toEqual(['PROD-3', 'PROD-1']);
    expect(counts()).toEqual({
      ...before,
      c1u1: '1',
      c2u1: '2',
      colC1: '2 of 6',
      colC2: '2',
    });
    expect(updateIssueAction).not.toHaveBeenCalled();
    const body = JSON.parse(String(moveCalls(fetchSpy)[0]![1]!.body));
    expect(body).toMatchObject({ workItemId: 'w1', toColumnId: 'c2', beforeId: 'w3' });
  });

  it('a diagonal move is the union: four counts move, columns and lanes each transfer one', async () => {
    const fetchSpy = stubFetch();
    await renderBoard();
    const before = counts();

    await drag('w1', 'c2::u2');

    expect(cardsIn('c2', 'u2')).toEqual(['PROD-1']);
    expect(count('cell-count-c2-u2')).toBe('1');
    expect(counts()).toEqual({
      ...before,
      c1u1: '1',
      laneU1: '2',
      laneU2: '6',
      colC1: '2 of 6',
      colC2: '2',
    });
    expect(moveCalls(fetchSpy)).toHaveLength(1);
    expect(updateIssueAction).toHaveBeenCalledTimes(1);
  });

  it('a reorder inside one cell moves no count and ranks against the cell', async () => {
    const fetchSpy = stubFetch();
    await renderBoard();
    const before = counts();

    await drag('w2', 'w1');

    expect(cardsIn('c1', 'u1')).toEqual(['PROD-2', 'PROD-1']);
    expect(counts()).toEqual(before);
    const body = JSON.parse(String(moveCalls(fetchSpy)[0]![1]!.body));
    expect(body).toMatchObject({ workItemId: 'w2', toColumnId: 'c1', afterId: 'w1' });
    expect(body.beforeId).toBeUndefined();
  });

  it('a refused transition returns the card to its origin column in the lane the reassign accepted', async () => {
    stubFetch({ move: () => ({ status: 409, body: { title: 'illegal' } }) });
    await renderBoard();
    const before = counts();

    await drag('w1', 'c2::u2');

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(cardsIn('c2', 'u2')).toEqual([]);
    // Origin column, accepted lane — appended, since the card it followed is not here.
    expect(cardsIn('c1', 'u2')).toEqual(['PROD-4', 'PROD-1']);
    expect(counts()).toEqual({
      ...before,
      c1u1: '1',
      c1u2: '2 of 6',
      laneU1: '2',
      laneU2: '6',
    });
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'error', title: 'Move not allowed' }),
    );
  });

  it('a refused reassign returns the card to its origin lane in the accepted column', async () => {
    updateIssueAction.mockResolvedValue({ ok: false, error: 'No.' });
    stubFetch();
    await renderBoard();
    const before = counts();

    await drag('w1', 'c2::u2');

    await waitFor(() => expect(cardsIn('c2', 'u1')).toEqual(['PROD-3', 'PROD-1']));
    expect(cardsIn('c2', 'u2')).toEqual([]);
    expect(counts()).toEqual({
      ...before,
      c1u1: '1',
      c2u1: '2',
      colC1: '2 of 6',
      colC2: '2',
    });
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'error', description: 'No.' }),
    );
  });

  it('a drop that changes nothing asks nothing; a cancel leaves every cell as it stands', async () => {
    const fetchSpy = stubFetch();
    await renderBoard();
    const calls = fetchSpy.mock.calls.length;
    const before = counts();

    await drag('w1', 'w1');
    await drag('w2', 'c1::u1'); // already last in its cell: appending changes nothing
    act(() => dnd.props!.onDragStart({ active: { id: 'w1' } }));
    act(() => dnd.props!.onDragCancel());
    await act(async () => {
      dnd.props!.onDragEnd({ active: { id: 'w1' }, over: null });
    });

    expect(fetchSpy.mock.calls.slice(calls).map(([u]) => String(u))).toEqual([]);
    expect(updateIssueAction).not.toHaveBeenCalled();
    expect(counts()).toEqual(before);
    expect(cardsIn('c1', 'u1')).toEqual(['PROD-1', 'PROD-2']);
  });

  it('a slow refusal of an earlier move cannot pull the card out of where a later move put it', async () => {
    let refuseFirst!: (r: { status: number; body: unknown }) => void;
    const replies: Array<() => Reply> = [
      () => new Promise((resolve) => (refuseFirst = resolve)),
      () => ({ status: 200, body: { card: card('w1', 1, 'u1') } }),
    ];
    stubFetch({ move: () => replies.shift()!() });
    await renderBoard();

    await drag('w1', 'c2::u1'); // first move: in flight
    await drag('w1', 'w2'); // second move: back to (c1,u1), before w2 — answered
    expect(cardsIn('c1', 'u1')).toEqual(['PROD-1', 'PROD-2']);

    await act(async () => refuseFirst({ status: 409, body: {} }));
    await act(async () => {});
    expect(cardsIn('c1', 'u1')).toEqual(['PROD-1', 'PROD-2']);
    expect(cardsIn('c2', 'u1')).toEqual(['PROD-3']);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('a drop into a cell no page has reached keeps the card, reads as loading, and asks that cell’s first page once', async () => {
    let answer!: (r: { status: number; body: unknown }) => void;
    const fetchSpy = stubFetch({
      failLane: 'u2',
      cellPage: () => new Promise((resolve) => (answer = resolve)),
    });
    render(<BoardContainer projectName="Motir" />);
    await waitFor(() => expect(screen.getByTestId('cell-count-c1-u1')).toBeTruthy());
    await waitFor(() => expect(cellOf('c2', 'u2').getAttribute('data-cell-phase')).toBe('failed'));

    await drag('w1', 'c2::u2');

    expect(cardsIn('c2', 'u2')).toEqual(['PROD-1']);
    expect(cellOf('c2', 'u2').getAttribute('data-cell-phase')).toBe('first-load');
    expect(screen.queryByTestId('cell-count-c2-u2')).toBeNull();
    await waitFor(() => expect(pageCalls(fetchSpy)).toHaveLength(1));
    const pages = pageCalls(fetchSpy);
    expect(String(pages[0]![0])).toBe('/api/board/columns/c2/cards?boardId=b1&lane=u2');

    await act(async () =>
      answer({
        status: 200,
        body: cell('c2', 'u2', [card('w1', 1, 'u2'), card('w7', 7, 'u2')], 2),
      }),
    );
    await waitFor(() => expect(count('cell-count-c2-u2')).toBe('2'));
    expect(cardsIn('c2', 'u2')).toEqual(['PROD-1', 'PROD-7']);
    expect(pageCalls(fetchSpy)).toHaveLength(1);
  });

  it('a drop into a cell no page has reached reads its first page only after the drop’s writes settle', async () => {
    let answerMove!: (r: { status: number; body: unknown }) => void;
    let answerReassign!: () => void;
    updateIssueAction.mockImplementationOnce(
      () => new Promise((resolve) => (answerReassign = () => resolve({ ok: true }))),
    );
    const fetchSpy = stubFetch({
      failLane: 'u2',
      move: () => new Promise((resolve) => (answerMove = resolve)),
      cellPage: () => ({
        status: 200,
        body: cell('c2', 'u2', [card('w1', 1, 'u2'), card('w7', 7, 'u2')], 2),
      }),
    });
    render(<BoardContainer projectName="Motir" />);
    await waitFor(() => expect(screen.getByTestId('cell-count-c1-u1')).toBeTruthy());
    await waitFor(() => expect(cellOf('c2', 'u2').getAttribute('data-cell-phase')).toBe('failed'));

    await drag('w1', 'c2::u2');

    // Both writes are in flight: the cell reads as loading and asks nothing yet,
    // so its page cannot answer from before the card arrived.
    expect(cellOf('c2', 'u2').getAttribute('data-cell-phase')).toBe('first-load');
    expect(pageCalls(fetchSpy)).toHaveLength(0);

    await act(async () => answerMove({ status: 200, body: { card: card('w1', 1, 'u2') } }));
    expect(pageCalls(fetchSpy)).toHaveLength(0);

    await act(async () => answerReassign());
    await waitFor(() => expect(pageCalls(fetchSpy)).toHaveLength(1));
    await waitFor(() => expect(count('cell-count-c2-u2')).toBe('2'));
    expect(cardsIn('c2', 'u2')).toEqual(['PROD-1', 'PROD-7']);
  });

  it('the move response takes the confirmed card into its cell', async () => {
    stubFetch({
      move: () => ({
        status: 200,
        body: { card: { ...card('w1', 1, 'zz'), title: 'Confirmed title' } },
      }),
    });
    await renderBoard();

    await drag('w1', 'c2::u1');

    await waitFor(() =>
      expect(within(cellOf('c2', 'u1')).getByText('Confirmed title')).toBeTruthy(),
    );
  });
  it('a plan refusal of a grouped move returns the card and opens the plan’s refusal, with no toast', async () => {
    stubFetch({
      move: () => ({
        status: 409,
        body: {
          code: 'PLAN_TARGET_HELD',
          error: 'held',
          plan: {
            kind: 'plan',
            planId: 'pln_a',
            planStatus: 'planned',
            sessionId: 'pcs_a',
            anchorKey: 'PROD-10',
            itemKey: 'PROD-1',
            workItemId: 'w1',
          },
        },
      }),
    });
    await renderBoard();

    await drag('w1', 'c2::u1');

    await waitFor(() => expect(document.querySelector('[data-board-held]')).toBeTruthy());
    expect(cardsIn('c1', 'u1')).toEqual(['PROD-1', 'PROD-2']);
    expect(cardsIn('c2', 'u1')).toEqual(['PROD-3']);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('a drop on nothing it can resolve, or on no target, changes nothing', async () => {
    const fetchSpy = stubFetch();
    await renderBoard();
    const calls = fetchSpy.mock.calls.length;

    await drag('w1', 'not-a-card-or-cell');
    await drag('zz', 'c2::u1');

    expect(fetchSpy.mock.calls.length).toBe(calls);
    expect(cardsIn('c1', 'u1')).toEqual(['PROD-1', 'PROD-2']);
  });

  it('narrates a grouped drag from the cells: pick-up, move, each kind of drop, cancel', async () => {
    stubFetch();
    await renderBoard();
    const a = dnd.props!.accessibility.announcements;

    act(() => dnd.props!.onDragStart({ active: { id: 'w1' } }));
    expect(a.onDragStart({ active: { id: 'w1' } })).toContain('PROD-1');
    expect(a.onDragOver({ active: { id: 'w1' }, over: { id: 'w4' } })).toContain('To Do');
    expect(a.onDragOver({ active: { id: 'w1' }, over: { id: 'c2::u2' } })).toContain('In Progress');
    expect(a.onDragOver({ active: { id: 'w1' }, over: null })).toBeUndefined();
    expect(a.onDragOver({ active: { id: 'w1' }, over: { id: 'zz' } })).toBeUndefined();
    const diagonal = a.onDragEnd({ active: { id: 'w1' }, over: { id: 'c2::u2' } })!;
    const reassigned = a.onDragEnd({ active: { id: 'w1' }, over: { id: 'c1::u2' } })!;
    const dropped = a.onDragEnd({ active: { id: 'w1' }, over: { id: 'c2::u1' } })!;
    expect(diagonal).toContain('Ben');
    expect(diagonal).toContain('In Progress');
    expect(reassigned).toContain('Ben');
    expect(reassigned).not.toBe(diagonal);
    expect(dropped).toContain('In Progress');
    expect(a.onDragEnd({ active: { id: 'w1' }, over: null })).toBeUndefined();
    expect(a.onDragEnd({ active: { id: 'w1' }, over: { id: 'zz' } })).toBeUndefined();
    expect(a.onDragCancel({ active: { id: 'w1' } })).toContain('To Do');
    act(() => dnd.props!.onDragCancel());
    expect(a.onDragStart({ active: { id: 'zz' } })).toBeUndefined();
  });
  it('a move that never reaches the server reverts its column axis and says so', async () => {
    stubFetch({ move: () => Promise.reject(new Error('offline')) });
    await renderBoard();
    const before = counts();

    await drag('w1', 'c2::u1');

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(cardsIn('c1', 'u1')).toEqual(['PROD-1', 'PROD-2']);
    expect(counts()).toEqual(before);
  });
  it('a late answer to an earlier move — accepted or failed — applies nothing', async () => {
    let first!: (r: { status: number; body: unknown }) => void;
    let second!: (r: { status: number; body: unknown }) => void;
    const replies: Array<() => Reply> = [
      () => new Promise((resolve) => (first = resolve)),
      () => new Promise((_resolve, reject) => (second = () => reject(new Error('offline')))),
      () => ({ status: 200, body: { card: card('w1', 1, 'u1') } }),
    ];
    stubFetch({ move: () => replies.shift()!() });
    await renderBoard();

    await drag('w1', 'c2::u1');
    await drag('w1', 'w3'); // (c2,u1), before w3
    await drag('w1', 'c1::u1'); // back home, appended — the latest move, answered
    expect(cardsIn('c1', 'u1')).toEqual(['PROD-2', 'PROD-1']);

    await act(async () => {
      first({ status: 200, body: { card: { ...card('w1', 1, 'u1'), title: 'Stale title' } } });
      second({ status: 0, body: null });
    });
    await act(async () => {});
    expect(screen.queryByText('Stale title')).toBeNull();
    expect(cardsIn('c1', 'u1')).toEqual(['PROD-2', 'PROD-1']);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('narrates a flat board from its columns, as it always has', async () => {
    const flat: BoardProjectionDto = {
      ...projection,
      swimlaneGroupBy: 'none',
      swimlanes: [],
      columns: [
        { ...column('c1', 'To Do', 2), cards: [card('w1', 1, 'u1'), card('w2', 2, 'u1')] },
        column('c2', 'In Progress', 0),
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(flat), { status: 200 })),
    );
    render(<BoardContainer projectName="Motir" />);
    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    const a = dnd.props!.accessibility.announcements;
    expect(a.onDragStart({ active: { id: 'w1' } })).toContain('PROD-1');
    expect(a.onDragOver({ active: { id: 'w1' }, over: { id: 'c2' } })).toContain('In Progress');
    expect(a.onDragEnd({ active: { id: 'w1' }, over: { id: 'c2' } })).toContain('In Progress');
    expect(a.onDragCancel({ active: { id: 'w1' } })).toContain('To Do');
    expect(a.onDragStart({ active: { id: 'zz' } })).toBeUndefined();
    // A flat drop on no target restores the columns, as it always has.
    act(() => dnd.props!.onDragStart({ active: { id: 'w1' } }));
    await act(async () => dnd.props!.onDragEnd({ active: { id: 'w1' }, over: null }));
    expect(screen.getByTestId('board-count-c1').textContent).toBe('2');
  });

  it('a grouped drop with no recorded start resolves against the cells as they stand', async () => {
    stubFetch();
    await renderBoard();
    await act(async () => dnd.props!.onDragEnd({ active: { id: 'w1' }, over: { id: 'c1::u2' } }));
    await act(async () => {});
    expect(cardsIn('c1', 'u2')).toEqual(['PROD-4', 'PROD-1']);
  });
});

// MOTIR-11585 — the new group-by fields. Only the fields a drop can write let a
// card change lanes; the others are LANE-LOCKED (a drop can still change the
// column). A multi-value field renders one card in several lanes, each rendering
// dragged by its placement id, and one column move moves them all.
describe('a drag under the field groupings', () => {
  /** The fixture board re-grouped by `groupBy`, its lanes re-keyed l1/l2. */
  function regrouped(groupBy: BoardProjectionDto['swimlaneGroupBy'], twoLabelCard = false) {
    const kind = groupBy as BoardProjectionDto['swimlanes'][number]['kind'];
    const board: BoardProjectionDto = {
      ...projection,
      swimlaneGroupBy: groupBy,
      swimlanes: [
        { key: 'u1', label: 'design', kind, count: 3 },
        { key: 'u2', label: 'code', kind, count: 5 },
      ],
    };
    if (!twoLabelCard) return { board, lanes: lanePages };
    // w1 also carries the u2 label, so it renders in both lanes' To Do cells.
    const lanes: Record<string, BoardLanePageDto> = {
      ...lanePages,
      u2: {
        laneKey: 'u2',
        cells: [
          cell('c1', 'u2', [card('w1', 1, 'u2'), card('w4', 4, 'u2')], 6, 'CUR-c1u2'),
          cell('c2', 'u2', [], 0),
        ],
      } as BoardLanePageDto,
    };
    return { board, lanes };
  }

  /** The same board with its lane keys u1/u2 renamed to real enum values — an
   *  enum lane's header draws that value's chip or icon. */
  function rekeyed<T>(fixture: T, l1: string, l2: string): T {
    return JSON.parse(
      JSON.stringify(fixture).replaceAll('"u1"', `"${l1}"`).replaceAll('"u2"', `"${l2}"`),
    ) as T;
  }

  it('a lane-locked grouping refuses a cross-lane drop before applying anything', async () => {
    const fetchSpy = stubFetch(regrouped('reporter'));
    await renderBoard();
    const before = counts();

    await drag('w1', 'w4');

    expect(cardsIn('c1', 'u1')).toEqual(['PROD-1', 'PROD-2']);
    expect(cardsIn('c1', 'u2')).toEqual(['PROD-4']);
    expect(counts()).toEqual(before);
    expect(updateIssueAction).not.toHaveBeenCalled();
    expect(moveCalls(fetchSpy)).toHaveLength(0);

    // A column move inside its own lane is still a transition.
    await drag('w1', 'c2::u1');
    expect(cardsIn('c2', 'u1')).toEqual(['PROD-3', 'PROD-1']);
    expect(moveCalls(fetchSpy)).toHaveLength(1);
  });

  it('a lane-locked grouping leaves every other lane out of the collision', async () => {
    stubFetch(rekeyed(regrouped('kind'), 'task', 'bug'));
    await renderBoard('1 of 5', ['task', 'bug']);
    const rect = { top: 0, left: 0, bottom: 10, right: 10, width: 10, height: 10 };
    const ids = ['c1::task', 'c2::task', 'c1::bug', 'w4', 'w2'];
    const collide = (
      dnd.props as unknown as {
        collisionDetection: (args: unknown) => Array<{ id: string }>;
      }
    ).collisionDetection;
    const hits = collide({
      active: { id: 'w1' },
      collisionRect: rect,
      droppableRects: new Map(ids.map((id) => [id, rect])),
      droppableContainers: ids.map((id) => ({ id })),
      pointerCoordinates: { x: 5, y: 5 },
    });
    expect(hits.map((h) => h.id).sort()).toEqual(['c1::task', 'c2::task', 'w2']);
    // A card in no loaded cell is not filtered.
    const free = collide({
      active: { id: 'zz' },
      collisionRect: rect,
      droppableRects: new Map(ids.map((id) => [id, rect])),
      droppableContainers: ids.map((id) => ({ id })),
      pointerCoordinates: { x: 5, y: 5 },
    });
    expect(free).toHaveLength(ids.length);
  });

  it('a cross-lane grouping keeps every lane in the collision', async () => {
    stubFetch();
    await renderBoard();
    const rect = { top: 0, left: 0, bottom: 10, right: 10, width: 10, height: 10 };
    const ids = ['c1::u1', 'c1::u2', 'w4'];
    const collide = (
      dnd.props as unknown as { collisionDetection: (args: unknown) => Array<{ id: string }> }
    ).collisionDetection;
    const hits = collide({
      active: { id: 'w1' },
      collisionRect: rect,
      droppableRects: new Map(ids.map((id) => [id, rect])),
      droppableContainers: ids.map((id) => ({ id })),
      pointerCoordinates: { x: 5, y: 5 },
    });
    expect(hits).toHaveLength(ids.length);
  });

  it('a type lane drop reassigns the type, never the board move', async () => {
    const fetchSpy = stubFetch(rekeyed(regrouped('type'), 'code', 'design'));
    await renderBoard('1 of 5', ['code', 'design']);

    await drag('w1', 'c1::design');

    expect(cardsIn('c1', 'design')).toEqual(['PROD-4', 'PROD-1']);
    expect(updateIssueAction).toHaveBeenCalledWith({ id: 'w1', type: 'design' });
    expect(moveCalls(fetchSpy)).toHaveLength(0);
  });

  it('a multi-value card moves column in every lane it renders in, and a refusal moves them all back', async () => {
    let refuse!: (r: { status: number; body: unknown }) => void;
    const fetchSpy = stubFetch({
      ...regrouped('label', true),
      move: () => new Promise((resolve) => (refuse = resolve)),
    });
    await renderBoard('2 of 6');
    expect(cardsIn('c1', 'u1')).toEqual(['PROD-1', 'PROD-2']);
    expect(cardsIn('c1', 'u2')).toEqual(['PROD-1', 'PROD-4']);

    act(() => dnd.props!.onDragStart({ active: { id: 'w1@@u2' } }));
    await act(async () => {
      dnd.props!.onDragEnd({ active: { id: 'w1@@u2' }, over: { id: 'c2::u2' } });
    });

    // Optimistically both renderings are in In Progress, the column counted once.
    expect(cardsIn('c2', 'u2')).toEqual(['PROD-1']);
    expect(cardsIn('c2', 'u1')).toEqual(['PROD-3', 'PROD-1']);
    expect(count('board-count-c2')).toBe('2');
    const body = JSON.parse(String(moveCalls(fetchSpy)[0]![1]!.body));
    expect(body).toMatchObject({ workItemId: 'w1', toColumnId: 'c2' });

    // The refusal takes every rendering home.
    await act(async () => refuse({ status: 409, body: { title: 'Refused' } }));
    await waitFor(() => expect(cardsIn('c1', 'u2')).toEqual(['PROD-1', 'PROD-4']));
    expect(cardsIn('c1', 'u1')).toContain('PROD-1');
    expect(cardsIn('c2', 'u1')).toEqual(['PROD-3']);
    expect(count('board-count-c2')).toBe('1');
  });

  it('a multi-value grouping is lane-locked: a drop into another tag lane writes nothing', async () => {
    const fetchSpy = stubFetch(regrouped('label', true));
    await renderBoard('2 of 6');
    await drag('w1@@u1', 'w3');
    expect(cardsIn('c2', 'u1')).toEqual(['PROD-1', 'PROD-3']);
    expect(cardsIn('c2', 'u2')).toEqual(['PROD-1']);
    expect(moveCalls(fetchSpy)).toHaveLength(1);
    updateIssueAction.mockClear();
    await drag('w2', 'c1::u2');
    expect(cardsIn('c1', 'u2')).toEqual(['PROD-4']);
    expect(updateIssueAction).not.toHaveBeenCalled();
  });
});
