// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// Scrum board UI (Subtask 4.5.3) — the sprint header + per-column point totals +
// the no-active-sprint state, rendered ON TOP of the REUSED 3.2/3.3 board by
// BoardContainer keyed off the projection's `type`/`sprint`. A pure client
// consumer of the 4.5.2 projection (GET /api/board): stub next/navigation +
// CreateIssueProvider + global fetch so the orchestration is testable DB-free,
// exactly like board-container.test.tsx. The header chrome + the resolution are
// the units under test; the board body itself is the proven 3.2/3.3 surface.
function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
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

import { BoardContainer } from '@/app/(authed)/boards/_components/BoardContainer';
import type {
  BoardCardDto,
  BoardColumnDto,
  BoardProjectionDto,
  SprintSummaryDto,
} from '@/lib/dto/boards';
import type { WorkflowDto } from '@/lib/dto/workflows';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';

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

const cols = (): BoardColumnDto[] => [
  column({
    id: 'c1',
    name: 'To Do',
    totalCount: 2,
    cards: [card({ id: 'w1', key: 1 }), card({ id: 'w2', key: 2 })],
  }),
  column({ id: 'c2', name: 'In Progress', totalCount: 1, cards: [card({ id: 'w3', key: 3 })] }),
];

const sprint = (over: Partial<SprintSummaryDto> = {}): SprintSummaryDto => ({
  id: 's1',
  name: 'Sprint 24',
  goal: 'Ship the Auth epic',
  startDate: '2026-06-02T00:00:00.000Z',
  endDate: '2026-06-14T00:00:00.000Z',
  state: 'active',
  daysRemaining: 5,
  points: { committed: 34, completed: 12, remaining: 22 },
  columnPoints: { c1: 13, c2: 8 },
  ...over,
});

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
    columns: cols(),
    ...over,
  };
}

const WORKFLOW: WorkflowDto = { statuses: [], transitions: [], policyMode: 'open' };

// The active sprint's in-sprint cycle graph — the 4.6.5 `SprintHeaderBurndown`
// slot client-fetches GET /api/sprints/[id]/burndown (the path stays "burndown";
// the body is the cycle DTO, Story 8.14) when the header mounts. Every series
// cell is a real number (no `null`/undefined → no "—"), so the 4.5.3 header's
// three "—" assertions stay unambiguous.
const headerBurndown = () => ({
  sprintId: 's1',
  state: 'active' as const,
  statistic: 'story_points' as const,
  committedAtStart: 30,
  scopeCreepPct: 0,
  startDate: '2026-06-02T00:00:00.000Z',
  endDate: '2026-06-14T00:00:00.000Z',
  // Series values deliberately AVOID the header-points fixture numbers (34/12/22)
  // so the header's getByText('12') etc. stay single-match.
  days: [
    { date: '2026-06-02', scope: 30, completed: 0, started: 6, target: 30 },
    { date: '2026-06-06', scope: 30, completed: 7, started: 19, target: 18 },
    { date: '2026-06-14', scope: 30, completed: 25, started: 28, target: 6 },
  ],
});

function mockFetchOk(data: BoardProjectionDto) {
  // Route by URL: the board projection for /api/board, the burndown for the
  // header's chart slot; everything else gets the projection (legacy default).
  return vi.fn().mockImplementation((url: unknown) => {
    const body = String(url).includes('/burndown') ? headerBurndown() : data;
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.useRealTimers();
});

describe('Scrum board (4.5.3) — page resolution', () => {
  it('renders the Kanban view with NO sprint header / point pills when type=kanban', async () => {
    vi.stubGlobal('fetch', mockFetchOk(projection({ type: 'kanban', sprint: null })));
    render(<BoardContainer projectName="Motir" workflow={WORKFLOW} />);
    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.queryByTestId('sprint-header')).toBeNull();
    expect(screen.queryByTestId('board-points-c1')).toBeNull();
  });

  it('renders the sprint header + the board when type=scrum with an active sprint', async () => {
    vi.stubGlobal('fetch', mockFetchOk(projection({ type: 'scrum', sprint: sprint() })));
    render(<BoardContainer projectName="Motir" workflow={WORKFLOW} />);
    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.getByTestId('sprint-header')).toBeTruthy();
  });
});

