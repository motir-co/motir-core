// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';
import type { ApprovalGateDTO, ApprovalGateOverlayReadDTO } from '@/lib/dto/approvalGate';
import type { AgentReviewViewDto } from '@/lib/dto/agentReview';

// THE AGENT REVIEW, DECIDED IN THE APPROVAL OVERLAY (Story MOTIR-1626; ADR
// `approval-gates.md` §12.3; MOTIR-6323's rule that every decision a person makes is made in
// the overlay). The item page's *Continue without the review* opens
// `?approval=<KEY>&approvalKind=agent_review` (`development-agent-review.test.tsx`); this is
// the overlay's half: the port is the delivery SET at the reviewed version, the review's own
// state sits above it, and a person is offered exactly ONE verb — the approve, worded
// *Continue without the review*, with a REQUIRED note. Never Request changes: a person has no
// refusal verb on this kind.

let params = new URLSearchParams();
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/items/ACME-12',
  useSearchParams: () => params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

const { fetchApprovalGateOverlay } = vi.hoisted(() => ({ fetchApprovalGateOverlay: vi.fn() }));
vi.mock('@/lib/approvals/approvalOverlayClient', () => ({ fetchApprovalGateOverlay }));

const { decideApprovalGateAction, approveAndMergeAction, retryApproveAndMergeMemberAction } =
  vi.hoisted(() => ({
    decideApprovalGateAction: vi.fn(),
    approveAndMergeAction: vi.fn(),
    retryApproveAndMergeMemberAction: vi.fn(),
  }));
vi.mock('@/app/(authed)/items/[key]/approvalGateActions', () => ({
  decideApprovalGateAction,
  approveAndMergeAction,
  retryApproveAndMergeMemberAction,
}));
const { announceGateDecided } = vi.hoisted(() => ({ announceGateDecided: vi.fn() }));
vi.mock('@/lib/approvals/decidedGates', () => ({
  // The decide's pending-press mark (MOTIR-9696); no row reads it here.
  markGatePressPending: vi.fn(),
  clearGatePressPending: vi.fn(),
  useGatePressPending: () => false,
  announceGateDecided,
  useDecidedGate: () => null,
}));

const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');

const ar = en.approvalGate.agentReview;
const pra = en.approvalGate.pullRequestApproval;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

const CORE_V = `${CORE_PR.repo}#${CORE_PR.number}@${CORE_PR.headSha}`;
const GATEWAY_V = `${GATEWAY_PR.repo}#${GATEWAY_PR.number}@${GATEWAY_PR.headSha}`;
const SET = [CORE_V, GATEWAY_V].sort().join(',');

const REVIEW_AWAITING: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  id: 'gate-review-1',
  kind: 'agent_review',
  subjectVersion: SET,
  createdAt: '2026-09-29T09:40:00.000Z',
};
const NOTE = 'Credits run out on the 1st — I read the diff myself.';
const REVIEW_OVERRIDDEN: ApprovalGateDTO = {
  ...REVIEW_AWAITING,
  state: 'approved',
  noteMd: NOTE,
  decidedAt: '2026-09-29T10:14:00.000Z',
  decidedUnderAuthority: 'assignee',
  decidedById: 'user-2',
  decidedByLabel: 'Zhu Yue',
};

function reviewView(over: Partial<AgentReviewViewDto> = {}): AgentReviewViewDto {
  return {
    gate: REVIEW_AWAITING,
    canDecide: true,
    routedToLabel: 'Zhu Yue',
    stamp: 'stamp-review',
    reviewUnavailableReason: 'hosted_run_out_of_credits',
    run: {
      id: 'run-611',
      label: 'motir review · 2026-09-29 09:41 UTC',
      startedAt: '2026-09-29T09:41:00.000Z',
    },
    settingsDoorHref: null,
    ...over,
  };
}

/** The route's answer for an `agent_review` address (`readSubject`'s `agent_review` arm). */
function reviewRead(
  over: { canDecide?: boolean; agentReview?: AgentReviewViewDto } = {},
): ApprovalGateOverlayReadDTO {
  const canDecide = over.canDecide ?? true;
  return {
    workItem: {
      id: 'wi-acme-12',
      identifier: 'ACME-12',
      title: 'Rate-limit the public API',
      status: 'in_review',
      parentIdentifier: null,
    },
    statuses: [],
    gate: REVIEW_AWAITING,
    canDecide,
    canReplan: false,
    routedToLabel: 'Zhu Yue',
    stamp: 'stamp-review',
    movedSince: [],
    earlierApproval: null,
    subject: {
      state: 'resolved',
      kind: 'pull_request_approval',
      pullRequests: [CORE_PR, GATEWAY_PR],
      repoDelivery: [],
      deliveries: [],
      howToTest: recordDto(),
      designEvidence: null,
      isDesignCard: false,
      acceptanceEvidence: null,
      acceptanceGate: null,
      members: [],
      repair: null,
      agentReview: over.agentReview ?? reviewView({ canDecide }),
    },
  };
}

