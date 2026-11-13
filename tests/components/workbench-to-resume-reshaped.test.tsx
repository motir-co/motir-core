// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import type {
  GateResumeAttemptDto,
  HomeWorkItemRowDto,
  ResumeGateDto,
  ResumeReshapePlanDto,
  ResumeRunDto,
} from '@/lib/dto/home';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// A To resume entry whose story a plan re-shaped after its run stopped (Bug MOTIR-8458),
// under happy-dom, built to `design/workbench/design-notes.md` § 39: the two member chips,
// the fold's added count, the banner for one plan and for several, the next-step sentence,
// no banner when nothing re-shaped the story, and zh.

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), refresh }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=to-resume'),
}));
const shallowPush = vi.fn();
vi.mock('@/lib/navigation/shallowUrl', () => ({
  shallowPush: (href: string) => shallowPush(href),
  shallowReplace: vi.fn(),
}));

import { WorkbenchList } from '@/app/(authed)/workbench/_components/WorkbenchList';
import { toWorkbenchRowViews } from '@/app/(authed)/workbench/_components/workbenchRows';

afterEach(() => {
  cleanup();
  push.mockReset();
  refresh.mockReset();
  shallowPush.mockReset();
  vi.unstubAllGlobals();
});

const VIEWER = 'u-viewer';
const MEMBERS: WorkspaceMemberDTO[] = [
  {
    userId: VIEWER,
    name: 'Zhu Yue',
    email: 'y@example.com',
    workspaceRole: 'manager',
    customRole: null,
  },
  {
    userId: 'u-dana',
    name: 'Dana P.',
    email: 'd@example.com',
    workspaceRole: 'member',
    customRole: null,
  },
  {
    userId: 'u-mara',
    name: 'Mara S.',
    email: 'm@example.com',
    workspaceRole: 'member',
    customRole: null,
  },
];

const WORKFLOW = {
  statuses: [{ key: 'in_progress', label: 'In Progress', category: 'in_progress' }],
} as unknown as WorkflowDto;

const EMPTY = <p>Nothing to resume</p>;
const AGO = new Date(Date.now() - 2 * 60 * 60_000).toISOString();

function card(identifier: string, over: Partial<HomeWorkItemRowDto> = {}): HomeWorkItemRowDto {
  return {
    id: `wi_${identifier}`,
    kind: 'story',
    type: null,
    key: 1,
    identifier,
    title: `Title of ${identifier}`,
    status: 'in_progress',
    ciState: null,
    fixReason: null,
    fixDetail: null,
    priority: 'medium',
    assigneeId: VIEWER,
    reporterId: VIEWER,
    executor: null,
    storyPoints: null,
    estimateMinutes: null,
    updatedAt: '2026-10-07T00:00:00.000Z',
    completedAt: null,
    project: { id: 'p1', identifier: 'ACME', name: 'Acme' },
    viewerIsAssignee: true,
    viewerIsReporter: false,
    canContinueHosted: false,
    fixGroupKind: null,
    fixMembers: [],
    resumeState: 'waiting_on_gate',
    resumeRunId: 'run_1',
    resumeMembers: [],
    groupHead: null,
    groupMembers: [],
    canFixHosted: false,
    repairRun: null,
    ...over,
  };
}

function gate(subjectKey: string, over: Partial<ResumeGateDto> = {}): ResumeGateDto {
  return {
    gateId: `g_${subjectKey}`,
    kind: 'design_result',
    state: 'awaiting',
    subjectKey,
    subjectTitle: `Gate on ${subjectKey}`,
    deciderId: 'u-dana',
    decidedById: null,
    decidedByLabel: null,
    decidedAt: null,
    notePreview: null,
    ...over,
  };
}

function run(gates: ResumeGateDto[], over: Partial<ResumeRunDto> = {}): ResumeRunDto {
  return {
    ranWhere: 'hosted',
    ranById: 'u-mara',
    ranByName: 'Mara S.',
    agentName: null,
    branch: 'story/ACME-12-quotas',
    gates,
    ...over,
  };
}

function entry(
  key: string,
  resumeRun: ResumeRunDto,
  over: Partial<HomeWorkItemRowDto> = {},
  attempt: GateResumeAttemptDto | null = null,
): HomeWorkItemRowDto {
  return { ...card(key, over), resumeRun, resumeAttempt: attempt };
}

function list(rows: HomeWorkItemRowDto[]) {
  return (
    <WorkbenchList
      rows={toWorkbenchRowViews(rows, WORKFLOW, MEMBERS, false)}
      label="To resume"
      tab="to-resume"
      pagination={{ total: rows.length, page: 1, pageSize: 25 }}
      empty={EMPTY}
      viewerId={VIEWER}
    />
  );
}

const next = (key: string) => screen.getByTestId(`workbench-resume-next-${key}`);

