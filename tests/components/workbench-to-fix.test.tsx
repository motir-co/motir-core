// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import type { FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type { HomeWorkItemRowDto } from '@/lib/dto/home';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// The To fix tab's ROWS (Story MOTIR-6588 · MOTIR-6605), under happy-dom, built to
// `design/workbench/design-notes.md` § 30: the fix line for each reason (Panel 2),
// the repair command read from `fixDetail.repair`, a HELD row marked *Cleared*
// (Panel 3), the empty state (Panel 4), the pager (Panel 5) and zh (Panel 6).

const push = vi.fn();
const refresh = vi.fn();
/** The window re-read the list is handed (MOTIR-8574) — what a moved row now calls. */
const reread = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), refresh }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams(),
}));

import { WorkbenchList } from '@/app/(authed)/workbench/_components/WorkbenchList';
import { fixCommandOf } from '@/app/(authed)/workbench/_components/WorkbenchFixLine';
import { toWorkbenchRowViews } from '@/app/(authed)/workbench/_components/workbenchRows';
import type { WorkbenchTab } from '@/lib/workbench/tab';

afterEach(() => {
  cleanup();
  push.mockReset();
  refresh.mockReset();
  reread.mockReset();
  vi.unstubAllGlobals();
});

const MEMBERS: WorkspaceMemberDTO[] = [
  {
    userId: 'u1',
    name: 'Zhu Yue',
    email: 'y@example.com',
    workspaceRole: 'manager',
    customRole: null,
  },
];

const WORKFLOW = {
  statuses: [
    { key: 'implemented', label: 'Implemented', category: 'in_progress' },
    { key: 'in_review', label: 'In Review', category: 'in_progress' },
  ],
} as unknown as WorkflowDto;

const EMPTY = <p>Nothing to fix</p>;

function detail(over: Partial<FixDetailDto> = {}): FixDetailDto {
  return {
    groupKey: null,
    repair: 'fix',
    check: null,
    queueReason: null,
    base: null,
    reviewerName: null,
    notePreview: null,
    gate: null,
    lastHeardAt: null,
    ranByName: null,
    branch: null,
    branches: null,
    pushed: null,
    continueKey: null,
    diedReason: null,
    affected: 1,
    total: 1,
    ...over,
  };
}

function stuck(
  identifier: string,
  fixReason: WorkItemFixReasonDto,
  fixDetail: FixDetailDto,
): HomeWorkItemRowDto {
  return {
    id: `wi_${identifier}`,
    kind: 'task',
    type: null,
    key: 1,
    identifier,
    title: `Title of ${identifier}`,
    status: 'implemented',
    ciState: null,
    fixReason,
    fixDetail,
    priority: 'medium',
    assigneeId: 'u1',
    reporterId: 'u1',
    executor: null,
    storyPoints: null,
    estimateMinutes: null,
    updatedAt: '2026-09-27T00:00:00.000Z',
    completedAt: null,
    project: { id: 'p1', identifier: 'MOTIR', name: 'Motir' },
    viewerIsAssignee: true,
    viewerIsReporter: false,
    canContinueHosted: false,
    fixGroupKind: null,
    fixMembers: [],
    resumeState: null,
    resumeRunId: null,
    resumeMembers: [],
    groupHead: null,
    groupMembers: [],
    canFixHosted: false,
    repairRun: null,
  };
}

const FOUR = [
  stuck('M-1', 'queue_failed', detail({ check: 'vitest (4/8)', queueReason: 'CI_FAILURE' })),
  stuck('M-2', 'conflicted', detail({ base: 'main' })),
  stuck('M-3', 'ci_failed', detail({ check: 'e2e (chromium, 2/4)', affected: 2, total: 3 })),
  stuck(
    'M-4',
    'changes_requested',
    detail({
      repair: 'run',
      reviewerName: 'Mei Lin',
      notePreview: 'The empty state still says “No reviews”',
      gate: 'pull_request_approval',
    }),
  ),
];

function list(
  rows: HomeWorkItemRowDto[],
  opts: { tab?: WorkbenchTab; page?: number; total?: number } = {},
) {
  return (
    <WorkbenchList
      rows={toWorkbenchRowViews(rows, WORKFLOW, MEMBERS, false)}
      label="To fix"
      tab={opts.tab ?? 'to-fix'}
      pagination={{ total: opts.total ?? rows.length, page: opts.page ?? 1, pageSize: 25 }}
      empty={EMPTY}
      reread={reread}
    />
  );
}