describe('Scrum board (4.5.3) — sprint header', () => {
  it('shows name, state, goal, time remaining and the committed/completed/remaining points', async () => {
    vi.stubGlobal('fetch', mockFetchOk(projection({ type: 'scrum', sprint: sprint() })));
    render(<BoardContainer projectName="Motir" workflow={WORKFLOW} />);
    const header = await screen.findByTestId('sprint-header');
    const h = within(header);
    expect(h.getByText('Sprint 24')).toBeTruthy();
    expect(h.getByText('Active')).toBeTruthy();
    expect(h.getByText(/Ship the Auth epic/)).toBeTruthy();
    expect(h.getByText('5 days remaining')).toBeTruthy();
    // Points summary — committed / completed / remaining as labelled numbers.
    expect(h.getByText('34')).toBeTruthy();
    expect(h.getByText('12')).toBeTruthy();
    expect(h.getByText('22')).toBeTruthy();
    expect(h.getByText('Committed')).toBeTruthy();
    // "Remaining" is the stat label AND the 4.6.5 burndown table's column head.
    expect(h.getAllByText('Remaining').length).toBeGreaterThanOrEqual(1);
    // The Complete-sprint entry point is mounted (the 4.4 flow opens on click).
    expect(h.getByTestId('scrum-complete-sprint')).toBeTruthy();
  });

  it('shows the "Ended" treatment when daysRemaining is 0', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk(projection({ type: 'scrum', sprint: sprint({ daysRemaining: 0 }) })),
    );
    render(<BoardContainer projectName="Motir" workflow={WORKFLOW} />);
    const header = await screen.findByTestId('sprint-header');
    expect(within(header).getByText('Ended')).toBeTruthy();
    expect(within(header).queryByText(/days remaining/)).toBeNull();
  });

  it('renders "—" for every point figure on a wholly unestimated sprint (no NaN)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk(
        projection({
          type: 'scrum',
          sprint: sprint({ points: { committed: 0, completed: 0, remaining: 0 } }),
        }),
      ),
    );
    render(<BoardContainer projectName="Motir" workflow={WORKFLOW} />);
    const header = await screen.findByTestId('sprint-header');
    expect(within(header).getAllByText('—').length).toBe(3);
    // Unestimated → no per-column point pills (they'd all read "0 pts").
    expect(screen.queryByTestId('board-points-c1')).toBeNull();
  });

  // MOTIR-6174 — the entry is gated on `sprint:manage`, the key `completeSprint`
  // asserts, not on `work_item:edit`: the built-in roles pair the two, a custom
  // role need not, and the case that tells them apart is the one below.
  it.each([
    ['a Viewer (browse + report:view)', ['project:browse', 'report:view'], false],
    [
      'an editor WITHOUT sprint:manage (a custom role)',
      ['project:browse', 'work_item:edit'],
      false,
    ],
    ['a Member (holds sprint:manage)', ['project:browse', 'work_item:edit', 'sprint:manage'], true],
  ] as const)('the Complete-sprint entry for %s', async (_who, permissions, shown) => {
    vi.stubGlobal('fetch', mockFetchOk(projection({ type: 'scrum', sprint: sprint() })));
    render(
      <ProjectAccessProvider permissions={[...permissions]}>
        <BoardContainer
          projectName="Motir"
          workflow={WORKFLOW}
          canEdit={permissions.includes('work_item:edit' as never)}
        />
      </ProjectAccessProvider>,
    );
    await screen.findByTestId('sprint-header');
    expect(screen.queryByTestId('scrum-complete-sprint') !== null).toBe(shown);
  });
});

