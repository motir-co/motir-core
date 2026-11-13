// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import type { DispatchRunDto } from '@/lib/dto/dispatchRuns';
import type { ItemGatedRunDto, ResumeGateDto } from '@/lib/dto/home';

// THE RUN SECTION'S STOPPED-AT-A-GATE MARKER (Story MOTIR-7701 · MOTIR-7713), built to
// `design/runs/design-notes.md` § _Stopped at a gate_, Panels G1–G6: the RUN pill that
// is never *Run died*, the line in the died line's slot, the gate rows, the copyable
// command only once ready, the child pointer, and the history row's pill.

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
  usePathname: () => '/items/ACME-12',
  useSearchParams: () => new URLSearchParams(),
}));

import { RunSection } from '@/app/(authed)/items/[key]/_components/RunSection';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, body: null }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const VIEWER = 'u-viewer';
const AGO = new Date(Date.now() - 60 * 60_000).toISOString();

function run(over: Partial<DispatchRunDto> = {}): DispatchRunDto {
  return {
    id: 'run_gated',
    projectId: 'prj_1',
    command: 'run',
    origin: 'hosted',
    scopeWorkItemId: null,
    scopeLabel: null,
    status: 'succeeded',
    stopReason: 'gated',
    agent: 'claude',
    model: 'sonnet',
    startedAt: '2026-10-07T09:10:00.000Z',
    endedAt: '2026-10-07T09:40:00.000Z',
    createdById: 'u-mara',
    lastHeartbeatAt: null,
    reportedBy: 'cli',
    agentInstance: null,
    seq: 4,
    cards: [
      {
        id: 'leg_1',
        key: 'ACME-12',
        workItemId: 'itm_12',
        position: 0,
        disposition: 'implemented',
        skipReason: null,
        sessionBranch: null,
        startedAt: '2026-10-07T09:10:00.000Z',
        endedAt: '2026-10-07T09:40:00.000Z',
        exitCode: 0,
        model: null,
      },
    ],
    ...over,
  };
}

function gate(subjectKey: string, over: Partial<ResumeGateDto> = {}): ResumeGateDto {
  return {
    gateId: `g_${subjectKey}`,
    kind: 'design_result',
    state: 'awaiting',
    subjectKey,
    subjectTitle: 'Quota settings page — design',
    deciderId: 'u-dana',
    decidedById: null,
    decidedByLabel: null,
    decidedAt: null,
    notePreview: null,
    ...over,
  };
}

function gated(over: Partial<ItemGatedRunDto> = {}, gates = [gate('ACME-13')]): ItemGatedRunDto {
  const merged: ItemGatedRunDto = {
    state: 'waiting_on_gate',
    runId: 'run_gated',
    resumedRunId: null,
    parent: null,
    run: {
      ranWhere: 'hosted',
      ranById: 'u-mara',
      ranByName: 'Mara S.',
      agentName: null,
      branch: 'story/ACME-12-quotas',
      gates,
    },
    attempt: null,
    names: { 'u-dana': 'Dana P.', [VIEWER]: 'Zhu Yue' },
    ...over,
  };
  return { ...merged, run: { ...merged.run, gates } };
}

function mount(g: ItemGatedRunDto, runs = [run()], opts?: Parameters<typeof render>[1]) {
  return render(
    <RunSection
      initialRuns={runs}
      initialCursor={null}
      itemKey="ACME-12"
      formattedTimes={Object.fromEntries(runs.map((r) => [r.id, '7 Oct, 09:10 UTC']))}
      gated={g}
      viewerId={VIEWER}
    />,
    opts,
  );
}

const line = () => screen.getByTestId('run-gated-line');

