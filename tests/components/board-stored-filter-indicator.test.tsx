// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import enMessages from '@/messages/en.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// The board's STORED FILTER indicator (Story MOTIR-10560 · Subtask MOTIR-11335)
// and the board-side empty-state choice it brings. DB-free under happy-dom
// against fabricated frames: the indicator component on its own (every
// condition named, "+N more", match-any, stale marks, label names from the
// read, the admin-only Edit link), then BoardContainer — no new element on a
// frame without a stored filter, the indicator portaled into the page's
// applied-filter row (or inline with no row), kept after the toolbar's Clear, on
// kanban, scrum-with-sprint and the Visitor route, and the filtered-empty state
// for a stored filter that matches nothing.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/boards',
  useSearchParams: () => new URLSearchParams(),
}));
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

import { BoardStoredFilterIndicator } from '@/app/(authed)/boards/_components/BoardStoredFilterIndicator';
import { BoardContainer } from '@/app/(authed)/boards/_components/BoardContainer';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import { ReaderRoutesProvider } from '@/lib/visitor/useReaderRoutes';
import { BOARD_STORED_FILTER_SLOT_ID } from '@/lib/boards/boardSlots';
import { encodeFilterEnvelope, type FilterAst } from '@/lib/filters/ast';
import type {
  BoardCardDto,
  BoardColumnDto,
  BoardProjectionDto,
  SprintSummaryDto,
  StoredBoardFilterDto,
} from '@/lib/dto/boards';

const tb = enMessages.boards;

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

const LOOKUPS = { statuses: [], members: [], sprints: [], customFields: [], components: [] };

function stored(
  ast: FilterAst | null,
  over: Partial<StoredBoardFilterDto> = {},
): StoredBoardFilterDto {
  return {
    envelope: ast ? encodeFilterEnvelope(ast) : null,
    staleConditions: [],
    labels: [],
    ...over,
  };
}

const BUGS: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
};
const THREE: FilterAst = {
  combinator: 'and',
  conditions: [
    { field: 'kind', operator: 'is_any_of', value: ['bug', 'task'] },
    { field: 'lbl', operator: 'is_any_of', value: ['lab-mobile', 'lab-gone'] },
    { field: 'priority', operator: 'is_any_of', value: ['high'] },
  ],
};
const ANY: FilterAst = {
  combinator: 'or',
  conditions: [
    { field: 'kind', operator: 'is_any_of', value: ['bug'] },
    { field: 'lbl', operator: 'is_any_of', value: ['lab-mobile'] },
  ],
};
const MOBILE = [{ id: 'lab-mobile', name: 'mobile' }];

