// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';
import type { DevelopmentGateActions } from '@/components/github/DevelopmentGateFrame';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import type {
  ApprovalGateDTO,
  ApprovalGateOverlayReadDTO,
  ApprovalOverlayStatusDTO,
} from '@/lib/dto/approvalGate';
import type { WorkItemRepairViewDto } from '@/lib/dto/workItemRepair';

// AN ACCEPTANCE SENT BACK ASKS FOR A VERDICT BY RUN SHAPE, THEN HANDS OFF (Story MOTIR-6071 ·
// Subtask MOTIR-6506), built to `design/work-items/approval-control--acceptance-verdict.mock.html`
// and its notes' § *The ACCEPTANCE VERDICT*. The mirror of `design-refusal-verdict.test.tsx`.
// What these hold in place, each of which fails silently:
//
//   · a STORY RUN (the gate's `offersRefusalVerdict`) asks for a reason AND Re-run / Re-plan,
//     refuses a press missing either IN PLACE, and carries `refusalVerdict`; its list keeps
//     the record line alone — never the borrowed `commits` lines;
//   · a FINISHED story asks for the reason only, draws the no-re-run line where the tiles
//     would be, keeps the shipped *stays* line, and sends no verdict;
//   · the record's chip is KIND-AWARE (*re-run* / *re-plan* / a derived *remedy*), and the
//     decided row leads with *Re-run*;
//   · NO STATUS MOVES: the header chip and the rail keep the story's status after any press;
//   · after a Re-run the Development block shows `motir fix <KEY>` from the RE-READ repair
//     view and asks nothing; after a Re-plan the band asks *Re-plan <KEY> with Motir AI?*.

let params = new URLSearchParams();
const pathname = '/workbench';
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));

const { shallowPush, shallowReplace } = vi.hoisted(() => ({
  shallowPush: vi.fn(),
  shallowReplace: vi.fn(),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace }));

const { fetchApprovalGateOverlay } = vi.hoisted(() => ({ fetchApprovalGateOverlay: vi.fn() }));
vi.mock('@/lib/approvals/approvalOverlayClient', () => ({ fetchApprovalGateOverlay }));

const { decideApprovalGateAction, approveAndMergeAction } = vi.hoisted(() => ({
  decideApprovalGateAction: vi.fn(),
  approveAndMergeAction: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/approvalGateActions', () => ({
  decideApprovalGateAction,
  approveAndMergeAction,
  retryApproveAndMergeMemberAction: vi.fn(),
}));

const { DevelopmentSectionBody } = await import('@/components/github/DevelopmentSection');
const { ApprovalGateControl } = await import('@/components/approvals/ApprovalGateControl');
const { useRefusalVerb, RefusalReasonCell, refusalVerdictChipKey } =
  await import('@/components/approvals/RefusalReason');
const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');
const { OptimisticStatusProvider, useDisplayedStatus } =
  await import('@/app/(authed)/items/[key]/_components/OptimisticStatusProvider');

type AcceptanceRefusalFacts = import('@/components/approvals/RefusalReason').AcceptanceRefusalFacts;

const reason = en.approvalGate.reason;
const acc = en.approvalGate.acceptanceResult;
const verdict = acc.verdict;
const ask = en.approvalGate.replanAsk;
const REASON = 'Exports need a date filter before this ships — the list is useless past a week.';

const GATE: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  id: 'gate-acc-1',
  workItemId: 'wi-60',
  kind: 'acceptance_result',
  subjectId: 'ae-1',
  subjectVersion: 'c0ffee1234567890',
  offersRefusalVerdict: true,
};

const sentBack = (
  refusalVerdict: ApprovalGateDTO['refusalVerdict'],
  over: Partial<ApprovalGateDTO> = {},
): ApprovalGateDTO => ({
  ...GATE,
  state: 'changes_requested',
  decidedById: 'user-1',
  decidedAt: '2026-09-26T10:14:00.000Z',
  decidedByLabel: 'Yue',
  decisionSource: 'ui',
  noteMd: REASON,
  refusalVerdict,
  offersRefusalVerdict: false,
  ...over,
});

const STORY_RUN: AcceptanceRefusalFacts = { offersVerdict: true, pullRequestCount: 1 };
const FINISHED: AcceptanceRefusalFacts = { offersVerdict: false, pullRequestCount: 0 };