const fixLine = (key: string) => screen.getByTestId(`workbench-fix-${key}`);

describe('To fix — one fix line per reason (§ 30 Panel 2)', () => {
  it('draws the design’s four sentences, each with its repair command', () => {
    render(list(FOUR));

    expect(fixLine('M-1').textContent).toContain('Failed in the merge queue · vitest (4/8)');
    expect(fixLine('M-2').textContent).toContain('Conflicts with main');
    expect(fixLine('M-3').textContent).toContain('CI failed · e2e (chromium, 2/4)');
    expect(fixLine('M-4').textContent).toContain(
      'Changes requested by Mei Lin — “The empty state still says “No reviews””',
    );

    expect(within(fixLine('M-1')).getByText('motir fix M-1')).toBeTruthy();
    expect(within(fixLine('M-2')).getByText('motir fix M-2')).toBeTruthy();
    expect(within(fixLine('M-3')).getByText('motir fix M-3')).toBeTruthy();
    expect(within(fixLine('M-4')).getByText('motir run M-4')).toBeTruthy();
  });

  it('names the affected pull requests only when the card delivers more than one', () => {
    render(list(FOUR));
    expect(fixLine('M-3').textContent).toContain('2 of 3 pull requests affected');
    expect(fixLine('M-1').textContent).not.toContain('pull requests affected');
  });

  it('the command comes from `repair`, NOT the reason — an acceptance Re-run is `motir fix`', () => {
    render(
      list([
        stuck(
          'M-5',
          'changes_requested',
          detail({
            repair: 'fix',
            reviewerName: 'Zhu Yue',
            notePreview: 'Say how to add the first card',
            gate: 'acceptance_result',
          }),
        ),
      ]),
    );
    expect(fixLine('M-5').textContent).toContain('Changes requested by Zhu Yue');
    expect(within(fixLine('M-5')).getByText('motir fix M-5')).toBeTruthy();
    expect(fixCommandOf(detail({ repair: 'run' }), 'X-1')).toBe('motir run X-1');
  });

  // § 32 (MOTIR-6825): the review agent's refusal names THE AGENT and the findings' first
  // line — never the run's attributed user — and a person's Request changes is `motir fix`.
  it("names the review agent for its refusal, and a person's Request changes is motir fix", () => {
    render(
      list([
        stuck(
          'M-6',
          'changes_requested',
          detail({
            repair: 'fix',
            reviewerName: 'Review agent',
            notePreview: "Two of the card's acceptance criteria are not met yet.",
            gate: 'agent_review',
          }),
        ),
        stuck('M-7', 'changes_requested', detail({ repair: 'fix', gate: 'agent_review' })),
        stuck(
          'M-8',
          'changes_requested',
          detail({ repair: 'fix', reviewerName: 'Mei Lin', gate: 'pull_request_approval' }),
        ),
      ]),
    );
    expect(fixLine('M-6').querySelector('p')?.textContent).toBe(
      "Sent back by the review agent — “Two of the card's acceptance criteria are not met yet.”",
    );
    expect(fixLine('M-6').querySelector('svg')?.getAttribute('class')).toContain('lucide-undo2');
    expect(within(fixLine('M-6')).getByText('motir fix M-6')).toBeTruthy();
    expect(fixLine('M-7').querySelector('p')?.textContent).toBe('Sent back by the review agent');
    expect(fixLine('M-8').textContent).toContain('Changes requested by Mei Lin');
    expect(within(fixLine('M-8')).getByText('motir fix M-8')).toBeTruthy();
  });

  it('an out-of-date member names its base and offers motir fix (MOTIR-10054)', () => {
    render(list([stuck('M-9', 'out_of_date', detail({ base: 'main' }))]));
    expect(fixLine('M-9').querySelector('p')?.textContent).toBe('Out of date with main');
    expect(within(fixLine('M-9')).getByText('motir fix M-9')).toBeTruthy();
  });

  it.each([
    [
      'a queue failure with no check, a KNOWN reason',
      'queue_failed',
      { queueReason: 'CI_TIMEOUT' },
      'Failed in the merge queue · checks timed out',
    ],
    [
      'a queue failure with an UNMAPPED reason',
      'queue_failed',
      { queueReason: 'SOMETHING_ELSE' },
      'Failed in the merge queue',
    ],
    ['a conflict with no recorded base', 'conflicted', {}, 'Conflicts with its base branch'],
    [
      'an out-of-date member with no recorded base',
      'out_of_date',
      {},
      'Out of date with its base branch',
    ],
    ['red CI with no check name', 'ci_failed', {}, 'CI failed'],
    [
      'a refusal with no note',
      'changes_requested',
      { reviewerName: 'Mei Lin', repair: 'run' },
      'Changes requested by Mei Lin',
    ],
    ['a refusal by nobody recorded', 'changes_requested', { repair: 'run' }, 'Changes requested'],
  ] as const)('falls back for %s', (_label, reason, over, text) => {
    render(list([stuck('M-9', reason, detail(over as Partial<FixDetailDto>))]));
    expect(fixLine('M-9').querySelector('p')?.textContent).toBe(text);
  });

  it('a failure wears CircleX and a refusal wears Undo2 — every line is words, not only colour', () => {
    render(list(FOUR));
    expect(fixLine('M-1').querySelector('svg')?.getAttribute('class')).toContain('lucide-circle-x');
    expect(fixLine('M-4').querySelector('svg')?.getAttribute('class')).toContain('lucide-undo2');
  });

  it('the copy button is always there, copies the command and does not open the card', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(list(FOUR));

    const button = screen.getByRole('button', { name: 'Copy the repair command for M-4' });
    expect(button.className).not.toContain('opacity-0');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith('motir run M-4');
    expect(push).not.toHaveBeenCalled();
  });

  it('draws NO fix line on any other tab', () => {
    render(list(FOUR, { tab: 'in-progress' }));
    expect(screen.queryByTestId('workbench-fix-M-1')).toBeNull();
    expect(screen.getByTestId('workbench-row-M-1')).toBeTruthy();
  });
});

