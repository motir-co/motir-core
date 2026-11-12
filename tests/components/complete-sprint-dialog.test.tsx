// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { CompleteSprintDialog } from '@/app/(authed)/backlog/_components/CompleteSprintDialog';
import type { StatusByKey } from '@/app/(authed)/backlog/_components/backlogShared';
import type { SprintDto, SprintReportDto } from '@/lib/dto/sprints';
import type { CycleGraphDto } from '@/lib/dto/reports';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { RankedIssuePageDto } from '@/lib/dto/backlog';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import type { PermissionKey } from '@/lib/permissions/catalog';

// Complete-sprint flow UI (Story 4.4 · Subtask 4.4.6). The CompleteSprintDialog
// wires the design's complete modal + carry-over chooser (panels 4–5) and the
// sprint-report success state (panel 6) to the shipped backend (GET
// /api/sprints/[id]/report, POST /api/sprints/[id]/complete). Real Postgres is not
// in scope for a pure-client modal — fetch is stubbed (the convention's single
// allowed UI-unit mock); the dialog renders the real English catalog via
// renderWithIntl.

// The Combobox (carry-over target) anchors a listbox that needs APIs happy-dom omits.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

const statusByKey: StatusByKey = new Map([
  ['done', { key: 'done', label: 'Done', category: 'done' }],
  ['in_progress', { key: 'in_progress', label: 'In progress', category: 'in_progress' }],
  ['todo', { key: 'todo', label: 'To do', category: 'todo' }],
]);

function issue(over: Partial<WorkItemSummaryDto> = {}): WorkItemSummaryDto {
  return {
    id: 'wi1',
    parentId: null,
    kind: 'story',
    key: 241,
    identifier: 'PROD-241',
    title: 'Sprint start flow',
    status: 'done',
    priority: 'medium',
    assigneeId: null,
    position: 'a0',
    estimateMinutes: null,
    storyPoints: 5,
    archivedAt: null,
    obsolescence: null,
    obsolescenceNoteMd: null,
    subject: null,
    ...over,
  };
}

function pageOf(items: WorkItemSummaryDto[], totalCount = items.length): RankedIssuePageDto {
  return { items, nextCursor: null, totalCount };
}

function sprint(over: Partial<SprintDto> = {}): SprintDto {
  return {
    id: 'sp6',
    name: 'Sprint 6',
    goal: 'Ship the sprint lifecycle',
    state: 'active',
    startDate: '2026-06-09T00:00:00.000Z',
    endDate: '2026-06-22T00:00:00.000Z',
    completedAt: null,
    sequence: 6,
    issueCount: 18,
    committedPoints: 42,
    committedIssueCount: 18,
    ...over,
  };
}

function report(over: Partial<SprintReportDto> = {}): SprintReportDto {
  return {
    sprintId: 'sp6',
    state: 'active',
    points: { committed: 42, completed: 29, notCompleted: 13 },
    completed: pageOf(
      [issue({ id: 'c1', identifier: 'PROD-241', title: 'Start flow', status: 'done' })],
      12,
    ),
    incomplete: pageOf(
      [
        issue({
          id: 'i1',
          kind: 'task',
          identifier: 'PROD-244',
          title: 'Report data',
          status: 'in_progress',
          storyPoints: 3,
        }),
      ],
      6,
    ),
    addedAfterStart: 2,
    ...over,
  };
}

function okJson(body: unknown = {}) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
}

// A minimal completed-sprint cycle graph — the success state's chart slot
// (Subtask 4.6.5; reframed 8.14.6) client-fetches GET …/burndown (the path stays
// "burndown"; the body is the cycle DTO) for the just-completed sprint.
function cycle(): CycleGraphDto {
  return {
    sprintId: 'sp6',
    state: 'complete',
    statistic: 'story_points',
    committedAtStart: 42,
    scopeCreepPct: 0,
    startDate: '2026-06-09T00:00:00.000Z',
    endDate: '2026-06-22T00:00:00.000Z',
    days: [
      { date: '2026-06-09', scope: 42, completed: 0, started: 5, target: 42 },
      { date: '2026-06-22', scope: 42, completed: 29, started: 38, target: 0 },
    ],
  };
}

// The default fetch stub: GET …/report → the report fixture; POST …/complete → the
// completed sprint; GET …/burndown → the burndown fixture (the 4.6.5 success-state
// slot). Override per-test for the unestimated / all-complete cases.
let fetchMock: ReturnType<typeof vi.fn>;
let reportBody: SprintReportDto;