async function openReview(messages?: Record<string, unknown>) {
  params = new URLSearchParams('approval=ACME-12&approvalKind=agent_review');
  render(<ApprovalOverlay />, messages ? { messages, locale: 'zh' } : {});
  await act(async () => {});
  return screen.getByRole('dialog');
}

const verbButtons = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole('button')
    .map((b) => b.textContent?.trim() ?? '')
    .filter((name) =>
      [
        ar.verb.continueWithout,
        ar.verb.reviewAgain,
        pra.verb.approveAndMerge,
        en.approvalGate.verb.approve,
        en.approvalGate.verb.requestChanges,
      ].includes(name),
    );

beforeEach(() => {
  params = new URLSearchParams();
  fetchApprovalGateOverlay.mockReset();
  decideApprovalGateAction.mockReset();
  approveAndMergeAction.mockReset();
  announceGateDecided.mockReset();
  refresh.mockReset();
});

afterEach(cleanup);

describe('an agent_review address opens the overlay on its gate', () => {
  it('reads the agent_review kind, and draws the delivery set with the review’s state above it', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(reviewRead());
    const dialog = await openReview();

    expect(fetchApprovalGateOverlay).toHaveBeenCalledWith(
      'ACME-12',
      'agent_review',
      expect.anything(),
    );
    expect(screen.getByRole('dialog', { name: 'Agent review for ACME-12' })).toBe(dialog);
    // Never the not-built-yet arm.
    expect(within(dialog).queryByText(en.workbench.approvals.notRenderable)).toBeNull();
    // The subject: both pull requests of the reviewed set.
    expect(within(dialog).getByText(CORE_PR.title)).toBeTruthy();
    expect(within(dialog).getByText(GATEWAY_PR.title)).toBeTruthy();
    // The review's state and its reason.
    const band = within(dialog).getByTestId('agent-review-band');
    expect(band.dataset.state).toBe('could-not-run');
    expect(band.textContent).toContain(ar.couldNotRun.reason.no_credits);
    expect(within(dialog).getByText(ar.state.couldNotRun)).toBeTruthy();
  });

  it('offers a person exactly ONE verb — Continue without the review; never Request changes', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(reviewRead());
    const dialog = await openReview();

    expect(verbButtons(dialog)).toEqual([ar.verb.continueWithout]);
  });

  it('a reader it is not routed to sees who it waits on, and no verb at all', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(reviewRead({ canDecide: false }));
    const dialog = await openReview();

    expect(verbButtons(dialog)).toEqual([]);
    expect(
      within(dialog).getByText(fill(ar.couldNotRun.whyNotYours, { name: 'Zhu Yue' })),
    ).toBeTruthy();
  });

  it('while the review is still running, nothing is offered', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(
      reviewRead({ agentReview: reviewView({ reviewUnavailableReason: null }) }),
    );
    const dialog = await openReview();

    expect(within(dialog).getByTestId('agent-review-band').dataset.state).toBe('reviewing');
    expect(verbButtons(dialog)).toEqual([]);
  });
});