function Frame({
  gate = GATE,
  facts = STORY_RUN,
  refusalRemedy,
  onDecide,
}: {
  gate?: ApprovalGateDTO;
  facts?: AcceptanceRefusalFacts;
  refusalRemedy?: boolean;
  onDecide: (...args: unknown[]) => Promise<GateRefusal | null>;
}) {
  const refusalVerb = useRefusalVerb();
  return (
    <ApprovalGateControl
      gate={gate}
      canDecide
      kindLabel="Acceptance video"
      subjectMeta="recorded at c0ffee12"
      port={<div>the recording</div>}
      verbs={[
        refusalVerb('acceptance', 'ACME-60', {}, undefined, facts),
        { decision: 'approve', label: 'Approve', variant: 'primary', confirms: true },
      ]}
      consequence="Approving accepts ACME-60."
      confirmConsequences={['records it']}
      refusalRemedy={refusalRemedy}
      onDecide={onDecide as never}
    />
  );
}

const openBand = () =>
  fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));
const group = () => screen.queryByRole('radiogroup', { name: verdict.legend });
const tile = (label: string) =>
  within(group()!).getByRole('radio', { name: new RegExp(`^${label}`) }) as HTMLInputElement;
const proceed = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: reason.proceed }));
  });
};
const RERUN_ONE =
  'Nothing moves; the merge approval is withdrawn, and motir fix works on the same pull request with your reason.';

beforeEach(() => {
  params = new URLSearchParams();
  shallowPush.mockReset();
  shallowReplace.mockReset();
  fetchApprovalGateOverlay.mockReset();
  decideApprovalGateAction.mockReset();
  approveAndMergeAction.mockReset();
  refresh.mockReset();
});
afterEach(cleanup);