describe('Scrum board (4.5.3) — per-column point totals', () => {
  it('renders the "N pts" pill in each column header for an estimated sprint', async () => {
    vi.stubGlobal('fetch', mockFetchOk(projection({ type: 'scrum', sprint: sprint() })));
    render(<BoardContainer projectName="Motir" workflow={WORKFLOW} />);
    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.getByTestId('board-points-c1').textContent).toBe('13 pts');
    expect(screen.getByTestId('board-points-c2').textContent).toBe('8 pts');
    // The card-count badge still renders alongside the new point pill.
    expect(screen.getByTestId('board-count-c1').textContent).toBe('2');
  });
});

describe('Scrum board (4.5.3) — no active sprint', () => {
  it('replaces the board with the "No active sprint" state + a Backlog CTA', async () => {
    vi.stubGlobal('fetch', mockFetchOk(projection({ type: 'scrum', sprint: null })));
    render(<BoardContainer projectName="Motir" workflow={WORKFLOW} />);
    await waitFor(() => expect(screen.getByText('No active sprint')).toBeTruthy());
    // The board itself is NOT rendered (no empty six-column board).
    expect(screen.queryByTestId('board')).toBeNull();
    expect(screen.queryByTestId('sprint-header')).toBeNull();
    const cta = screen.getByRole('link', { name: /Go to Backlog/ });
    expect(cta.getAttribute('href')).toBe('/backlog');
  });

  it('does NOT show the no-active-sprint state for a kanban board with no sprint', async () => {
    vi.stubGlobal('fetch', mockFetchOk(projection({ type: 'kanban', sprint: null })));
    render(<BoardContainer projectName="Motir" workflow={WORKFLOW} />);
    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.queryByText('No active sprint')).toBeNull();
  });
});

// ── MOTIR-6174 — the board offers no write to an actor without its key ─────────
// Each case renders through the layout's own `ProjectAccessProvider` with the
// permission SET an actor resolves to, never the provider-less default (which
// answers every key true and would make a Viewer case vacuous).
describe('the board’s permission-gated controls (MOTIR-6174)', () => {
  const VIEWER = ['project:browse', 'report:view'] as const;
  const MEMBER = ['project:browse', 'work_item:edit', 'sprint:manage', 'report:view'] as const;
  const CONFIGURER = [...MEMBER, 'board:configure'] as const;

  function renderAs(permissions: readonly string[]) {
    vi.stubGlobal('fetch', mockFetchOk(projection()));
    return render(
      <ProjectAccessProvider permissions={[...permissions] as never}>
        <div id="board-toolbar-groupby-slot" className="contents" />
        <BoardContainer
          projectName="Motir"
          workflow={WORKFLOW}
          canEdit={permissions.includes('work_item:edit')}
        />
      </ProjectAccessProvider>,
    );
  }

  it('a Viewer reads the read-only banner as COPY, not as the i18n key it used to render', async () => {
    renderAs(VIEWER);
    const banner = await screen.findByText(
      'Read-only access — you can view this board but can’t move or edit work items.',
    );
    expect(banner.getAttribute('role')).toBe('status');
    expect(screen.queryByText(/boards\.readOnlyBoardBanner/)).toBeNull();
  });

  it.each([
    ['a Viewer', VIEWER, false],
    ['a Member (no board:configure — the server refuses them)', MEMBER, false],
    ['a board configurer', CONFIGURER, true],
  ] as const)('the Group-by control for %s', async (_who, permissions, live) => {
    renderAs(permissions);
    const group = await screen.findByRole('group', { name: 'Swimlane group by' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(!live);
  });

  it.each([
    ['a Viewer', VIEWER, false],
    ['a Member', MEMBER, false],
    ['a board configurer', CONFIGURER, true],
  ] as const)(
    'the column ⋯ menu (Set WIP limit · Board settings) for %s',
    async (_who, permissions, shown) => {
      renderAs(permissions);
      await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
      expect(screen.queryAllByRole('button', { name: 'Column actions' }).length > 0).toBe(shown);
    },
  );
});
