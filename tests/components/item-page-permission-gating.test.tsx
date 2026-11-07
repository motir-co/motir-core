// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { PermissionKey } from '@/lib/permissions/catalog';

// MOTIR-6173 — the work item page and the quick view offer NO editor an actor
// cannot use (Story MOTIR-6166; the permission-gated UI rule's part 2 in
// `design/projects/design-notes.md`, treatment-table row 6).
//
// The defect is MOTIR-4822: a project Viewer opened the Work type field, the
// picker mounted with `autoOpen` + `disabled`, the menu opened anyway, and the
// pick reached `updateIssueAction`, which the server refused. The fix has two
// halves and this file pins both:
//
//   1. THE PRIMITIVES — a disabled `Combobox` / `DatePicker` never opens, not even
//      from `autoOpen`, and a pick on one is refused.
//   2. THE RAIL — for an actor without `work_item:edit`, every field card keeps
//      its chevron DISABLED, carrying the reason in its accessible name, and
//      pressing it mounts no editor at all. A Member keeps every editor.
//
// The two actors are the permission SETS a Viewer and a Member resolve to
// (`BUILTIN_ROLE_PERMISSIONS`), handed to the same `ProjectAccessProvider` the
// authed layout mounts — never the provider-less default, which answers `true`
// for every key and would make the Viewer half vacuous.

const { updateIssueAction, changeStatusAction, setWorkItemSprint } = vi.hoisted(() => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
  setWorkItemSprint: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction,
  changeStatusAction,
  getWorkItemPlacementAction: vi.fn(),
  fileWorkItemAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/items/PROD-7',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/issues/actions/workItemActionsClient', () => ({ setWorkItemSprint }));
vi.mock('@/app/(authed)/items/actions', () => ({
  listCandidateParentsAction: vi.fn().mockResolvedValue({ ok: true, candidates: [] }),
  listProjectFoldersAction: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/customFieldActions', () => ({
  setCustomFieldValueAction: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/labelComponentActions', () => ({
  addLabelAction: vi.fn(),
  removeLabelAction: vi.fn(),
  addComponentAction: vi.fn(),
  removeComponentAction: vi.fn(),
}));

import { CoreFieldsPanel } from '@/app/(authed)/items/[key]/_components/CoreFieldsPanel';
import { IssueQuickViewPanel } from '@/app/(authed)/items/_components/IssueQuickViewPanel';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import { EstimationConfigProvider } from '@/components/issues/EstimationConfigProvider';
import { Combobox } from '@/components/ui/Combobox';
import { DatePicker } from '@motir/design-system';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';

const VIEWER: PermissionKey[] = [...BUILTIN_ROLE_PERMISSIONS.viewer];
const MEMBER: PermissionKey[] = [...BUILTIN_ROLE_PERMISSIONS.member];
const REASON = 'You have read-only access to this project';

const workflow: WorkflowDto = {
  statuses: [
    {
      id: 's1',
      projectId: 'p1',
      key: 'todo',
      label: 'To Do',
      category: 'todo',
      color: null,
      position: 'a0',
      isInitial: true,
    },
    {
      id: 's2',
      projectId: 'p1',
      key: 'in_progress',
      label: 'In Progress',
      category: 'in_progress',
      color: null,
      position: 'a1',
      isInitial: false,
    },
  ],
  transitions: [],
  policyMode: 'open',
};

function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: 'wi_1',
    projectId: 'p1',
    parentId: null,
    kind: 'subtask',
    key: 7,
    identifier: 'PROD-7',
    title: 'Reorder the lock acquisition',
    descriptionMd: null,
    explanationMd: null,
    explanationSource: 'user_authored',
    languages: { title: null, description: null, explanation: null },
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    reporterId: 'u_r',
    dueDate: '2026-10-01T00:00:00.000Z',
    estimateMinutes: 30,
    type: 'code',
    executor: 'coding_agent',
    difficulty: 'low',
    storyPoints: null,
    position: 'a0',
    sprintId: null,
    backlogRank: 'a0',
    publicChildrenHidden: false,
    sessionBranch: null,
    targetRepo: null,
    targetRepos: [],
    planningSource: null,
    planningHarness: null,
    planningModel: null,
    implementationSource: null,
    implementationHarness: null,
    implementationModel: null,
    subject: null,
    archivedAt: null,
    obsolescence: null,
    obsolescenceNoteMd: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