describe('a STORY RUN’s band asks Re-run or Re-plan beside the reason (panels 2a–2d)', () => {
  it('draws the two tiles, NOTHING pre-selected, with the design’s consequence lines', () => {
    renderWithIntl(<Frame onDecide={vi.fn(async () => null)} />);
    openBand();

    expect(screen.getByLabelText(reason.label)).toBeTruthy();
    expect(group()!.getAttribute('aria-required')).toBe('true');
    expect(screen.getByTestId('refusal-verdict-group')).toBe(group());
    expect(tile(verdict.rerun.label).checked).toBe(false);
    expect(tile(reason.verdict.replan.label).checked).toBe(false);
    expect(screen.getByText(verdict.rerun.hint)).toBeTruthy();
    expect(screen.getByText(verdict.replan.hint)).toBeTruthy();
    expect(screen.getByText(RERUN_ONE)).toBeTruthy();
    expect(screen.getByText(verdict.replan.consequence)).toBeTruthy();
    // Choice 2: the list keeps the record line ALONE — the borrowed commits lines and the
    // *stays* line are gone, and there is no no-re-run line.
    expect(screen.getByText(reason.consequence.versionBack)).toBeTruthy();
    expect(screen.queryByText(reason.consequence.commitsBack)).toBeNull();
    expect(screen.queryByText(reason.consequence.mergeNothing)).toBeNull();
    expect(screen.queryByText(/where it is — nothing moves yet/)).toBeNull();
    expect(screen.queryByTestId('refusal-no-rerun')).toBeNull();
  });

  it('counts several pull requests in the Re-run line', () => {
    renderWithIntl(
      <Frame
        facts={{ offersVerdict: true, pullRequestCount: 2 }}
        onDecide={vi.fn(async () => null)}
      />,
    );
    openBand();
    expect(
      screen.getByText(
        'Nothing moves; the merge approval is withdrawn, and motir fix works on the same pull requests with your reason.',
      ),
    ).toBeTruthy();
  });

  it('a reason with NO verdict is REFUSED IN PLACE — the group invalid, its own error, nothing sent', async () => {
    const onDecide = vi.fn(async () => null);
    renderWithIntl(<Frame onDecide={onDecide} />);
    openBand();
    fireEvent.change(screen.getByLabelText(reason.label), { target: { value: REASON } });
    await proceed();

    expect(group()!.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe(verdict.required);
    expect(onDecide).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tile(verdict.rerun.label));
    // Send is never disabled (design choice 3): it is refused in place instead.
    expect(
      (screen.getByRole('button', { name: reason.proceed }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('BOTH missing — ONE press reports both, and focus goes to the reason first', async () => {
    const onDecide = vi.fn(async () => null);
    renderWithIntl(<Frame onDecide={onDecide} />);
    openBand();
    await proceed();
    expect(screen.getByText(reason.required)).toBeTruthy();
    expect(screen.getByText(verdict.required)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText(reason.label));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it.each([
    [verdict.rerun.label, 'revise'],
    [reason.verdict.replan.label, 're_plan'],
  ] as const)('%s + a reason sends BOTH with the press', async (label, value) => {
    const onDecide = vi.fn(async () => null);
    renderWithIntl(<Frame onDecide={onDecide} />);
    openBand();
    fireEvent.change(screen.getByLabelText(reason.label), { target: { value: REASON } });
    fireEvent.click(tile(label));
    await proceed();
    expect(onDecide).toHaveBeenCalledWith('request_changes', undefined, REASON, value);
  });

  it('speaks zh', () => {
    renderWithIntl(<Frame onDecide={vi.fn(async () => null)} />, {
      messages: zh as unknown as typeof en,
      locale: 'zh',
    });
    fireEvent.click(screen.getByRole('button', { name: zh.approvalGate.verb.requestChanges }));
    const zhGroup = screen.getByRole('radiogroup', {
      name: zh.approvalGate.acceptanceResult.verdict.legend,
    });
    expect(
      within(zhGroup).getByRole('radio', {
        name: new RegExp(`^${zh.approvalGate.acceptanceResult.verdict.rerun.label}`),
      }),
    ).toBeTruthy();
  });
});

describe('a FINISHED story’s band takes the reason only (panel 3a)', () => {
  it('draws NO tiles, the no-re-run line where they would be, and the shipped two lines', () => {
    renderWithIntl(<Frame facts={FINISHED} onDecide={vi.fn(async () => null)} />);
    openBand();
    expect(group()).toBeNull();
    expect(screen.queryByTestId('refusal-verdict-group')).toBeNull();
    const line = screen.getByTestId('refusal-no-rerun');
    expect(line.textContent).toBe(acc.refusal.noRerun);
    expect(line.className).toContain('text-(--el-text-secondary)');
    expect(line.className).toContain('text-[13px]');
    expect(screen.getByText(reason.consequence.versionBack)).toBeTruthy();
    expect(screen.getByText('Leave ACME-60 where it is — nothing moves yet.')).toBeTruthy();
  });

  it('sends the reason and NO verdict', async () => {
    const onDecide = vi.fn(async (..._args: unknown[]) => null);
    renderWithIntl(<Frame facts={FINISHED} onDecide={onDecide} />);
    openBand();
    fireEvent.change(screen.getByLabelText(reason.label), { target: { value: REASON } });
    await proceed();
    expect(onDecide).toHaveBeenCalledTimes(1);
    const call = onDecide.mock.calls[0]!;
    expect(call.slice(0, 3)).toEqual(['request_changes', undefined, REASON]);
    expect(call[3]).toBeUndefined();
  });

  it('a host that hands no facts asks the finished story’s question', () => {
    function Bare() {
      const refusalVerb = useRefusalVerb();
      return (
        <ApprovalGateControl
          gate={GATE}
          canDecide
          kindLabel="Acceptance video"
          subjectMeta="m"
          port={<div />}
          verbs={[refusalVerb('acceptance', 'ACME-60')]}
          consequence="c"
          confirmConsequences={[]}
          onDecide={vi.fn(async () => null)}
        />
      );
    }
    renderWithIntl(<Bare />);
    openBand();
    expect(group()).toBeNull();
    expect(screen.getByTestId('refusal-no-rerun')).toBeTruthy();
  });
});

describe('the verdict on the RECORD and the ROW (panels 4a–4d, 5b)', () => {
  it.each([
    ['revise', reason.record.verdict.rerun],
    ['re_plan', reason.record.verdict.replan],
  ] as const)('an acceptance sent back with %s names it on the record', (value, words) => {
    renderWithIntl(<Frame gate={sentBack(value)} onDecide={vi.fn(async () => null)} />);
    expect(screen.getByTestId('refusal-verdict').textContent).toBe(words);
    expect(screen.getByText(`“${REASON}”`)).toBeTruthy();
  });

  it('a finished story’s verdict-less refusal reads *Sent back for a remedy* where the surface knows it', () => {
    renderWithIntl(
      <Frame gate={sentBack(null)} refusalRemedy onDecide={vi.fn(async () => null)} />,
    );
    expect(screen.getByTestId('refusal-verdict').textContent).toBe(reason.record.verdict.remedy);
  });

  it('a verdict-less refusal with no run-shape fact (a record from before the verdict) shows NO chip', () => {
    renderWithIntl(<Frame gate={sentBack(null)} onDecide={vi.fn(async () => null)} />);
    expect(screen.queryByTestId('refusal-verdict')).toBeNull();
  });

  it('a GitHub-decided acceptance record shows NO chip, even on a finished story', () => {
    renderWithIntl(
      <Frame
        gate={sentBack(null, { decisionSource: 'github' })}
        refusalRemedy
        onDecide={vi.fn(async () => null)}
      />,
    );
    expect(screen.queryByTestId('refusal-verdict')).toBeNull();
  });

  it('the chip key is kind-aware — a design’s `revise` stays *revise*', () => {
    const base = { decisionSource: 'ui' as const, remedy: false };
    expect(refusalVerdictChipKey({ ...base, kind: 'design_result', verdict: 'revise' })).toBe(
      'revise',
    );
    expect(refusalVerdictChipKey({ ...base, kind: 'acceptance_result', verdict: 'revise' })).toBe(
      'rerun',
    );
    expect(refusalVerdictChipKey({ ...base, kind: 'design_result', verdict: null })).toBeNull();
    expect(
      refusalVerdictChipKey({ ...base, kind: 'design_result', verdict: null, remedy: true }),
    ).toBeNull();
  });

  it('the decided row LEADS an acceptance’s `revise` with *Re-run*', () => {
    renderWithIntl(
      <RefusalReasonCell
        reason={REASON}
        version="c0ffee1234"
        verdict="revise"
        kind="acceptance_result"
      />,
    );
    expect(screen.getByTestId('refusal-reason-cell').textContent).toBe(
      `${verdict.rerun.label} · “${REASON}”`,
    );
  });

  it('a design row’s `revise` still leads with *Revise*', () => {
    renderWithIntl(
      <RefusalReasonCell
        reason={REASON}
        version="c0ffee1234"
        verdict="revise"
        kind="design_result"
      />,
    );
    expect(screen.getByTestId('refusal-reason-cell').textContent).toBe(
      `${reason.verdict.revise.label} · “${REASON}”`,
    );
  });
});

// ── the Development frame, acceptance leading (the story run's press site) ────────────────

const CORE_V = 'moooon/motir-core#131@3f2a91c0000000000000000000000000000000aa';
const GATEWAY_V = 'moooon/motir-gateway#57@aa11bb2000000000000000000000000000000000';
const SET_VERSION = [CORE_V, GATEWAY_V].sort().join(',');

function developmentFrame(decide: ReturnType<typeof vi.fn>) {
  function Rail() {
    return <span data-testid="rail">{useDisplayedStatus('unused')}</span>;
  }
  return renderWithIntl(
    <OptimisticStatusProvider serverStatus="in_review">
      <Rail />
      <DevelopmentSectionBody
        pullRequests={[CORE_PR, GATEWAY_PR]}
        itemIdentifier="ACME-60"
        mergeGate={{
          gate: GATE,
          canDecide: true,
          routedToLabel: 'Yue',
          members: [],
          stamp: 'v1.stamp',
          mergeSubjectVersion: SET_VERSION,
        }}
        gateActions={
          {
            decide,
            approveAndMerge: vi.fn(),
            retryMember: vi.fn(),
          } as unknown as DevelopmentGateActions
        }
        gateLayout="fill"
        canReplan
      />
    </OptimisticStatusProvider>,
  );
}

async function pressInFrame(label: string) {
  openBand();
  fireEvent.change(screen.getByLabelText(reason.label), { target: { value: REASON } });
  fireEvent.click(tile(label));
  await proceed();
}

describe('the Development frame — a story run’s acceptance sent back', () => {
  it('asks with the ACCEPTANCE subject — the pair, counting the set — never the commits lines', () => {
    developmentFrame(vi.fn());
    openBand();
    expect(group()).toBeTruthy();
    expect(
      screen.getByText(
        'Nothing moves; the merge approval is withdrawn, and motir fix works on the same pull requests with your reason.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(reason.consequence.commitsBack)).toBeNull();
    expect(screen.queryByText(reason.consequence.mergeNothing)).toBeNull();
  });

  it('RE-RUN: sends `revise`, the rail does NOT move, no merge verb is left, and NOTHING asks', async () => {
    const decide = vi.fn(async () => ({
      ok: true,
      // Even an `outcomeRef` on the row would not be painted for an acceptance refusal.
      gate: sentBack('revise', { outcomeRef: 'todo' }),
      filesKept: null,
      statusWritten: null,
    }));
    developmentFrame(decide);
    await pressInFrame(verdict.rerun.label);

    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ noteMd: REASON, refusalVerdict: 'revise' }),
    );
    expect(screen.getByTestId('rail').textContent).toBe('in_review');
    expect(
      screen.queryByRole('button', {
        name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
      }),
    ).toBeNull();
    expect(screen.getByTestId('refusal-verdict').textContent).toBe(reason.record.verdict.rerun);
    expect(screen.queryByTestId('refusal-replan-ask')).toBeNull();
    expect(screen.queryByTestId('refusal-replan-door')).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it('RE-PLAN: the band ASKS on the STORY; Not now leaves the Re-plan door on the record', async () => {
    const decide = vi.fn(async () => ({
      ok: true,
      gate: sentBack('re_plan'),
      filesKept: null,
      statusWritten: null,
    }));
    developmentFrame(decide);
    await pressInFrame(reason.verdict.replan.label);

    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ refusalVerdict: 're_plan' }));
    expect(screen.getByTestId('rail').textContent).toBe('in_review');
    const theAsk = screen.getByRole('group', { name: ask.title.replace('{key}', 'ACME-60') });
    expect(theAsk.getAttribute('data-mode')).toBe('replan');
    fireEvent.click(screen.getByRole('button', { name: en.planningWorkspace.handoff.notNow }));
    const door = screen.getByTestId('refusal-replan-door');
    expect(door.getAttribute('data-mode')).toBe('replan');
    expect(door.getAttribute('aria-label')).toBe(
      en.approvalGate.replanDoor.aria.replace('{item}', 'ACME-60'),
    );
  });
});

// ── the approval overlay — the Development arm, then the re-read ───────────────────────────

const STATUSES: ApprovalOverlayStatusDTO[] = [
  { key: 'todo', label: 'To Do', category: 'todo', isInitial: true },
  { key: 'in_review', label: 'In Review', category: 'in_progress', isInitial: false },
];

const RERUN_OFFER: WorkItemRepairViewDto = {
  state: 'offer',
  repairClass: 'acceptance_rerun',
  acceptanceRefusal: { reasonMd: REASON, decidedByLabel: 'Yue', decidedAt: '2026-09-26T10:14:00Z' },
  failing: [
    {
      repo: CORE_PR.repo,
      number: CORE_PR.number,
      ci: 'passing',
      queueExit: null,
      conflict: null,
      outOfDate: null,
    },
  ],
  lastGaveUp: null,
};

function developmentRead(repair: WorkItemRepairViewDto | null): ApprovalGateOverlayReadDTO {
  return {
    workItem: {
      id: 'wi-60',
      identifier: 'ACME-60',
      title: 'Exports list',
      status: 'in_review',
      parentIdentifier: null,
    },
    statuses: STATUSES,
    gate: GATE,
    canDecide: true,
    canReplan: true,
    routedToLabel: 'Yue',
    stamp: 'v1.stamp',
    movedSince: [],
    earlierApproval: null,
    subject: {
      state: 'resolved',
      kind: 'pull_request_approval',
      pullRequests: [CORE_PR],
      repoDelivery: [],
      deliveries: [],
      howToTest: recordDto(),
      acceptanceEvidence: null,
      acceptanceGate: null,
      designEvidence: null,
      isDesignCard: false,
      members: [],
      mergeSubjectVersion: CORE_V,
      repair,
    },
  };
}

async function openOverlay() {
  params = new URLSearchParams('tab=approvals&approval=ACME-60&approvalKind=acceptance_result');
  fetchApprovalGateOverlay.mockImplementation(async (_key: string, kind: string) =>
    kind === 'pull_request_approval' ? developmentRead(RERUN_OFFER) : developmentRead(null),
  );
  renderWithIntl(<ApprovalOverlay />);
  await act(async () => {});
  return screen.getByRole('dialog');
}

describe('the approval overlay — a story run’s acceptance sent back in the Development arm', () => {
  it('after a RE-RUN: the header chip is unchanged, the block re-reads and offers `motir fix <KEY>`, and nothing asks', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: sentBack('revise'),
      filesKept: null,
      statusWritten: null,
    });
    const dialog = await openOverlay();
    expect(within(dialog).getAllByText('In Review', { exact: true })).toHaveLength(1);
    expect(within(dialog).queryByTestId('repair-fix-part')).toBeNull();

    fireEvent.click(
      within(dialog).getByRole('button', { name: en.approvalGate.verb.requestChanges }),
    );
    fireEvent.change(within(dialog).getByLabelText(reason.label), { target: { value: REASON } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Re-run/ }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: reason.proceed }));
    });
    await act(async () => {});

    expect(decideApprovalGateAction).toHaveBeenCalledWith(
      expect.objectContaining({ refusalVerdict: 'revise', noteMd: REASON }),
    );
    // The rows and the repair view are the server's, re-read through the merge port.
    expect(fetchApprovalGateOverlay).toHaveBeenCalledWith('ACME-60', 'pull_request_approval');
    expect(within(dialog).getAllByText('In Review', { exact: true })).toHaveLength(1);
    expect(within(dialog).queryByText('To Do', { exact: true })).toBeNull();
    const part = within(dialog).getByTestId('repair-fix-part');
    expect(part.getAttribute('data-state')).toBe('offer');
    expect(within(part).getByTestId('repair-sent-back-line')).toBeTruthy();
    expect(part.textContent).toContain('motir fix ACME-60');
    expect(screen.queryByTestId('refusal-replan-ask')).toBeNull();
  });

  it('after a RE-PLAN: the band asks *Re-plan ACME-60 with Motir AI?*; yes opens the seeded planner', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: sentBack('re_plan'),
      filesKept: null,
      statusWritten: null,
    });
    const dialog = await openOverlay();
    fireEvent.click(
      within(dialog).getByRole('button', { name: en.approvalGate.verb.requestChanges }),
    );
    fireEvent.change(within(dialog).getByLabelText(reason.label), { target: { value: REASON } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Re-plan/ }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: reason.proceed }));
    });

    const theAsk = screen.getByTestId('refusal-replan-ask');
    expect(theAsk.getAttribute('data-mode')).toBe('replan');
    expect(within(theAsk).getByText(ask.title.replace('{key}', 'ACME-60'))).toBeTruthy();
    expect(within(dialog).getAllByText('In Review', { exact: true })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: ask.yes }));
    expect(shallowReplace).toHaveBeenCalledTimes(1);
    expect(shallowReplace.mock.calls[0]![0] as string).toContain(GATE.id);
  });
});

// ── the rail's bridge on the item page ─────────────────────────────────────────────────────

describe('no rail repaint from an announced acceptance refusal', () => {
  it('the item page’s rail keeps the story’s status when the overlay announces the refusal', async () => {
    const { announceGateDecided } = await import('@/lib/approvals/decidedGates');
    const { DecidedGateStatusBridge } =
      await import('@/app/(authed)/items/[key]/_components/DecidedGateStatusBridge');
    function Rail() {
      return <span data-testid="rail">{useDisplayedStatus('unused')}</span>;
    }
    render(
      <OptimisticStatusProvider serverStatus="in_review">
        <DecidedGateStatusBridge gateId={GATE.id} />
        <Rail />
      </OptimisticStatusProvider>,
    );
    act(() =>
      announceGateDecided({ gate: sentBack('revise'), filesKept: null, statusWritten: null }),
    );
    expect(screen.getByTestId('rail').textContent).toBe('in_review');
  });
});