const plan = (id: string, over: Partial<ResumeReshapePlanDto> = {}): ResumeReshapePlanDto => ({
  planId: id,
  title: `Plan ${id}`,
  approvedAt: AGO,
  added: 1,
  changed: 0,
  removed: 0,
  ...over,
});

const member = (key: string, resumeChange: 'added' | 'rescoped' | null) =>
  card(key, { kind: 'subtask', resumeChange });

const banner = (key: string) => screen.getByTestId(`workbench-resume-reshaped-${key}`);

describe('To resume — a story re-shaped after the run stopped (§ 39)', () => {
  it('marks added and re-scoped members, and names the one plan with its counts', () => {
    render(
      list([
        entry('ACME-12', run([gate('ACME-13')]), {
          resumeMembers: [
            member('ACME-13', null),
            member('ACME-14', 'rescoped'),
            member('ACME-15', 'added'),
          ],
          resumeReshapedBy: [plan('pl_q2', { title: 'Quota limits', added: 1, changed: 1 })],
        }),
      ]),
    );
    const chipOf = (key: string) =>
      screen.getByTestId(`workbench-fix-member-${key}`).querySelector('[data-resume-change]');
    expect(chipOf('ACME-13')).toBeNull();
    expect(chipOf('ACME-14')!.textContent).toBe('Re-scoped');
    expect(chipOf('ACME-15')!.textContent).toBe('Added since the run stopped');

    const group = within(banner('ACME-12')).getByRole('group', {
      name: 'Plans that re-shaped ACME-12 after its run stopped',
    });
    expect(group.textContent).toBe(
      'Plan Quota limits (approved 2 hr. ago) re-shaped this story after the run stopped: 1 added, 1 changed',
    );
    expect(within(group).getByRole('link', { name: 'Quota limits' }).getAttribute('href')).toBe(
      '/plans/pl_q2',
    );
    expect(next('ACME-12').textContent).toBe(
      'Once it is approved, this run carries on by itself in Motir agent. Resume will carry the re-shaped story.',
    );
  });

  it('folds two or more plans behind Show plans, oldest first, zero clauses left out', () => {
    render(
      list([
        entry('ACME-12', run([gate('ACME-13')]), {
          resumeReshapedBy: [
            plan('a', { title: 'First', added: 0, removed: 2 }),
            plan('b', { title: 'Second', added: 2, changed: 1 }),
          ],
        }),
      ]),
    );
    const box = banner('ACME-12');
    expect(box.textContent).toContain('2 plans re-shaped this story since the run stopped');
    const toggle = within(box).getByRole('button', { name: 'Show plans' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(box).queryByRole('listitem')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Hide plans');
    expect(
      within(box)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Plan First (approved 2 hr. ago): 2 removed',
      'Plan Second (approved 2 hr. ago): 2 added, 1 changed',
    ]);
  });

  it('counts the added members the fold hides beside its button', () => {
    render(
      list([
        entry('ACME-12', run([gate('ACME-13')]), {
          resumeMembers: [
            member('ACME-13', null),
            member('ACME-14', null),
            member('ACME-15', null),
            member('ACME-16', 'added'),
            member('ACME-17', 'added'),
          ],
          resumeReshapedBy: [plan('p', { added: 2 })],
        }),
      ]),
    );
    expect(screen.getByTestId('workbench-fix-members-added-ACME-12').textContent).toBe(
      '+2 added since the run stopped',
    );
    fireEvent.click(screen.getByTestId('workbench-fix-members-toggle-ACME-12'));
    expect(screen.queryByTestId('workbench-fix-members-added-ACME-12')).toBeNull();
  });

  it('draws no banner, no chip and no extra sentence when nothing re-shaped the story', () => {
    render(
      list([
        entry('ACME-12', run([gate('ACME-13')]), { resumeMembers: [member('ACME-13', null)] }),
      ]),
    );
    expect(screen.queryByTestId('workbench-resume-reshaped-ACME-12')).toBeNull();
    expect(document.querySelector('[data-resume-change]')).toBeNull();
    expect(next('ACME-12').textContent).toBe(
      'Once it is approved, this run carries on by itself in Motir agent.',
    );
  });

  it('reads in zh', () => {
    render(
      list([
        entry('ACME-12', run([gate('ACME-13')]), {
          resumeMembers: [member('ACME-15', 'added')],
          resumeReshapedBy: [plan('p', { title: '配额', added: 1 })],
        }),
      ]),
      { locale: 'zh', messages: zhMessages },
    );
    expect(banner('ACME-12').textContent).toContain('在运行停止后调整了此故事：新增 1 项');
    expect(screen.getByText('运行停止后新增')).toBeTruthy();
    expect(next('ACME-12').textContent).toContain('继续时将带上调整后的故事。');
  });
});