function renderRail(permissions: PermissionKey[], item = makeItem()) {
  return renderWithIntl(
    <ProjectAccessProvider permissions={permissions}>
      <CoreFieldsPanel
        item={item}
        members={[]}
        workflow={workflow}
        parent={null}
        sprints={[{ id: 'sp1', name: 'Sprint 1', state: 'active' } as never]}
      />
    </ProjectAccessProvider>,
  );
}

/** Anything that is an OPEN editor: a menu, a calendar, a segmented editor, a dialog. */
function openEditors() {
  return document.querySelectorAll(
    '[role="listbox"], [role="grid"], [role="dialog"], [role="group"], [role="menu"]',
  );
}

beforeEach(() => {
  updateIssueAction.mockResolvedValue({ ok: true, updatedAt: '2026-09-03T00:00:00.000Z' });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the primitives — disabled never opens, `autoOpen` included (the MOTIR-4822 mechanism)', () => {
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
  ];

  it('a disabled Combobox mounted with autoOpen renders no listbox, and an enabled one does', () => {
    const onChange = vi.fn();
    const { rerender } = renderWithIntl(
      <Combobox label="Pick" options={options} value="a" onChange={onChange} autoOpen disabled />,
    );
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('option')).toBeNull();
    // Pressing the (disabled) trigger does not open it either.
    fireEvent.click(screen.getByRole('combobox', { name: 'Pick' }));
    expect(screen.queryByRole('listbox')).toBeNull();

    rerender(<Combobox label="Pick" options={options} value="a" onChange={onChange} autoOpen />);
    // Same instance, now enabled: the initial `autoOpen` was consumed at mount, so
    // opening it is an explicit act — and it works.
    fireEvent.click(screen.getByRole('combobox', { name: 'Pick' }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('an enabled Combobox mounted with autoOpen opens at once (the Member path is unchanged)', () => {
    renderWithIntl(
      <Combobox label="Pick" options={options} value="a" onChange={vi.fn()} autoOpen />,
    );
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('a disabled DatePicker mounted with autoOpen renders no calendar; an enabled one does', () => {
    const { unmount } = renderWithIntl(
      <DatePicker value="2026-10-01" onChange={vi.fn()} aria-label="Due date" autoOpen disabled />,
    );
    expect(screen.queryByRole('grid')).toBeNull();
    unmount();
    renderWithIntl(
      <DatePicker value="2026-10-01" onChange={vi.fn()} aria-label="Due date" autoOpen />,
    );
    expect(screen.getByRole('grid')).toBeTruthy();
  });
});

describe('the work item page rail — as a project VIEWER', () => {
  it('draws no "Edit <field>" chevron: every one is disabled and says why', () => {
    renderRail(VIEWER);
    expect(screen.queryAllByRole('button', { name: /^Edit / })).toHaveLength(0);
    const disabled = screen.getAllByRole('button', { name: new RegExp(`— ${REASON}$`) });
    // Status, Type, Work type, Executor, Difficulty, Priority, Assignee, Parent,
    // Due date, Sprint and Estimate — every card a Member can open.
    const fields = disabled.map((b) => b.getAttribute('aria-label')!.split(' — ')[0]);
    expect(fields).toEqual(
      expect.arrayContaining([
        'Status',
        'Type',
        'Work type',
        'Executor',
        'Difficulty',
        'Priority',
        'Assignee',
        'Parent',
        'Due date',
        'Sprint',
        'Estimate',
      ]),
    );
    for (const b of disabled) expect(b.getAttribute('aria-disabled')).toBe('true');
  });

  it('pressing any of them opens nothing and saves nothing — the MOTIR-4822 path cannot be performed', async () => {
    renderRail(VIEWER);
    for (const b of screen.getAllByRole('button', { name: new RegExp(`— ${REASON}$`) })) {
      await act(async () => {
        fireEvent.click(b);
        fireEvent.keyDown(b, { key: 'Enter' });
      });
      expect(openEditors()).toHaveLength(0);
    }
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(updateIssueAction).not.toHaveBeenCalled();
    expect(changeStatusAction).not.toHaveBeenCalled();
    expect(setWorkItemSprint).not.toHaveBeenCalled();
  });

  it('every button left in the rail is disabled or a READ — no "Set …" affordance survives for an unset field', () => {
    renderRail(VIEWER, makeItem({ type: null, executor: null, difficulty: null, dueDate: null }));
    // The rail's only enabled buttons are READS: the Provenance disclosure opens
    // who planned and built the card, and writes nothing. Named, so a new live
    // write control fails here rather than hiding in a count.
    const READS = new Set(['Provenance']);
    const live = within(document.body)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-disabled') !== 'true')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '');
    expect(live.filter((name) => !READS.has(name))).toEqual([]);
    expect(screen.queryByRole('button', { name: /^Set / })).toBeNull();
  });
});

describe('the work item page rail — as a project MEMBER, nothing is taken away', () => {
  it('every field keeps its live "Edit <field>" chevron and no disabled reason', () => {
    renderRail(MEMBER);
    for (const name of ['Status', 'Type', 'Work type', 'Priority', 'Due date', 'Estimate']) {
      const b = screen.getByRole('button', { name: `Edit ${name}` });
      expect(b.getAttribute('aria-disabled')).toBeNull();
    }
    expect(screen.queryAllByRole('button', { name: new RegExp(REASON) })).toHaveLength(0);
  });

  it('the Work type picker opens with its options and a pick saves', async () => {
    renderRail(MEMBER);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Work type' }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    const design = screen.getByRole('option', { name: /Design/ });
    await act(async () => {
      fireEvent.click(design);
    });
    expect(updateIssueAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'design' }));
  });

  it('pressing a live chevron does not steal focus (its mouse-down is swallowed)', () => {
    renderRail(MEMBER);
    const chevron = screen.getByRole('button', { name: 'Edit Priority' });
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    chevron.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('the Due date picker opens its calendar', () => {
    renderRail(MEMBER);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Due date' }));
    expect(screen.getByRole('grid')).toBeTruthy();
  });
});

// ── The quick view ─────────────────────────────────────────────────────────────

const DATA: QuickViewData = {
  folderId: null,
  folderPath: [],
  id: 'cmqvitem00000000000000p7',
  identifier: 'PROD-7',
  title: 'Reorder the lock acquisition',
  projectIdentifier: 'PROD',
  workItemRefs: {},
  kind: 'subtask',
  statusLabel: 'To Do',
  statusCategory: 'todo',
  fixReason: null,
  descriptionMd: null,
  explanationMd: null,
  type: 'code',
  executor: 'coding_agent',
  difficulty: 'low',
  obsolescence: null,
  obsolescenceNoteMd: null,
  assigneeName: null,
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: null,
  sprintName: null,
  storyPoints: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  archived: null,
  parent: null,
  readiness: null,
  pullRequests: [],
  repoDelivery: [],
  deliveries: [],
  hasChildren: false,
  canPlan: true,
  status: 'todo',
  assigneeId: null,
  parentId: null,
  sprintId: null,
  dueDate: null,
  estimateMinutes: null,
  workflow,
  members: [],
  sprints: [],
  projectComponents: [],
  estimation: {
    estimationStatistic: 'story_points' as const,
    pointScale: 'fibonacci' as const,
    customScaleValues: [],
    canEdit: true,
  },
};

function renderQuickView(permissions: PermissionKey[]) {
  return renderWithIntl(
    <ProjectAccessProvider permissions={permissions}>
      <IssueQuickViewPanel state="ready" data={DATA} />
    </ProjectAccessProvider>,
  );
}

describe('the quick view rail', () => {
  it('as a VIEWER: every editable row keeps a DISABLED chevron with the reason, and opens nothing', async () => {
    renderQuickView(VIEWER);
    expect(screen.queryAllByRole('button', { name: /^Edit / })).toHaveLength(0);
    const disabled = screen.getAllByRole('button', { name: new RegExp(`— ${REASON}$`) });
    const fields = disabled.map((b) => b.getAttribute('aria-label')!.split(' — ')[0]);
    expect(fields).toEqual(expect.arrayContaining(['Status', 'Priority', 'Assignee']));
    for (const b of disabled) {
      expect(b.getAttribute('aria-disabled')).toBe('true');
      await act(async () => {
        fireEvent.click(b);
      });
      expect(screen.queryAllByRole('listbox')).toHaveLength(0);
    }
    expect(updateIssueAction).not.toHaveBeenCalled();
  });

  it('as a MEMBER: the same rows carry live "Edit" chevrons and no reason', () => {
    renderQuickView(MEMBER);
    expect(screen.getAllByRole('button', { name: /^Edit / }).length).toBeGreaterThan(2);
    expect(screen.queryAllByRole('button', { name: new RegExp(REASON) })).toHaveLength(0);
  });
});

// ── MOTIR-6338 — Story points, the one rail field MOTIR-6173 missed ───────────
//
// The story-points badge IS its own edit affordance, so for a Member its card
// has no chevron. For a Viewer the badge falls to its static chip, and before
// this fix the card then said nothing — thirteen fields gave the read-only
// reason and this one read as a field nobody edits. Both surfaces now draw the
// disabled chevron with the reason for an actor without `work_item:edit`.

const STORY_POINTS_REASON = `Story points — ${REASON}`;
const ESTIMATION = {
  estimationStatistic: 'story_points' as const,
  pointScale: 'fibonacci' as const,
  customScaleValues: [],
};

/** The rail as the item page mounts it: inside the page's estimation provider,
 *  whose `canEdit` is the same `work_item:edit` the access provider resolves. */
function renderRailWithEstimation(permissions: PermissionKey[]) {
  const canEdit = permissions.includes('work_item:edit');
  return renderWithIntl(
    <ProjectAccessProvider permissions={permissions}>
      <EstimationConfigProvider config={ESTIMATION} canEdit={canEdit}>
        <CoreFieldsPanel
          item={makeItem({ storyPoints: 5 })}
          members={[]}
          workflow={workflow}
          parent={null}
          sprints={[]}
        />
      </EstimationConfigProvider>
    </ProjectAccessProvider>,
  );
}

/** The peek, with the payload's estimation `canEdit` a real server would send. */
function renderQuickViewWithPoints(permissions: PermissionKey[]) {
  const canEdit = permissions.includes('work_item:edit');
  return renderWithIntl(
    <ProjectAccessProvider permissions={permissions}>
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, storyPoints: 5, estimation: { ...ESTIMATION, canEdit } }}
      />
    </ProjectAccessProvider>,
  );
}

describe.each([
  ['the work item page rail', renderRailWithEstimation],
  ['the quick view rail', renderQuickViewWithPoints],
])('%s — the Story points field (MOTIR-6338)', (_surface, render) => {
  it('as a VIEWER: a disabled chevron carries the reason, and pressing it opens nothing', async () => {
    render(VIEWER);
    const chevron = screen.getByRole('button', { name: STORY_POINTS_REASON });
    expect(chevron.getAttribute('aria-disabled')).toBe('true');
    expect(chevron.hasAttribute('data-read-only-field')).toBe(true);
    // The value is still shown — as the badge's static chip, not its editor.
    expect(screen.getByLabelText('Estimate: 5')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Story points: 5 — edit' })).toBeNull();
    await act(async () => {
      fireEvent.click(chevron);
      fireEvent.keyDown(chevron, { key: 'Enter' });
    });
    expect(openEditors()).toHaveLength(0);
  });

  it('as a MEMBER: no chevron and no reason — the badge is the affordance and opens the scale deck', async () => {
    render(MEMBER);
    expect(screen.queryByRole('button', { name: STORY_POINTS_REASON })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Story points —/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Story points: 5 — edit' }));
    });
    expect(screen.getByRole('dialog', { name: /story points/i })).toBeTruthy();
  });
});