/** A row whose viewer may edit it — the only one that offers `motir continue`. */
const editable = (row: HomeWorkItemRowDto): HomeWorkItemRowDto => ({
  ...row,
  canContinueHosted: true,
});

/** The two routes the control reads: the page's ONE model list, and the start. */
function stubRoutes(start: () => Response = () => new Response('{}', { status: 201 })) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/hosted-runs/models') {
      return new Response(
        JSON.stringify({ models: [{ id: 'sonnet', provider: 'anthropic' }], default: 'sonnet' }),
        { status: 200 },
      );
    }
    return start();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const modelReads = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter(([u]) => String(u) === '/api/hosted-runs/models').length;
const starts = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter(([u]) => String(u).endsWith('/hosted-runs'));

describe('To fix — a dead run (§ 31, MOTIR-6880)', () => {
  const heard = () => new Date(Date.now() - 12 * 60_000).toISOString();
  const died = (over: Partial<FixDetailDto> = {}) =>
    detail({
      repair: 'continue',
      lastHeardAt: heard(),
      ranByName: 'Mara S.',
      branch: 'subtask/M-14-throttle',
      branches: [{ repository: 'web', branch: 'subtask/M-14-throttle' }],
      pushed: true,
      continueKey: 'M-14',
      diedReason: 'lapsed',
      affected: 0,
      total: 0,
      ...over,
    });

  it('pushed, own run — the reason line, and `motir continue` on its own key', () => {
    stubRoutes();
    render(list([editable(stuck('M-14', 'run_died', died()))]));
    expect(fixLine('M-14').querySelector('p')?.textContent).toMatch(
      /^Run died · last heard from 12 min\. ago · Mara S\. · branch subtask\/M-14-throttle$/,
    );
    expect(fixLine('M-14').querySelector('p time')?.getAttribute('title')).toMatch(/UTC$/);
    expect(fixLine('M-14').querySelector('p b')?.textContent).toBe('subtask/M-14-throttle');
    expect(within(fixLine('M-14')).getByText('motir continue M-14')).toBeTruthy();
    // The run-died marker's glyph, muted — nothing about the work failed.
    const glyph = fixLine('M-14').querySelector('svg')!;
    expect(glyph.getAttribute('class')).toContain('lucide-triangle-alert');
    expect(glyph.getAttribute('class')).toContain('text-(--el-icon-muted)');
  });

  it('several repositories — the primary branch, then how many more', () => {
    render(
      list([
        stuck(
          'M-15',
          'run_died',
          died({
            continueKey: 'M-15',
            branches: [
              { repository: 'web', branch: 'subtask/M-14-throttle' },
              { repository: 'api', branch: 'subtask/M-14-throttle' },
              { repository: 'cli', branch: 'subtask/M-14-throttle' },
            ],
          }),
        ),
      ]),
    );
    expect(fixLine('M-15').querySelector('p')?.textContent).toContain(
      'branch subtask/M-14-throttle + 2 more repositories',
    );
  });

  it('a leg of a parent run — NO parent clause any more (§ 34 retires § 31 state 3), and the command still continues the parent', () => {
    stubRoutes();
    render(list([editable(stuck('M-16', 'run_died', died({ continueKey: 'M-12' })))]));
    expect(fixLine('M-16').querySelector('p')?.textContent).not.toContain('Part of');
    expect(within(fixLine('M-16')).getByText('motir continue M-12')).toBeTruthy();
  });

  it('nothing pushed — says so, and offers NO command (the claim would refuse it)', () => {
    render(
      list([
        stuck(
          'M-17',
          'run_died',
          died({ repair: 'none', pushed: false, branch: null, branches: [], continueKey: null }),
        ),
      ]),
    );
    expect(fixLine('M-17').querySelector('p')?.textContent).toMatch(
      /^Run died · last heard from 12 min\. ago · Mara S\. · nothing was pushed$/,
    );
    expect(fixLine('M-17').textContent).not.toContain('motir');
    expect(screen.queryByRole('button', { name: 'Copy the repair command for M-17' })).toBeNull();
    expect(fixCommandOf(detail({ repair: 'none' }), 'M-17')).toBeNull();
  });

  it('a deleted dispatcher drops the name, not the line', () => {
    render(list([stuck('M-18', 'run_died', died({ ranByName: null, continueKey: 'M-18' }))]));
    expect(fixLine('M-18').querySelector('p')?.textContent).toMatch(
      /^Run died · last heard from 12 min\. ago · branch subtask\/M-14-throttle$/,
    );
  });

  it('reads in Chinese', () => {
    render(list([stuck('M-14', 'run_died', died())]), { locale: 'zh', messages: zhMessages });
    expect(fixLine('M-14').querySelector('p')?.textContent).toMatch(
      /^运行已中断 · 最后一次联系在.+ · Mara S\. · 分支 subtask\/M-14-throttle$/,
    );
  });
});

