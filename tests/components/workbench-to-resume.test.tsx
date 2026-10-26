// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import type {
  GateResumeAttemptDto,
  HomeWorkItemRowDto,
  ResumeGateDto,
  ResumeRunDto,
} from '@/lib/dto/home';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// The To resume tab's ENTRIES (Story MOTIR-7701 · MOTIR-7712), under happy-dom, built
// to `design/workbench/design-notes.md` § 35: line 2 in each of the five states
// (Panels 1, 3–7), the gate list and its doors, the next-step line, the cards waiting
// with the head, the Resuming hold, and zh.

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
import { resumeLineStateOf } from '@/app/(authed)/workbench/_components/WorkbenchResumeLine';
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

const line = (key: string) => screen.getByTestId(`workbench-resume-${key}`);
const gates = (key: string) => screen.getByTestId(`workbench-resume-gates-${key}`);
const next = (key: string) => screen.getByTestId(`workbench-resume-next-${key}`);

function stubModels() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/hosted-runs/models') {
      return new Response(
        JSON.stringify({ models: [{ id: 'sonnet', provider: 'anthropic' }], default: 'sonnet' }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 201 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('To resume — waiting on a gate (§ 35.5, Panels 1–2)', () => {
  it('line 2 names the wait, who ran it and where, the branch and the cards waiting with it', () => {
    render(
      list([
        entry('ACME-12', run([gate('ACME-13')]), {
          resumeMembers: [card('ACME-13'), card('ACME-14')],
        }),
      ]),
    );
    expect(line('ACME-12').dataset.resumeState).toBe('waiting');
    expect(line('ACME-12').textContent).toContain('Stopped at a gate · waiting on 1 approval');
    expect(screen.getByTestId('workbench-resume-aside-ACME-12').textContent).toBe(
      ' · Mara S. ran it on the hosted agent · branch story/ACME-12-quotas · 2 more work items in this run',
    );
    // No repair: the claim refuses `gate_awaiting`.
    expect(within(line('ACME-12')).queryByText(/motir continue/)).toBeNull();
    expect(next('ACME-12').textContent).toBe(
      'Once it is approved, this run carries on by itself on the hosted agent.',
    );
    // The members, labelled as waiting rather than stuck.
    expect(screen.getByRole('list', { name: 'Work items waiting with ACME-12' })).toBeTruthy();
  });

  it('one line per held gate: kind, key, title, decider, state, and an Open link for someone else’s', () => {
    render(list([entry('ACME-12', run([gate('ACME-13')]))]));
    const row = screen.getByTestId('workbench-resume-gate-ACME-13');
    expect(screen.getByRole('list', { name: "Gates holding ACME-12's run" })).toBeTruthy();
    expect(row.textContent).toContain('Design result');
    expect(row.textContent).toContain('ACME-13');
    expect(row.textContent).toContain('Gate on ACME-13');
    expect(row.textContent).toContain('Dana P. decides');
    expect(row.textContent).toContain('Awaiting');

    const open = screen.getByTestId('workbench-resume-gate-open-ACME-13');
    expect(open.getAttribute('href')).toBe(
      '/workbench?tab=to-resume&approval=ACME-13&approvalKind=design_result',
    );
    fireEvent.click(open);
    expect(shallowPush).toHaveBeenCalledWith(
      '/workbench?tab=to-resume&approval=ACME-13&approvalKind=design_result',
    );
  });

  it('the viewer’s own gate reads “You decide”, “Awaiting you”, and is a Review button', () => {
    render(
      list([
        entry('ACME-40', run([gate('ACME-41', { kind: 'decision_approval', deciderId: VIEWER })])),
      ]),
    );
    const row = screen.getByTestId('workbench-resume-gate-ACME-41');
    expect(row.textContent).toContain('You decide');
    expect(row.textContent).toContain('Awaiting you');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(shallowPush).toHaveBeenCalledWith(
      '/workbench?tab=to-resume&approval=ACME-41&approvalKind=decision_approval',
    );
  });

  it('a manual-work gate the viewer owns offers Guide me through', () => {
    render(
      list([entry('ACME-50', run([gate('ACME-51', { kind: 'manual_work', deciderId: VIEWER })]))]),
    );
    expect(screen.getByRole('button', { name: 'Guide me through' })).toBeTruthy();
  });

  it('a modified click leaves the browser to open the link itself', () => {
    render(list([entry('ACME-12', run([gate('ACME-13')]))]));
    fireEvent.click(screen.getByTestId('workbench-resume-gate-open-ACME-13'), { metaKey: true });
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('a run not on the hosted agent waits for the terminal, and several gates say so', () => {
    render(
      list([
        entry(
          'ACME-60',
          run([gate('ACME-61')], { ranWhere: 'terminal', ranById: VIEWER, branch: null }),
        ),
        entry('ACME-70', run([gate('ACME-71'), gate('ACME-72')]), { resumeRunId: 'run_2' }),
      ]),
    );
    expect(screen.getByTestId('workbench-resume-aside-ACME-60').textContent).toBe(
      ' · you ran it from a terminal',
    );
    expect(next('ACME-60').textContent).toBe(
      'Once you approve it, continue the run from your terminal — the command appears here.',
    );
    expect(line('ACME-70').textContent).toContain('waiting on 2 approvals');
    expect(next('ACME-70').textContent).toBe(
      'When any one is approved, this run carries on by itself on the hosted agent and stops again at the rest.',
    );
  });

  it.each([
    ['runbook', 'Mara S. ran it with the runbook'],
    ['instance', 'Mara S. ran it in dev-box'],
  ] as const)('a %s run names where it ran', (ranWhere, text) => {
    render(list([entry('ACME-80', run([gate('ACME-81')], { ranWhere, agentName: 'dev-box' }))]));
    expect(screen.getByTestId('workbench-resume-aside-ACME-80').textContent).toContain(text);
  });
});

describe('To resume — ready to resume (§ 35.5, Panels 3 and 7)', () => {
  const approved = (key: string, over: Partial<ResumeGateDto> = {}) =>
    gate(key, { state: 'approved', decidedById: 'u-dana', decidedAt: AGO, ...over });

  it('names who approved what, offers the command, and says what continuing does', () => {
    render(
      list([
        entry('ACME-12', run([approved('ACME-13')], { ranWhere: 'terminal' }), {
          resumeState: 'ready_to_resume',
        }),
      ]),
    );
    expect(line('ACME-12').dataset.resumeState).toBe('ready');
    expect(line('ACME-12').textContent).toMatch(
      /Ready to resume · Dana P\. approved the design result on ACME-13 .+ago/,
    );
    expect(within(line('ACME-12')).getByText('motir continue ACME-12')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Copy the resume command for ACME-12' }),
    ).toBeTruthy();
    const row = screen.getByTestId('workbench-resume-gate-ACME-13');
    expect(row.textContent).toContain('Approved');
    expect(row.textContent).toMatch(/approved by Dana P\./);
    expect(next('ACME-12').textContent).toBe(
      'An agent picks the run up on its own branch, builds what the approval released, and stops again at any gate still waiting.',
    );
  });

  it('“you approved” when the viewer gave it, and the approved words follow the kind', () => {
    render(
      list([
        entry(
          'ACME-12',
          run([approved('ACME-13', { kind: 'decision_choice', decidedById: VIEWER })]),
          { resumeState: 'ready_to_resume' },
        ),
      ]),
    );
    expect(line('ACME-12').textContent).toContain(
      'Ready to resume · you approved the choice on ACME-13',
    );
    expect(screen.getByTestId('workbench-resume-gate-ACME-13').textContent).toContain('Chosen');
  });

  it.each([
    ['decision_confirmation', 'Confirmed'],
    ['manual_work', 'Marked done'],
  ] as const)('an approved %s reads %s', (kind, word) => {
    render(
      list([
        entry('ACME-12', run([approved('ACME-13', { kind })]), { resumeState: 'ready_to_resume' }),
      ]),
    );
    expect(screen.getByTestId('workbench-resume-gate-ACME-13').textContent).toContain(word);
  });

  it('the mixed case: 1 of 3 given, decided first, and continuing stops again at the rest', () => {
    render(
      list([
        entry('ACME-12', run([approved('ACME-13'), gate('ACME-21'), gate('ACME-22')]), {
          resumeState: 'ready_to_resume',
        }),
      ]),
    );
    expect(line('ACME-12').textContent).toContain('Ready to resume · 1 of 3 approvals given');
    const states = within(gates('ACME-12'))
      .getAllByRole('listitem')
      .map((li) => li.dataset.gateState);
    expect(states).toEqual(['approved', 'awaiting', 'awaiting']);
    expect(next('ACME-12').textContent).toBe(
      'Continuing now builds what the approved gate released, and stops again at the 2 still waiting.',
    );
  });

  it('a ready entry the viewer may edit places the Continue door', async () => {
    stubModels();
    render(
      list([
        entry('ACME-12', run([approved('ACME-13')], { ranWhere: 'terminal' }), {
          resumeState: 'ready_to_resume',
          canContinueHosted: true,
        }),
      ]),
    );
    expect(await screen.findByTestId('continue-hosted-door')).toBeTruthy();
  });

  it('a ready entry with no decision time reads the bare sentence', () => {
    render(list([entry('ACME-12', run([]), { resumeState: 'ready_to_resume' })]));
    expect(line('ACME-12').textContent).toContain('Ready to resume');
    expect(screen.queryByTestId('workbench-resume-gates-ACME-12')).toBeNull();
  });
});

describe('To resume — resuming and could not resume (§ 35.5, Panels 4–5)', () => {
  const attempt = (over: Partial<GateResumeAttemptDto>): GateResumeAttemptDto => ({
    outcome: 'skipped',
    skipReason: null,
    detail: null,
    resumedRunId: null,
    createdAt: AGO,
    ...over,
  });
  const ready = (a: GateResumeAttemptDto | null) =>
    entry(
      'ACME-12',
      run([gate('ACME-13', { state: 'approved', decidedById: 'u-dana', decidedAt: AGO })]),
      { resumeState: 'ready_to_resume' },
      a,
    );

  it('Resuming: the sky pill, a link to the run, no command and no next-step line', () => {
    render(list([ready(attempt({ outcome: 'started', resumedRunId: 'run_9' }))]));
    expect(line('ACME-12').dataset.resumeState).toBe('resuming');
    expect(line('ACME-12').textContent).toMatch(/Resuming on the hosted agent · started .+ago/);
    expect(screen.getByTestId('workbench-resume-state-ACME-12').dataset.tone).toBe('resuming');
    expect(screen.getByRole('link', { name: 'See the run' })).toBeTruthy();
    expect(within(line('ACME-12')).queryByText(/motir continue/)).toBeNull();
    expect(screen.queryByTestId('workbench-resume-next-ACME-12')).toBeNull();
  });

  it('a no-capacity skip in zh names the model in the reason and the repair (MOTIR-9633)', () => {
    render(list([ready(attempt({ skipReason: 'no_capacity', detail: 'opus-3' }))]), {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(line('ACME-12').textContent).toContain('它使用的模型 opus-3 目前没有智能体运行容量');
    expect(next('ACME-12').textContent).toContain(zhMessages.workbench.toResume.repair.no_capacity);
  });

  it('already_resumed reads as Resuming', () => {
    const view = ready(attempt({ skipReason: 'already_resumed' }));
    expect(
      resumeLineStateOf(toWorkbenchRowViews([view], WORKFLOW, MEMBERS, false)[0]!.resume!),
    ).toBe('resuming');
  });

  it.each([
    [
      'out_of_credits',
      null,
      'the organization is out of credits',
      'Add credits in billing, then press Continue — or continue from your terminal.',
    ],
    [
      'ci_credits_exhausted',
      null,
      "the organization's CI credits are used up",
      'Add CI credits in billing',
    ],
    [
      'credits_unavailable',
      null,
      "Motir couldn't check the organization's credits",
      'Press Continue to try again.',
    ],
    [
      'model_not_offered',
      'opus-3',
      'the model it ran with, opus-3, is no longer offered',
      'Pick another model and press Continue.',
    ],
    [
      // MOTIR-9633: recorded, never retried — the person continues it themselves.
      'no_capacity',
      'opus-3',
      'the model it ran with, opus-3, has no agent-run capacity right now',
      'Pick another model and press Continue, or try again shortly.',
    ],
    [
      'models_unavailable',
      null,
      "Motir couldn't load the list of models",
      'Press Continue to try again.',
    ],
    [
      'no_project_access',
      'Mara S.',
      'Mara S., who started it, no longer has access to this project',
      'Continue it yourself',
    ],
    [
      'dispatcher_gone',
      'Mara S.',
      'Mara S., who started it, is no longer in this workspace',
      'Continue it yourself',
    ],
    [
      'dispatcher_gone',
      null,
      'the person who started it is no longer in this workspace',
      'Continue it yourself',
    ],
    [
      'repository_not_writable',
      'acme/web',
      'Motir can no longer push to acme/web',
      'Reconnect the repository',
    ],
    ['card_not_ready', null, 'ACME-12 is not ready to run', 'Clear what blocks ACME-12'],
    [
      'not_resumable',
      'not_in_progress',
      'ACME-12 is not ready to run',
      'Clear what blocks ACME-12',
    ],
  ] as const)('Could not resume · %s (%s)', (skipReason, detail, reason, repair) => {
    render(list([ready(attempt({ skipReason, detail }))]));
    expect(line('ACME-12').dataset.resumeState).toBe('couldNot');
    expect(line('ACME-12').textContent).toContain(`Could not resume by itself · ${reason}`);
    expect(screen.getByTestId('workbench-resume-state-ACME-12').textContent).toBe("Didn't resume");
    expect(within(line('ACME-12')).getByText('motir continue ACME-12')).toBeTruthy();
    expect(next('ACME-12').textContent).toContain('Nothing was booted and nothing was charged.');
    expect(next('ACME-12').textContent).toContain(repair);
  });

  it('an entry that left the tab is HELD, marked Cleared, with no repair', () => {
    const rows = [ready(null), entry('ACME-30', run([gate('ACME-31')]), { resumeRunId: 'run_3' })];
    const view = render(list(rows));
    view.rerender(list(rows.slice(1)));
    expect(screen.getByTestId('workbench-row-ACME-12').dataset.held).toBe('true');
    expect(within(line('ACME-12')).getByText('Cleared')).toBeTruthy();
    expect(within(line('ACME-12')).queryByText(/motir continue/)).toBeNull();
  });
});

describe('To resume — a gate sent back (§ 35.5, Panel 6)', () => {
  it.each([
    [
      'changes_requested',
      'Design result sent back · changes requested by Dana P. — “Tighten the spacing”',
      'Nothing resumes. ACME-13 is reworked first; its next version asks again, and this run keeps waiting.',
    ],
    [
      'declined',
      'Decision declined by Dana P. — “Tighten the spacing”',
      'Nothing resumes. The work this would have released needs a new plan — re-plan ACME-13, or set ACME-12 to To Do to start over.',
    ],
    [
      'overturned',
      'Approval overturned by Dana P. — “Tighten the spacing”',
      'Nothing resumes. The approval no longer stands, so the run waits for a new decision on ACME-13.',
    ],
  ] as const)(
    '%s: quotes the decision, no repair, and says nothing resumes',
    (state, said, nextLine) => {
      render(
        list([
          entry(
            'ACME-12',
            run([
              gate('ACME-13', {
                state,
                decidedById: 'u-dana',
                decidedAt: AGO,
                notePreview: 'Tighten the spacing',
              }),
            ]),
          ),
        ]),
      );
      expect(line('ACME-12').dataset.resumeState).toBe('sentBack');
      expect(line('ACME-12').textContent).toContain(said);
      expect(within(line('ACME-12')).queryByText(/motir continue/)).toBeNull();
      expect(next('ACME-12').textContent).toBe(nextLine);
    },
  );

  it('without a note it still names who decided', () => {
    render(
      list([
        entry(
          'ACME-12',
          run([gate('ACME-13', { state: 'declined', decidedByLabel: 'the system' })]),
        ),
      ]),
    );
    expect(line('ACME-12').textContent).toContain('Decision declined by the system');
  });
});

describe('To resume — the words when a name or a detail is missing', () => {
  const ago = (over: Partial<ResumeGateDto> = {}) =>
    gate('ACME-13', { state: 'approved', decidedAt: AGO, ...over });

  it('a decider nobody can name draws no decider; a dispatcher nobody can name is “someone”', () => {
    render(
      list([
        entry(
          'ACME-12',
          run([gate('ACME-13', { deciderId: 'u-ghost' })], {
            ranById: 'u-ghost',
            ranByName: null,
          }),
        ),
      ]),
    );
    expect(gates('ACME-12').textContent).not.toContain('decides');
    expect(screen.getByTestId('workbench-resume-aside-ACME-12').textContent).toContain(
      'Someone ran it on the hosted agent',
    );
  });

  it('a waiting entry whose held gate was withdrawn still counts it', () => {
    render(list([entry('ACME-12', run([gate('ACME-13', { state: 'superseded' })]))]));
    expect(line('ACME-12').dataset.resumeState).toBe('waiting');
    expect(line('ACME-12').textContent).toContain('waiting on 1 approval');
  });

  it('a system approval (nobody named) reads “someone approved”', () => {
    render(
      list([
        entry('ACME-12', run([ago({ decidedById: null })]), { resumeState: 'ready_to_resume' }),
      ]),
    );
    expect(line('ACME-12').textContent).toMatch(
      /^Ready to resume · Someone approved the design result/,
    );
  });

  it('an already_resumed attempt has no run to link', () => {
    render(
      list([
        entry(
          'ACME-12',
          run([ago({ decidedById: 'u-dana' })]),
          { resumeState: 'ready_to_resume' },
          {
            outcome: 'skipped',
            skipReason: 'already_resumed',
            detail: null,
            resumedRunId: null,
            createdAt: AGO,
          },
        ),
      ]),
    );
    expect(line('ACME-12').dataset.resumeState).toBe('resuming');
    expect(screen.queryByRole('link', { name: 'See the run' })).toBeNull();
  });

  it.each([
    ['model_not_offered', 'the model it ran with, —, is no longer offered'],
    ['no_project_access', '—, who started it, no longer has access to this project'],
    ['repository_not_writable', 'Motir can no longer push to —'],
  ] as const)('Could not resume · %s without its detail names a dash', (skipReason, reason) => {
    render(
      list([
        entry(
          'ACME-12',
          run([ago({ decidedById: 'u-dana' })]),
          { resumeState: 'ready_to_resume' },
          { outcome: 'skipped', skipReason, detail: null, resumedRunId: null, createdAt: AGO },
        ),
      ]),
    );
    expect(line('ACME-12').textContent).toContain(reason);
  });

  it('a gate sent back by nobody named reads “someone”', () => {
    render(list([entry('ACME-12', run([gate('ACME-13', { state: 'declined', decidedAt: AGO })]))]));
    expect(line('ACME-12').textContent).toContain('Decision declined by Someone');
  });

  it('pressing Continue on a ready entry starts the hosted continue', async () => {
    const fetchMock = stubModels();
    render(
      list([
        entry('ACME-12', run([ago({ decidedById: 'u-dana' })]), {
          resumeState: 'ready_to_resume',
          canContinueHosted: true,
        }),
      ]),
    );
    const door = await screen.findByTestId('continue-hosted-door');
    const button = within(door).getAllByRole('button')[0]!;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain('/api/hosted-runs/models');
  });
});

describe('To resume — the empty tab and zh (§ 35.6, Panel 8)', () => {
  it('an empty tab draws only the empty state', () => {
    render(list([]));
    expect(screen.getByText('Nothing to resume')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('zh: line 2, the aside, the gate line and the next step', async () => {
    render(
      list([
        entry('ACME-12', run([gate('ACME-13', { deciderId: VIEWER })]), {
          resumeMembers: [card('ACME-13')],
        }),
      ]),
      { locale: 'zh', messages: zhMessages },
    );
    await act(async () => {});
    expect(line('ACME-12').textContent).toContain('停在审批处 · 等待 1 项审批');
    const aside = screen.getByTestId('workbench-resume-aside-ACME-12').textContent;
    expect(aside).toContain('Mara S. 在托管智能体上运行');
    expect(aside).toContain('分支 story/ACME-12-quotas');
    const row = screen.getByTestId('workbench-resume-gate-ACME-13');
    expect(row.textContent).toContain('设计结果');
    expect(row.textContent).toContain('由你决定');
    expect(row.textContent).toContain('等你处理');
    expect(screen.getByRole('button', { name: '查看并决定' })).toBeTruthy();
    expect(next('ACME-12').textContent).toBe('审批通过后，此运行会在托管智能体上自动继续。');
  });
});
