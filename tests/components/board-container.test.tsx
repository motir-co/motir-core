// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// The board's ready state mounts the dnd-kit container, which uses the toast
// context for the snap-back feedback (Subtask 3.2.4) — wrap every render in the
// ToastProvider so that branch mounts (the same way the create/edit modal tests
// do).
function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

// BoardContainer (Subtask 3.2.2) is a pure client consumer of the Story-3.1.6
// board API: it fetches GET /api/board on mount and renders the board-level
// states (loading skeleton / error+retry / no-board / populated column scaffold),
// and a card click opens the quick-view peek by pushing `?peek=<identifier>`.
// Stub next/navigation (the usePeekOpen URL push) + global fetch so the client
// orchestration is testable under happy-dom, DB-free.
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/boards',
  useSearchParams: () => new URLSearchParams(),
}));

// Opening the peek is a SHALLOW URL update (bug 8.8.2) — window.history.pushState,
// not router.push — so the card click asserts against a pushState spy.
const historyPush = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});

// The board's empty-state CTA reuses NewIssueButton → useCreateIssue (Subtask
// 3.2.6); stub the create context so importing BoardContainer doesn't pull the
// real CreateIssueModal + its server action (→ db) into this DB-free unit test.
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

import { BoardContainer } from '@/app/(authed)/boards/_components/BoardContainer';
import type { BoardCardDto, BoardColumnDto, BoardProjectionDto } from '@/lib/dto/boards';

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
    pendingDecision: null,
    planHold: null,
    ...over,
  };
}

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

const projection: BoardProjectionDto = {
  boardId: 'b1',
  name: 'Default',
  type: 'kanban',
  swimlaneGroupBy: 'none',
  swimlanes: [],
  unmappedStatuses: [],
  sprint: null,
  planHolds: {},
  columns: [
    column({
      id: 'c1',
      name: 'To Do',
      totalCount: 2,
      cards: [card({ id: 'w1', key: 1 }), card({ id: 'w2', key: 2 })],
    }),
    column({ id: 'c2', name: 'In Progress', totalCount: 0, cards: [] }),
  ],
};

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
});

describe('BoardContainer', () => {
  it('shows the loading skeleton while the projection streams', () => {
    // A never-resolving fetch keeps it in the loading phase.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    render(<BoardContainer />);
    expect(screen.getByTestId('board-skeleton')).toBeTruthy();
  });

  it('portals the group-by control into the header slot rendered in the SAME commit', async () => {
    // Regression: the group-by control (Subtask 3.7.4 placement) is portaled into
    // the page-header slot `#board-toolbar-groupby-slot`. On a CLIENT navigation
    // the slot is rendered in the same commit as BoardContainer, so a render-time
    // lookup (lazy useState init) misses it → the control vanished. Render the
    // slot as a SIBLING (same commit) and assert the control still appears.
    vi.stubGlobal('fetch', mockFetchOk(projection));
    render(
      <>
        <div id="board-toolbar-groupby-slot" className="contents" />
        <BoardContainer />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.getByRole('group', { name: 'Swimlane group by' })).toBeTruthy();
  });

  it('renders the column scaffold with per-column counts and cards once loaded', async () => {
    vi.stubGlobal('fetch', mockFetchOk(projection));
    render(<BoardContainer />);

    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    // Column counts (the projection totalCount, not the loaded length).
    expect(screen.getByTestId('board-count-c1').textContent).toBe('2');
    expect(screen.getByTestId('board-count-c2').textContent).toBe('0');
    // Cards render in their column.
    expect(screen.getByTestId('board-card-PROD-1')).toBeTruthy();
    expect(screen.getByTestId('board-card-PROD-2')).toBeTruthy();
    // The empty column shows the empty-column placeholder, no cards.
    expect(screen.getByText('No work items')).toBeTruthy();
  });

  it('opens the quick-view peek (pushes ?peek=<identifier>) on a card click', async () => {
    vi.stubGlobal('fetch', mockFetchOk(projection));
    render(<BoardContainer />);

    const cardEl = await screen.findByTestId('board-card-PROD-1');
    fireEvent.click(cardEl);
    expect(historyPush).toHaveBeenCalledWith(null, '', '/boards?peek=PROD-1');
  });

  it('shows the error state with a working retry on a failed fetch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ code: 'OOPS' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => projection });
    vi.stubGlobal('fetch', fetchMock);
    render(<BoardContainer />);

    await waitFor(() => expect(screen.getByText('Couldn’t load the board')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    // Retry re-fetches and reconciles to the populated board.
    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows the defensive no-board state on a 404 BOARD_NOT_FOUND', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ code: 'BOARD_NOT_FOUND' }),
      }),
    );
    render(<BoardContainer />);
    await waitFor(() => expect(screen.getByText('No board yet')).toBeTruthy());
  });
});

// WIP-limit config (Subtask 3.3.6) — setting a limit from the column `[⋯]` menu
// PATCHes `…/board/columns/[id]` (3.3.3), updates the chip optimistically, and
// reconciles to the returned column DTO. Soft over-limit is presentational only
// (the move path is WIP-agnostic — proven live by the 3.3.7 E2E).
describe('BoardContainer — WIP config (3.3.6)', () => {
  function routedFetch(updatedWipLimit: number | null) {
    return vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/board/columns/') && init?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'c1',
            name: 'To Do',
            position: 'a0',
            wipLimit: updatedWipLimit,
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => projection });
    });
  }

  it('PATCHes the column WIP limit and updates the chip optimistically', async () => {
    const fetchMock = routedFetch(4);
    vi.stubGlobal('fetch', fetchMock);
    render(<BoardContainer />);

    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    // Open the To Do (c1) column menu → "Set WIP limit" → enter 4 → Save.
    fireEvent.click(screen.getByTestId('board-column-actions-c1'));
    fireEvent.click(screen.getByText('Set WIP limit'));
    fireEvent.change(screen.getByTestId('board-wip-input-c1'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/board/columns/c1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ wipLimit: 4 }) }),
      ),
    );
    // c1 holds 2 → `2/4`, under-limit/quiet.
    await waitFor(() => expect(screen.getByTestId('board-wip-c1').textContent).toBe('2/4'));
  });
});