describe('To fix — a repaired row is HELD (§ 30 Panel 3, § 26)', () => {
  it('a row that left the set stays in place, marked Cleared, with no command', () => {
    const view = render(list(FOUR));
    // The live re-read: M-3's build went green, so the server no longer lists it.
    view.rerender(list(FOUR.filter((r) => r.identifier !== 'M-3')));

    const rows = screen
      .getAllByRole('row')
      .filter((r) => r.dataset.testid?.startsWith('workbench-row-'));
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      'workbench-row-M-1',
      'workbench-row-M-2',
      'workbench-row-M-3',
      'workbench-row-M-4',
    ]);
    const held = screen.getByTestId('workbench-row-M-3');
    expect(held.dataset.held).toBe('true');
    expect(within(held).getByText('Cleared')).toBeTruthy();
    expect(within(held).queryByText('motir fix M-3')).toBeNull();
    expect(within(held).queryByRole('button', { name: /Copy the repair command/ })).toBeNull();
    // The glyph is dropped and the ink goes secondary.
    expect(fixLine('M-3').querySelector('svg')).toBeNull();
    expect(fixLine('M-3').querySelector('p')?.className).toContain('--el-text-secondary');
    // Its siblings are untouched.
    expect(screen.getByTestId('workbench-row-M-1').dataset.held).toBeUndefined();
  });

  it('the NEXT LOAD omits it — a pager move starts the window clean', () => {
    const view = render(list(FOUR, { total: 30 }));
    view.rerender(
      list(
        FOUR.filter((r) => r.identifier !== 'M-3'),
        { page: 2, total: 29 },
      ),
    );
    expect(screen.queryByTestId('workbench-row-M-3')).toBeNull();
  });

  it('when the LAST row clears it is held, not swapped for the empty state', () => {
    const view = render(list([FOUR[0]!]));
    view.rerender(list([], { total: 0 }));
    expect(screen.getByTestId('workbench-row-M-1').dataset.held).toBe('true');
    expect(screen.queryByText('Nothing to fix')).toBeNull();
  });
});