function install(reportFixture: SprintReportDto = report()) {
  reportBody = reportFixture;
  fetchMock = vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    if (u.endsWith('/report')) return okJson(reportBody);
    if (u.endsWith('/complete')) return okJson(sprint({ state: 'complete' }));
    if (u.endsWith('/burndown')) return okJson(cycle());
    return okJson({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => install());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderDialog(
  over: { sprint?: SprintDto; plannedSprints?: SprintDto[]; permissions?: PermissionKey[] } = {},
): {
  onCompleted: ReturnType<typeof vi.fn>;
} {
  const onCompleted = vi.fn();
  const dialog = (
    <ToastProvider>
      <CompleteSprintDialog
        open
        onOpenChange={() => {}}
        sprint={over.sprint ?? sprint()}
        projectName="motir"
        plannedSprints={
          over.plannedSprints ?? [sprint({ id: 'sp7', name: 'Sprint 7', state: 'planned' })]
        }
        statusByKey={statusByKey}
        onCompleted={onCompleted}
      />
    </ToastProvider>
  );
  render(
    over.permissions ? (
      <ProjectAccessProvider permissions={over.permissions}>{dialog}</ProjectAccessProvider>
    ) : (
      dialog
    ),
  );
  return { onCompleted };
}

/** The footer primary button — disambiguated from the dialog heading + the radio. */
function completeButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Complete sprint' }) as HTMLButtonElement;
}

describe('CompleteSprintDialog (4.4.6)', () => {
  it('renders the completed/incomplete split + the carry-over chooser', async () => {
    renderDialog();
    // The split summary reads the live report preview.
    expect(await screen.findByText('29 of 42 points')).toBeTruthy();
    expect(screen.getByText('13 points carry over')).toBeTruthy();
    // The carry-over chooser (Backlog default + A future sprint).
    expect(screen.getByText('Move the 6 incomplete work items to')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Backlog/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /A future sprint/ })).toBeTruthy();
    // The report preview fetch happened.
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/sp6/report'))).toBe(true);
  });

  it('collapses the chooser to "all complete" when there are no incomplete work items', async () => {
    install(
      report({
        incomplete: pageOf([], 0),
        points: { committed: 42, completed: 42, notCompleted: 0 },
      }),
    );
    renderDialog();
    expect(await screen.findByText(/All work items are complete/)).toBeTruthy();
    expect(screen.queryByText(/Move the .* incomplete work items to/)).toBeNull();
  });

  it('completes carrying over to the backlog by default', async () => {
    renderDialog();
    await screen.findByText('29 of 42 points');
    fireEvent.click(completeButton());
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/sp6/complete'))).toBe(
        true,
      ),
    );
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/complete'))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.carryOverTo).toBe('backlog');
  });

  it('completes carrying over into a chosen planned sprint', async () => {
    renderDialog();
    await screen.findByText('29 of 42 points');
    // Choose "A future sprint", then pick Sprint 7 in the combobox.
    fireEvent.click(screen.getByRole('radio', { name: /A future sprint/ }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Target sprint' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Sprint 7' }));
    fireEvent.click(completeButton());
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/complete'))).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/complete'))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.carryOverTo).toEqual({ sprintId: 'sp7' });
  });

  it('renders the sprint report on completion (lists + points + scope-change + chart seam)', async () => {
    renderDialog();
    await screen.findByText('29 of 42 points');
    fireEvent.click(completeButton());
    // The success state shows the report (the pre-move snapshot).
    expect(await screen.findByRole('heading', { name: 'Sprint 6 report' })).toBeTruthy();
    expect(screen.getByText(/2 work items added after the sprint started/)).toBeTruthy();
    expect(screen.getByTestId('report-row-PROD-241')).toBeTruthy();
    // The carried-over incomplete row shows its "→ Backlog" destination.
    expect(screen.getByTestId('report-row-PROD-244')).toBeTruthy();
    // The chart slot (4.6.5; cycle graph 8.14.6) client-fetches the just-completed
    // sprint's series and renders the cycle graph in the success state.
    expect(await screen.findByText(/cumulative story points by day/i)).toBeTruthy();
    // The standalone closed-sprint report is reachable from the success state.
    const link = screen.getByRole('link', { name: /Open full report/ });
    expect(link.getAttribute('href')).toBe('/sprints/sp6/report');
  });

  // MOTIR-6175 — reaching this dialog takes `sprint:manage`; the report room asks
  // for `report:view`. A custom role can hold the first without the second, and
  // then the door to the full report is not offered.
  it('offers the full-report door only to an actor who can open the report room', async () => {
    renderDialog({ permissions: ['project:browse', 'sprint:manage'] });
    await screen.findByText('29 of 42 points');
    fireEvent.click(completeButton());
    expect(await screen.findByRole('heading', { name: 'Sprint 6 report' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Open full report/ })).toBeNull();
  });

  it('disables "A future sprint" with a hint when the project has no planned sprint', async () => {
    renderDialog({ plannedSprints: [] });
    await screen.findByText('29 of 42 points');
    const radio = screen.getByRole('radio', { name: /A future sprint/ }) as HTMLButtonElement;
    expect(radio.disabled).toBe(true);
    expect(screen.getByText(/No planned sprint to roll into/)).toBeTruthy();
  });

  it('refetches the backlog only after the success modal closes', async () => {
    const { onCompleted } = renderDialog();
    await screen.findByText('29 of 42 points');
    fireEvent.click(completeButton());
    await screen.findByRole('heading', { name: 'Sprint 6 report' });
    // Not yet — the report is still on screen.
    expect(onCompleted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onCompleted).toHaveBeenCalledTimes(1);

    // Closing the report kicks the refetch; flush it inside act.
    await act(async () => {});
  });
});