const indicator = () => screen.getByTestId('board-stored-filter-indicator');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('BoardStoredFilterIndicator', () => {
  it('names the conditions as text: two inline, "+N more", every one in the aria-label and title', () => {
    render(
      <BoardStoredFilterIndicator
        storedFilter={stored(THREE, { labels: MOBILE })}
        lookups={LOOKUPS}
      />,
    );
    const box = indicator();
    expect(box.getAttribute('role')).toBe('note');
    expect(box.textContent).toContain(tb.storedFilterIndicatorLabel);
    const full =
      'Kind is any of Bug, Task, Label is any of mobile, Unknown value, Priority is any of High';
    expect(box.getAttribute('aria-label')).toBe(
      `This board shows only the work items that match its filter: ${full}`,
    );
    expect(within(box).getByTitle(full).textContent).toBe(
      'Kind is any of Bug, Task · Label is any of mobile, Unknown value',
    );
    expect(box.textContent).toContain('+1 more');
    // No control: not a chip, nothing to clear or open.
    expect(box.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
  });

  it('names a label that still exists by its name, never its id or the stale text', () => {
    render(
      <BoardStoredFilterIndicator
        storedFilter={stored(
          { combinator: 'and', conditions: [THREE.conditions[1]!] },
          { labels: [...MOBILE, { id: 'lab-gone', name: 'gone-now-back' }] },
        )}
        lookups={LOOKUPS}
      />,
    );
    expect(indicator().textContent).toContain('Label is any of mobile, gone-now-back');
    expect(indicator().textContent).not.toContain('lab-mobile');
    expect(indicator().textContent).not.toContain(enMessages.issueViews.advancedStaleValue);
  });

  it('reads a match-any filter as "any of: … or …"', () => {
    render(
      <BoardStoredFilterIndicator
        storedFilter={stored(ANY, { labels: MOBILE })}
        lookups={LOOKUPS}
      />,
    );
    expect(within(indicator()).getByTitle(/any of:/).textContent).toBe(
      'any of: Kind is any of Bug or Label is any of mobile',
    );
  });

  it('marks a stale condition and still renders the rest', () => {
    render(
      <BoardStoredFilterIndicator
        storedFilter={stored(THREE, {
          labels: MOBILE,
          staleConditions: [{ index: 1, field: 'lbl', reason: 'unknown-value' }],
        })}
        lookups={LOOKUPS}
      />,
    );
    expect(screen.getByRole('img', { name: tb.storedFilterIndicatorStale })).toBeTruthy();
    expect(indicator().textContent).toContain('Kind is any of Bug, Task');
  });

  it('says an unreadable stored filter matches nothing', () => {
    render(
      <BoardStoredFilterIndicator
        storedFilter={stored(null, {
          staleConditions: [{ index: null, field: null, reason: 'invalid' }],
        })}
        lookups={LOOKUPS}
      />,
    );
    expect(indicator().textContent).toContain(tb.storedFilterIndicatorStale);
    expect(indicator().getAttribute('aria-label')).toContain(tb.storedFilterIndicatorStale);
  });

  it('gives a board admin one Edit link to board settings, and nothing else', () => {
    render(
      <BoardStoredFilterIndicator
        storedFilter={stored(BUGS)}
        lookups={LOOKUPS}
        editHref="/settings/project/board?board=b1"
      />,
    );
    const edit = within(indicator()).getByRole('link', { name: tb.storedFilterIndicatorEditAria });
    expect(edit.getAttribute('href')).toBe('/settings/project/board?board=b1');
    expect(edit.textContent).toContain(tb.storedFilterIndicatorEdit);
    expect(indicator().querySelectorAll('button, input')).toHaveLength(0);
    expect(screen.queryByText('+0 more')).toBeNull();
  });
});

// ── BoardContainer ──────────────────────────────────────────────────────────

function card(over: Partial<BoardCardDto> & { id: string; key: number }): BoardCardDto {
  return {
    projectId: 'p1',
    parentId: null,
    kind: 'bug',
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

function frame(over: Partial<BoardProjectionDto> = {}): BoardProjectionDto {
  return {
    boardId: 'b1',
    name: 'Bugs',
    type: 'kanban',
    swimlaneGroupBy: 'none',
    swimlanes: [],
    unmappedStatuses: [],
    sprint: null,
    planHolds: {},
    storedFilter: null,
    columns: [
      column({ id: 'c1', name: 'To Do', totalCount: 1, cards: [card({ id: 'w1', key: 1 })] }),
      column({ id: 'c2', name: 'Done', statusKeys: ['done'] }),
    ],
    ...over,
  };
}

const EMPTY_COLUMNS = [column({ id: 'c1', name: 'To Do' }), column({ id: 'c2', name: 'Done' })];

const sprint: SprintSummaryDto = {
  id: 's1',
  name: 'Mobile sprint',
  goal: null,
  startDate: '2026-11-02T00:00:00.000Z',
  endDate: '2026-11-14T00:00:00.000Z',
  state: 'active',
  daysRemaining: 5,
  points: { committed: 0, completed: 0, remaining: 0 },
  columnPoints: {},
};

function stubFrame(data: BoardProjectionDto) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: unknown) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => (String(url).startsWith('/api/board') ? data : { days: [] }),
      }),
    ),
  );
}

/** The page's applied-filter row: the slot, then a stand-in for the toolbar chips. */
function FilterRow() {
  return (
    <div data-testid="board-filter-row">
      <div id={BOARD_STORED_FILTER_SLOT_ID} className="contents" />
      <span data-testid="toolbar-chips">Assignee is any of Ana</span>
    </div>
  );
}