describe('G1 · Stopped at a gate', () => {
  it('the RUN pill reads Stopped at a gate — never Run died — and the line names the gate', () => {
    mount(gated());
    expect(screen.getByTestId('run-gated-pill').textContent).toBe('Stopped at a gate');
    expect(screen.queryByText('Run died')).toBeNull();
    expect(screen.queryByTestId('run-died-line')).toBeNull();
    expect(line().textContent).toBe(
      'This run stopped at a gate — waiting on the design result on ACME-13. Its work is kept on story/ACME-12-quotas, and it carries on by itself in Motir agent once the gate is approved.',
    );
    // The gate rows are the To resume tab's: kind, key, decider, state, Open.
    const row = screen.getByTestId('workbench-resume-gate-ACME-13');
    expect(screen.getByRole('list', { name: 'Gates holding this run' })).toBeTruthy();
    expect(row.textContent).toContain('Dana P. decides');
    expect(screen.getByTestId('workbench-resume-gate-open-ACME-13').getAttribute('href')).toBe(
      '/items/ACME-12?approval=ACME-13&approvalKind=design_result',
    );
    // No copyable command while the claim would refuse it.
    expect(screen.queryByRole('button', { name: /Copy the resume command/ })).toBeNull();
  });

  it('the history row keeps the Stopped at a gate pill', () => {
    mount(gated());
    const history = screen.getByRole('heading', { name: 'Recent runs' }).parentElement!;
    expect(within(history).getByText('Stopped at a gate')).toBeTruthy();
  });

  it('G1b · a terminal run NAMES the command, and the viewer decides', () => {
    mount(
      gated({ run: { ...gated().run, ranWhere: 'terminal' } }, [
        gate('ACME-41', { kind: 'decision_approval', deciderId: VIEWER }),
      ]),
      [run({ origin: 'local' })],
    );
    expect(line().textContent).toBe(
      'This run stopped at a gate — waiting on the decision approval on ACME-41. Its work is kept on its branch; once the gate is approved, continue it with motir continue ACME-12.',
    );
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
  });

  it('several gates read as a count, and a hosted run with no branch still says it carries on', () => {
    mount(gated({ run: { ...gated().run, branch: null } }, [gate('ACME-13'), gate('ACME-14')]));
    expect(line().textContent).toBe(
      'This run stopped at a gate — waiting on 2 approvals. Its work is kept, and it carries on by itself in Motir agent once the gate is approved.',
    );
  });
});

describe('G2 · Ready to resume', () => {
  it('the mint pill, the count of approvals given, and the copyable command', () => {
    mount(
      gated({ state: 'ready_to_resume' }, [
        gate('ACME-61', { state: 'approved', decidedById: 'u-dana', decidedAt: AGO }),
        gate('ACME-62', { kind: 'decision_choice', deciderId: VIEWER }),
        gate('ACME-63', { kind: 'manual_work' }),
      ]),
    );
    expect(screen.getByTestId('run-gated-pill').textContent).toBe('Ready to resume');
    expect(line().textContent).toBe(
      'Ready to resume — 1 of 3 approvals given. Continue it to build what was approved; it stops again at any gate still waiting:',
    );
    expect(screen.getByText('motir continue ACME-12')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Copy the resume command for ACME-12' }),
    ).toBeTruthy();
  });
});

describe('G3 · Resuming', () => {
  it('links to the new run and draws no gate rows; the current run is the continue', () => {
    mount(
      gated({ state: 'resuming', resumedRunId: 'run_new' }, [
        gate('ACME-13', { state: 'approved', decidedById: 'u-dana', decidedAt: AGO }),
      ]),
      [
        run({
          id: 'run_new',
          command: 'continue',
          status: 'running',
          stopReason: null,
          lastHeartbeatAt: new Date().toISOString(),
        }),
        run(),
      ],
    );
    expect(line().textContent).toBe(
      'Resuming — Dana P. approved the design result on ACME-13, so a new run carries on on the same branch. See the new run',
    );
    expect(screen.getByRole('link', { name: 'See the new run' }).getAttribute('href')).toContain(
      'run=run_new',
    );
    expect(screen.queryByTestId('workbench-resume-gates-ACME-12')).toBeNull();
    expect(screen.queryByTestId('run-gated-pill')).toBeNull();
  });

  it('without a recorded approver it still says a new run carries on', () => {
    mount(gated({ state: 'resuming', resumedRunId: 'run_new' }, []), [run()]);
    expect(line().textContent).toBe(
      'Resuming — a new run carries on on the same branch. See the new run',
    );
  });
});

