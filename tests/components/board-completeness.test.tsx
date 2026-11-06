// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// Board completeness (Subtask 3.2.6) — the empty-board state, the
// unmapped-statuses tray (present/absent), and the mobile pager. Like the
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
    cap: 5000,
    truncated: false,
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

describe('over-cap warning banner (3.8.4)', () => {
  const SWIMLANES: BoardSwimlaneDto[] = [
    { key: 'u1', label: 'Ana Ruiz', kind: 'assignee', count: 1 },
  ];

  it('renders the over-cap banner with the cap in the copy when the board is truncated', async () => {
    // The 3.8.2 projection signals `truncated` when the bounded load hit the
    // cap (board total > BOARD_ISSUE_CAP) — the banner mirrors Jira's "maximum
    // viewable issues exceeded — refine your filter" warning and names the cap.
    vi.stubGlobal(
      'fetch',
      mockFetchOk(
        projection({
          truncated: true,
          cap: 5000,
          columns: [column({ id: 'c1', name: 'To Do', totalCount: 7321 })],
        }),
      ),
    );
    render(<BoardContainer />);

    const banner = await screen.findByTestId('board-overcap-banner');
    // The cap is interpolated through the catalog's `{cap, number}` (grouped).
    expect(banner.textContent).toContain('5,000');
    expect(banner.textContent).toContain('refine the board filter');
    // role="status" so the warning is announced when it appears after a fetch.
    expect(banner.getAttribute('role')).toBe('status');
    // The affordance is the disabled Epic-6 filter seam (not an invented control).
    const seam = screen.getByTestId('board-overcap-filter');
    expect((seam as HTMLButtonElement).disabled).toBe(true);
  });

  it('omits the over-cap banner when the board is not truncated', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk(
        projection({
          truncated: false,
          columns: [column({ id: 'c1', name: 'To Do', totalCount: 12 })],
        }),
      ),
    );
    render(<BoardContainer />);

    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.queryByTestId('board-overcap-banner')).toBeNull();
  });

  it('shows the banner above the swimlane layout too (it sits in the container, not a layout)', async () => {
    // The banner is a board-level signal mounted above BoardDnd, so it shows
    // for the swimlane board (group-by ≠ none) exactly as for the flat one.
    vi.stubGlobal(
      'fetch',
      mockFetchOk(
        projection({
          truncated: true,
          cap: 5000,
          swimlaneGroupBy: 'assignee',
          swimlanes: SWIMLANES,
          columns: [
            column({
              id: 'c1',
              name: 'To Do',
              totalCount: 9001,
              cards: [card({ id: 'w1', key: 1, swimlaneKey: 'u1', assigneeId: 'u1' })],
            }),
          ],
        }),
      ),
    );
    render(<BoardContainer />);

    // The swimlane board rendered (the lane label is present)…
    await waitFor(() => expect(screen.getByText('Ana Ruiz')).toBeTruthy());
    // …and the over-cap banner sits above it.
    expect(screen.getByTestId('board-overcap-banner')).toBeTruthy();
  });
});