describe('To fix — empty and paged (§ 30 Panels 4 and 5)', () => {
  it('an empty tab draws its empty state and nothing else', () => {
    render(list([]));
    expect(screen.getByText('Nothing to fix')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('more than one page mounts the shipped pager, which navigates to ?tab=to-fix&page=N', () => {
    render(list(FOUR, { total: 60 }));
    fireEvent.click(screen.getByRole('button', { name: /page 2/i }));
    expect(push).toHaveBeenCalledWith('/workbench?tab=to-fix&page=2');
  });
});

describe('To fix — zh (§ 30 Panel 6)', () => {
  it('reads every reason, the affected clause and the held chip in Chinese; commands stay as typed', () => {
    const view = render(list(FOUR), { locale: 'zh', messages: zhMessages });
    expect(fixLine('M-1').textContent).toContain('在合并队列中失败 · vitest (4/8)');
    expect(fixLine('M-2').textContent).toContain('与 main 冲突');
    expect(fixLine('M-3').textContent).toContain('CI 未通过 · e2e (chromium, 2/4)');
    expect(fixLine('M-3').textContent).toContain('3 个拉取请求中有 2 个受影响');
    expect(fixLine('M-4').textContent).toContain('Mei Lin 要求修改');
    expect(within(fixLine('M-4')).getByText('motir run M-4')).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制 M-1 的修复命令' })).toBeTruthy();

    view.rerender(list(FOUR.filter((r) => r.identifier !== 'M-2')));
    expect(within(screen.getByTestId('workbench-row-M-2')).getByText('已解除')).toBeTruthy();
  });
});

describe('To fix — Continue hosted on a dead-run row (§ 31, MOTIR-6882)', () => {
  const heard = () => new Date(Date.now() - 12 * 60_000).toISOString();
  const died = (over: Partial<FixDetailDto> = {}) =>
    detail({
      repair: 'continue',
      lastHeardAt: heard(),
      ranByName: 'Mara S.',
      branch: 'subtask/M-14-throttle',
      branches: [{ repository: 'web', branch: 'subtask/M-14-throttle' }],
      pushed: true,
      continueKey: 'M-14',
      diedReason: 'lapsed',
      affected: 0,
      total: 0,
      ...over,
    });
  it('pushed — Continue hosted leads, and the command keeps the right edge', async () => {
    stubRoutes();
    render(list([editable(stuck('M-14', 'run_died', died()))]));
    const line = fixLine('M-14');
    const button = await within(line).findByRole('button', { name: 'Continue' });
    await vi.waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    const command = within(line).getByText('motir continue M-14');
    // Reading order: the door, then the command.
    expect(button.compareDocumentPosition(command) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Both sit above the row's stretched link, so pressing one does not open the card.
    expect(button.closest('.relative.z-10')).toBeTruthy();
  });

  it('a leg of a parent run — the button and the command both continue the parent', async () => {
    stubRoutes();
    render(list([editable(stuck('M-16', 'run_died', died({ continueKey: 'M-12' })))]));
    expect(
      await within(fixLine('M-16')).findByRole('button', { name: 'Continue M-12' }),
    ).toBeTruthy();
    expect(within(fixLine('M-16')).getByText('motir continue M-12')).toBeTruthy();
  });

  it('nothing pushed — the marker’s start-over line in the command’s place, no control', () => {
    const f = stubRoutes();
    render(
      list([
        editable(
          stuck(
            'M-17',
            'run_died',
            died({ repair: 'none', pushed: false, branch: null, branches: [], continueKey: null }),
          ),
        ),
      ]),
    );
    expect(screen.getByTestId('workbench-fix-start-over-M-17').textContent).toBe(
      'Start over instead: set M-17 to To Do and run it again.',
    );
    expect(screen.queryByTestId('continue-hosted-door')).toBeNull();
    expect(fixLine('M-17').textContent).not.toContain('motir continue');
    expect(modelReads(f)).toBe(0);
  });

  it('a viewer who may not edit — who can act, and neither repair', () => {
    const f = stubRoutes();
    render(list([stuck('M-14', 'run_died', died())]));
    expect(screen.getByTestId('workbench-fix-cannot-edit-M-14').textContent).toBe(
      'You can’t edit this work item, so someone who can has to continue it.',
    );
    expect(screen.queryByTestId('continue-hosted-door')).toBeNull();
    expect(fixLine('M-14').textContent).not.toContain('motir continue');
    expect(modelReads(f)).toBe(0);
  });

  it('ONE models request for three dead-run rows, and NONE for a tab of pull-request reasons', async () => {
    const f = stubRoutes();
    const view = render(
      list([
        editable(stuck('M-14', 'run_died', died())),
        editable(stuck('M-15', 'run_died', died({ continueKey: 'M-15' }))),
        editable(stuck('M-16', 'run_died', died({ continueKey: 'M-12' }))),
      ]),
    );
    await vi.waitFor(() => expect(screen.getAllByTestId('continue-hosted')).toHaveLength(3));
    expect(modelReads(f)).toBe(1);
    view.unmount();

    const g = stubRoutes();
    render(list(FOUR));
    expect(screen.queryByTestId('continue-hosted-door')).toBeNull();
    expect(modelReads(g)).toBe(0);
  });

  it('a start re-reads the page, and the row the continue cleared is HELD as Cleared', async () => {
    const f = stubRoutes();
    const rows = [editable(stuck('M-14', 'run_died', died())), FOUR[0]!];
    const view = render(list(rows));
    const button = await screen.findByRole('button', { name: 'Continue' });
    await vi.waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(button);
    });
    expect(starts(f)).toHaveLength(1);
    expect(String(starts(f)[0]![0])).toBe('/api/work-items/M-14/hosted-runs');
    expect(JSON.parse(String((starts(f)[0]![1] as RequestInit).body))).toMatchObject({
      model: 'sonnet',
      mode: 'continue',
    });
    expect(reread).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();

    // The re-read: the continue opened a run, the reason cleared, the server drops it.
    view.rerender(list([FOUR[0]!]));
    const held = screen.getByTestId('workbench-row-M-14');
    expect(held.dataset.held).toBe('true');
    expect(within(held).getByText('Cleared')).toBeTruthy();
    expect(within(held).queryByTestId('continue-hosted-door')).toBeNull();
    expect(within(held).queryByText('motir continue M-14')).toBeNull();
  });

  it('a refusal that means the state MOVED re-reads the page and stays on the HELD row', async () => {
    stubRoutes(
      () =>
        new Response(
          JSON.stringify({
            code: 'hosted_continue_taken',
            holder: { id: 'u2', name: 'Lee K.' },
            startedAt: new Date().toISOString(),
          }),
          { status: 409 },
        ),
    );
    const view = render(list([editable(stuck('M-14', 'run_died', died())), FOUR[0]!]));
    const button = await screen.findByRole('button', { name: 'Continue' });
    await vi.waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(button);
    });
    expect(reread).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('continue-hosted-refused-taken').textContent).toContain('Lee K.');

    view.rerender(list([FOUR[0]!]));
    const held = screen.getByTestId('workbench-row-M-14');
    expect(held.dataset.held).toBe('true');
    expect(within(held).getByTestId('continue-hosted-refused-taken')).toBeTruthy();
  });

  it('a pre-flight refusal leaves the row as it was, the notice under the repairs', async () => {
    stubRoutes(() => new Response(JSON.stringify({ code: 'out_of_credits' }), { status: 402 }));
    render(list([editable(stuck('M-14', 'run_died', died())), FOUR[0]!]));
    const button = await screen.findByRole('button', { name: 'Continue' });
    await vi.waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(button);
    });
    expect(reread).not.toHaveBeenCalled();
    const line = fixLine('M-14');
    expect(within(line).getByTestId('continue-hosted-refused-outOfCredits')).toBeTruthy();
    expect(within(line).getByText('motir continue M-14')).toBeTruthy();
    expect(screen.getByTestId('workbench-row-M-14').dataset.held).toBeUndefined();
  });
});