describe('G4 · Could not resume', () => {
  it('names the approver, the reason in the tab’s words, and points to To resume', () => {
    mount(
      gated(
        {
          state: 'ready_to_resume',
          attempt: {
            outcome: 'skipped',
            skipReason: 'out_of_credits',
            detail: null,
            resumedRunId: null,
            createdAt: AGO,
          },
        },
        [gate('ACME-13', { state: 'approved', decidedById: VIEWER, decidedAt: AGO })],
      ),
    );
    expect(line().textContent).toBe(
      'you approved the design result on ACME-13, but the run could not resume by itself: the organization is out of credits. Continue it from To resume on the Workbench, or with motir continue ACME-12.',
    );
    expect(screen.getByRole('link', { name: 'To resume' }).getAttribute('href')).toBe(
      '/workbench?tab=to-resume',
    );
    expect(
      screen.getByRole('button', { name: 'Copy the resume command for ACME-12' }),
    ).toBeTruthy();
  });
});

describe('G5 · Gate sent back', () => {
  it('says who sent it back and that nothing resumes', () => {
    mount(
      gated({}, [
        gate('ACME-13', { state: 'changes_requested', decidedById: 'u-dana', decidedAt: AGO }),
      ]),
    );
    expect(line().textContent).toBe(
      'This run stopped at a gate — the design result on ACME-13 was sent back: changes requested by Dana P.. Nothing resumes until a new version is approved.',
    );
  });
});

describe('G6 · a child card of the gated parent run', () => {
  it('points UP to the parent, which is what resumes', () => {
    mount(gated({ parent: { key: 'ACME-12' } }), [
      run({ cards: [{ ...run().cards[0]!, key: 'ACME-14' }] }),
    ]);
    expect(line().textContent).toBe(
      'This work item was run as part of ACME-12, and that run stopped at a gate — waiting on the design result on ACME-13. It carries on from ACME-12 once the gate is approved, and this work item with it.',
    );
    expect(screen.getByRole('link', { name: 'ACME-12' }).getAttribute('href')).toBe(
      '/items/ACME-12',
    );
  });
});

describe('the words when a name or a run is missing', () => {
  it('a decider nobody can name and a sent-back gate nobody named read “someone”', () => {
    mount(
      gated({ names: {} }, [
        gate('ACME-13', { state: 'declined', decidedAt: AGO, deciderId: 'u-ghost' }),
      ]),
    );
    expect(line().textContent).toContain('declined by Someone');
    expect(screen.getByTestId('workbench-resume-gate-ACME-13').textContent).not.toContain(
      'decides',
    );
  });

  it('Resuming with no new run recorded links the gated run; a system approval is “someone”', () => {
    mount(
      gated({ state: 'resuming', resumedRunId: null }, [
        gate('ACME-13', { state: 'approved', decidedAt: AGO }),
      ]),
    );
    expect(line().textContent).toContain('Someone approved the design result on ACME-13');
    expect(screen.getByRole('link', { name: 'See the new run' }).getAttribute('href')).toContain(
      'run=run_gated',
    );
  });

  it('a waiting run whose held gates were withdrawn still names them', () => {
    mount(gated({}, [gate('ACME-13', { state: 'superseded' })]));
    expect(line().textContent).toContain('waiting on the design result on ACME-13');
  });

  it('a child card of a parent whose gate is approved points up all the same', () => {
    mount(
      gated({ parent: { key: 'ACME-12' }, state: 'ready_to_resume' }, [
        gate('ACME-13', { state: 'approved', decidedById: 'u-dana', decidedAt: AGO }),
      ]),
      [run({ cards: [{ ...run().cards[0]!, key: 'ACME-14' }] })],
    );
    expect(line().textContent).toContain('This work item was run as part of ACME-12');
    expect(screen.queryByRole('button', { name: /Copy the resume command/ })).toBeNull();
  });
});

describe('zh', () => {
  it('G1 in zh', () => {
    mount(gated(), [run()], { locale: 'zh', messages: zhMessages });
    expect(screen.getByTestId('run-gated-pill').textContent).toBe('停在审批处');
    expect(line().textContent).toBe(
      '此运行停在审批处——正在等待ACME-13 的设计结果。其工作保留在分支 story/ACME-12-quotas 上，审批通过后会在 Motir 智能体中自动继续。',
    );
  });
});