describe('Continue without the review — decided here, with a required note', () => {
  it('confirms, refuses an empty note in place, then approves through the decide door', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(reviewRead());
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: REVIEW_OVERRIDDEN,
      filesKept: null,
      statusWritten: null,
    });
    const dialog = await openReview();

    fireEvent.click(within(dialog).getByRole('button', { name: ar.verb.continueWithout }));
    // The confirm names what the press records — under the presser's name, with the reason.
    expect(within(dialog).getByText(ar.override.title)).toBeTruthy();
    expect(within(dialog).getByText(ar.override.records)).toBeTruthy();
    expect(within(dialog).getByText(ar.override.helper)).toBeTruthy();

    // Empty: refused in place; nothing reaches the door.
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: ar.override.proceed }));
    });
    expect(within(dialog).getByText(ar.override.required)).toBeTruthy();
    expect(decideApprovalGateAction).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(ar.override.label), {
      target: { value: NOTE },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: ar.override.proceed }));
    });
    await waitFor(() => expect(decideApprovalGateAction).toHaveBeenCalledTimes(1));
    expect(decideApprovalGateAction).toHaveBeenCalledWith({
      gateId: REVIEW_AWAITING.id,
      decision: 'approve',
      identifier: 'ACME-12',
      stamp: 'stamp-review',
      noteMd: NOTE,
    });
    // Never the merge door: the override raises the ordinary gate, it merges nothing.
    expect(approveAndMergeAction).not.toHaveBeenCalled();
    // The page underneath settles, and the server surfaces re-read.
    expect(announceGateDecided).toHaveBeenCalledWith({
      gate: REVIEW_OVERRIDDEN,
      filesKept: null,
    });
    expect(refresh).toHaveBeenCalled();

    // The decided record: a person continued without the review — never "Passed".
    const band = within(dialog).getByTestId('agent-review-band');
    expect(band.dataset.state).toBe('override');
    expect(band.textContent).toContain('Continued without the review by Zhu Yue');
    expect(band.textContent).not.toContain(ar.passed.pill);
    expect(verbButtons(dialog)).toEqual([]);
  });

  it('a refusal from the door is drawn in place, and the verb stays the one verb', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(reviewRead());
    decideApprovalGateAction.mockResolvedValue({
      ok: false,
      refusal: { tag: 'APPROVAL_GATE_NOT_AUTHORISED' },
    });
    const dialog = await openReview();

    fireEvent.click(within(dialog).getByRole('button', { name: ar.verb.continueWithout }));
    fireEvent.change(within(dialog).getByLabelText(ar.override.label), {
      target: { value: NOTE },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: ar.override.proceed }));
    });
    expect(within(dialog).getByRole('alert')).toBeTruthy();
    expect(within(dialog).getByTestId('agent-review-band').dataset.state).toBe('could-not-run');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('the approve-and-merge gate — the review that passed it sits above Approve and merge', () => {
  // `design/github` § 30 Panels 2a/2b (`approve-and-merge--agent-review.mock.html`): opened on
  // the `pull_request_approval` gate, the overlay draws *Reviewed by the review agent ·
  // Passed* with its summary and the findings behind the disclosure, then the ordinary verbs.
  const MERGE_AT_SET: ApprovalGateDTO = { ...AWAITING_MERGE_GATE, subjectVersion: SET };
  const FINDINGS = 'Meets every acceptance criterion.\n\n- `app/header.tsx:12` renders `0`.';
  const REVIEW_PASSED: ApprovalGateDTO = {
    ...REVIEW_AWAITING,
    state: 'approved',
    noteMd: FINDINGS,
    decidedAt: '2026-09-29T09:50:00.000Z',
    decidedUnderAuthority: 'review_agent',
    decidedByLabel: 'Review agent',
  };

  function mergeRead(): ApprovalGateOverlayReadDTO {
    const read = reviewRead({
      agentReview: reviewView({ gate: REVIEW_PASSED, reviewUnavailableReason: null }),
    });
    return { ...read, gate: MERGE_AT_SET, stamp: 'stamp-merge' };
  }

  it('draws the pass — summary, then the findings on demand — above Approve and merge', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(mergeRead());
    params = new URLSearchParams('approval=ACME-12&approvalKind=pull_request_approval');
    render(<ApprovalOverlay />);
    await act(async () => {});
    const dialog = screen.getByRole('dialog');

    const band = within(dialog).getByTestId('agent-review-band');
    expect(band.dataset.state).toBe('passed');
    expect(band.textContent).toContain(ar.passed.title);
    expect(band.textContent).toContain(ar.passed.pill);
    expect(within(band).getByTestId('agent-review-summary').textContent).toContain(
      'Meets every acceptance criterion.',
    );
    fireEvent.click(within(band).getByRole('button', { name: ar.findings.show }));
    expect(within(band).getByTestId('agent-review-findings').textContent).toContain(
      'app/header.tsx:12',
    );
    // Above the verb: the band precedes Approve and merge in document order.
    const verb = within(dialog).getByRole('button', { name: pra.verb.approveAndMerge });
    expect(band.compareDocumentPosition(verb) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(verbButtons(dialog)).toContain(pra.verb.approveAndMerge);
  });

  it('a merge gate the read hands no review draws no band', async () => {
    const read = mergeRead();
    fetchApprovalGateOverlay.mockResolvedValue({
      ...read,
      subject: { ...read.subject, agentReview: null },
    } as ApprovalGateOverlayReadDTO);
    params = new URLSearchParams('approval=ACME-12&approvalKind=pull_request_approval');
    render(<ApprovalOverlay />);
    await act(async () => {});
    expect(within(screen.getByRole('dialog')).queryByTestId('agent-review-band')).toBeNull();
  });
});

describe('zh', () => {
  it('renders the kind and its one verb without a missing key', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(reviewRead());
    const dialog = await openReview(zh);
    const zar = zh.approvalGate.agentReview;
    expect(within(dialog).getByRole('button', { name: zar.verb.continueWithout })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: zar.verb.reviewAgain })).toBeNull();
    expect(dialog.textContent).not.toContain('approvalGate.');
  });
});