describe('To fix — ONE ENTRY per run or pull-request set (§ 34, MOTIR-7589)', () => {
  function member(identifier: string, over: Partial<HomeWorkItemRowDto> = {}): HomeWorkItemRowDto {
    return { ...stuck(identifier, 'ci_failed', detail({ check: 'lint' })), ...over };
  }
  function entry(
    head: string,
    kind: 'run' | 'prs',
    members: HomeWorkItemRowDto[],
    over: Partial<HomeWorkItemRowDto> = {},
  ): HomeWorkItemRowDto {
    return {
      ...stuck(head, 'ci_failed', detail({ check: 'lint' })),
      kind: 'story',
      fixGroupKind: kind,
      fixMembers: members,
      ...over,
    };
  }

  it('one row for the head, a clause counting the rest, and the members beneath it', () => {
    render(list([entry('S-1', 'prs', [member('S-2'), member('S-3')])]));
    expect(screen.getByTestId('workbench-fix-carries-S-1').textContent).toContain(
      '2 more work items on the same pull request',
    );
    const members = screen.getByRole('list', { name: 'Work items stuck with S-1' });
    expect(
      within(members)
        .getAllByRole('listitem')
        .map((li) => li.dataset.testid),
    ).toEqual(['workbench-fix-member-S-2', 'workbench-fix-member-S-3']);
    expect(
      within(members).getByRole('link', { name: 'S-2 Title of S-2' }).getAttribute('href'),
    ).toBe('/items/S-2');
    // ONE command — the head's — for the whole entry.
    expect(screen.getAllByText(/^motir fix /)).toHaveLength(1);
  });

  it('a run entry says "in this run" and a single member reads singular', () => {
    render(list([entry('S-1', 'run', [member('S-2')])]));
    expect(screen.getByTestId('workbench-fix-carries-S-1').textContent).toContain(
      '1 more work item in this run',
    );
  });

  it('a card stuck alone draws no clause and no member list', () => {
    render(list([FOUR[0]!]));
    expect(screen.queryByTestId('workbench-fix-carries-M-1')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('shows three members, folds the rest behind Show N more, and unfolds', () => {
    render(
      list([
        entry(
          'S-1',
          'run',
          ['S-2', 'S-3', 'S-4', 'S-5', 'S-6'].map((k) => member(k)),
        ),
      ]),
    );
    const members = () => screen.getByTestId('workbench-fix-members-S-1');
    expect(within(members()).getAllByRole('listitem')).toHaveLength(3);
    const toggle = screen.getByRole('button', { name: 'Show 2 more work items' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(members().id);
    fireEvent.click(toggle);
    expect(within(members()).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Show fewer' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('a member that leaves the entry is HELD as Cleared, in place', () => {
    const view = render(list([entry('S-1', 'prs', [member('S-2'), member('S-3')])]));
    view.rerender(list([entry('S-1', 'prs', [member('S-3')])]));
    const left = screen.getByTestId('workbench-fix-member-S-2');
    expect(left.dataset.cleared).toBe('true');
    expect(within(left).getByText('Cleared')).toBeTruthy();
    expect(screen.getByTestId('workbench-fix-member-S-3').dataset.cleared).toBeUndefined();
    // A member that joins later appears after the ones already drawn.
    view.rerender(list([entry('S-1', 'prs', [member('S-3'), member('S-4')])]));
    expect(
      within(screen.getByTestId('workbench-fix-members-S-1'))
        .getAllByRole('listitem')
        .map((li) => li.dataset.testid),
    ).toEqual(['workbench-fix-member-S-2', 'workbench-fix-member-S-3', 'workbench-fix-member-S-4']);
  });

  it("a head the reader does not hold reads — in Your role; a member they don't hold too", () => {
    render(
      list([
        entry(
          'S-1',
          'prs',
          [
            member('S-2'),
            member('S-3', { assigneeId: null, reporterId: 'u9', viewerIsAssignee: false }),
          ],
          {
            assigneeId: null,
            reporterId: 'u9',
            viewerIsAssignee: false,
            viewerIsReporter: false,
          },
        ),
      ]),
    );
    const row = screen.getByTestId('workbench-row-S-1');
    expect(within(row).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('workbench-fix-member-S-3')).getByText('—')).toBeTruthy();
  });

  it('the whole entry is held when its head leaves the tab', () => {
    const view = render(list([entry('S-1', 'prs', [member('S-2')])]));
    view.rerender(list([], { total: 0 }));
    expect(screen.getByTestId('workbench-row-S-1').dataset.held).toBe('true');
    expect(screen.getByTestId('workbench-fix-member-S-2')).toBeTruthy();
  });

  it('reads in Chinese', () => {
    render(
      list([
        entry(
          'S-1',
          'prs',
          ['S-2', 'S-3', 'S-4', 'S-5'].map((k) => member(k)),
        ),
      ]),
      {
        locale: 'zh',
        messages: zhMessages,
      },
    );
    expect(screen.getByTestId('workbench-fix-carries-S-1').textContent).not.toContain('more');
    expect(screen.getByTestId('workbench-fix-members-toggle-S-1').textContent).not.toContain(
      'Show',
    );
  });
});