describe('BoardContainer — the stored-filter indicator', () => {
  it('renders none of the new elements on a frame with no stored filter', async () => {
    stubFrame(frame());
    render(
      <>
        <FilterRow />
        <BoardContainer />
      </>,
    );
    await screen.findByText('Card 1');
    expect(screen.queryByTestId('board-stored-filter-indicator')).toBeNull();
    expect(document.getElementById(BOARD_STORED_FILTER_SLOT_ID)!.childNodes).toHaveLength(0);

    cleanup();
    stubFrame(frame({ columns: EMPTY_COLUMNS }));
    render(<BoardContainer />);
    // The brand-new-board empty state, exactly as today.
    expect(await screen.findByText(tb.emptyTitle)).toBeTruthy();
    expect(screen.queryByTestId('board-filtered-empty')).toBeNull();
  });

  it('portals the indicator into the applied-filter row, before the toolbar chips', async () => {
    stubFrame(frame({ storedFilter: stored(BUGS) }));
    render(
      <>
        <FilterRow />
        <BoardContainer filterActive />
      </>,
    );
    const box = await screen.findByTestId('board-stored-filter-indicator');
    const row = screen.getByTestId('board-filter-row');
    expect(row.contains(box)).toBe(true);
    expect(box.compareDocumentPosition(screen.getByTestId('toolbar-chips'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // A board admin (no provider: every key held) gets the Edit link.
    expect(
      within(box)
        .getByRole('link', { name: tb.storedFilterIndicatorEditAria })
        .getAttribute('href'),
    ).toBe('/settings/project/board?board=b1');
  });

  it('keeps the indicator after the toolbar’s Clear refetches the same stored filter', async () => {
    stubFrame(frame({ storedFilter: stored(BUGS) }));
    const { rerender } = render(<BoardContainer filterActive filterParam="v1:x" />);
    await screen.findByTestId('board-stored-filter-indicator');
    rerender(
      <ToastProvider>
        <BoardContainer filterActive={false} filterParam="" />
      </ToastProvider>,
    );
    await screen.findByText('Card 1');
    expect(screen.getByTestId('board-stored-filter-indicator')).toBeTruthy();
  });

  it('renders inline at the top of the board when the page has no row', async () => {
    stubFrame(frame({ storedFilter: stored(BUGS) }));
    render(<BoardContainer />);
    expect(await screen.findByTestId('board-stored-filter-indicator')).toBeTruthy();
  });

  it('renders on a scrum board with an active sprint', async () => {
    stubFrame(frame({ type: 'scrum', sprint, storedFilter: stored(BUGS) }));
    render(<BoardContainer />);
    await screen.findByTestId('sprint-header');
    expect(screen.getByTestId('board-stored-filter-indicator')).toBeTruthy();
  });

  it('renders for a Visitor on the public board, with no Edit link', async () => {
    stubFrame(frame({ storedFilter: stored(BUGS), columns: EMPTY_COLUMNS }));
    render(
      <ReaderRoutesProvider identifier="ACME">
        <ProjectAccessProvider permissions={['project:browse']}>
          <BoardContainer canEdit={false} />
        </ProjectAccessProvider>
      </ReaderRoutesProvider>,
    );
    const box = await screen.findByTestId('board-stored-filter-indicator');
    expect(within(box).queryByRole('link')).toBeNull();
    const empty = screen.getByTestId('board-filtered-empty');
    expect(empty.textContent).toContain(tb.boardFilterEmptyTitle);
    expect(within(empty).queryByRole('link')).toBeNull();
  });
});

describe('BoardContainer — a stored filter that matches nothing', () => {
  it('shows the filtered-empty state with the board-filter copy and Edit, never the new-board state', async () => {
    stubFrame(frame({ storedFilter: stored(BUGS), columns: EMPTY_COLUMNS }));
    render(<BoardContainer />);
    const empty = await screen.findByTestId('board-filtered-empty');
    expect(empty.textContent).toContain(tb.boardFilterEmptyTitle);
    expect(empty.textContent).toContain(tb.boardFilterEmptyDescription);
    expect(
      within(empty).getByRole('link', { name: tb.boardFilterEmptyEdit }).getAttribute('href'),
    ).toBe('/settings/project/board?board=b1');
    expect(within(empty).queryByText(tb.filteredEmptyClear)).toBeNull();
    expect(screen.queryByText(tb.emptyTitle)).toBeNull();
    expect(screen.getByTestId('board-stored-filter-indicator')).toBeTruthy();
  });

  it('keeps the shipped state and its Clear when a toolbar filter is also active', async () => {
    stubFrame(frame({ storedFilter: stored(BUGS), columns: EMPTY_COLUMNS }));
    render(<BoardContainer filterActive />);
    const empty = await screen.findByTestId('board-filtered-empty');
    expect(empty.textContent).toContain(tb.filteredEmptyTitle);
    expect(within(empty).getByText(tb.filteredEmptyClear)).toBeTruthy();
    expect(screen.getByTestId('board-stored-filter-indicator')).toBeTruthy();
  });
});
