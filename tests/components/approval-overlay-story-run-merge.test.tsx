// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';
import type { AcceptanceEvidenceDTO } from '@/lib/dto/acceptanceEvidence';
import type { ApprovalGateDTO, ApprovalGateOverlayReadDTO } from '@/lib/dto/approvalGate';

// A STORY RUN'S ACCEPTANCE, DECIDED FROM THE OVERLAY (Bug MOTIR-6079).
//
// The item page hands the Development frame the MERGE gate's version when the story's
// acceptance leads (`LateSections`' `mergeSubjectVersion`), because the acceptance gate
// is versioned by its recording's commit and a frame counting members out of THAT counts
// none. The overlay composed the same frame and never handed it the value — so its
// consequence named no pull request, the press's per-member outcomes had no row to land
// on, and the rows' own state was never re-read (the overlay is a client island that
// `router.refresh()` cannot reach). Everything here is the OVERLAY's half; the frame's own
// suites (`development-acceptance-primary`, `development-gate-verbs`) hold the rest.

let params = new URLSearchParams();
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/workbench',
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
vi.mock('@/lib/approvals/decidedGates', () => ({
  // The decide's pending-press mark (MOTIR-9696); no row reads it here.
  markGatePressPending: vi.fn(),
  clearGatePressPending: vi.fn(),
  useGatePressPending: () => false,
  announceGateDecided: vi.fn(),
  // Read only by the item page's hand-over (MOTIR-6323); no announcement reaches it here.
  useDecidedGate: () => null,
}));

const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');

const pra = en.approvalGate.pullRequestApproval;
const acc = en.approvalGate.acceptanceResult;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

const CORE_V = `${CORE_PR.repo}#${CORE_PR.number}@3f2a91c0000000000000000000000000000000aa`;
const GATEWAY_V = `${GATEWAY_PR.repo}#${GATEWAY_PR.number}@aa11bb2000000000000000000000000000000000`;
const SET_VERSION = [CORE_V, GATEWAY_V].sort().join(',');
const PAIR = fill(pra.list.pair, {
  a: `${CORE_PR.repo} · #${CORE_PR.number}`,
  b: `${GATEWAY_PR.repo} · #${GATEWAY_PR.number}`,
});

const ACCEPTANCE_AWAITING: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  id: 'gate-acceptance-1',
  workItemId: 'wi-acme-20',
  kind: 'acceptance_result',
  subjectId: 'ae-1',
  // The RECORDING's commit — not a delivery set, which is the whole defect.
  subjectVersion: 'c0ffee1',
};
const ACCEPTANCE_APPROVED: ApprovalGateDTO = {
  ...ACCEPTANCE_AWAITING,
  state: 'approved',
  decidedById: 'user-2',
  decidedByLabel: 'Ada L.',
  decidedAt: '2026-09-22T15:02:00.000Z',
};
const MERGE_APPROVED: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  workItemId: 'wi-acme-20',
  subjectVersion: SET_VERSION,
  state: 'approved',
  decidedById: 'user-2',
  decidedByLabel: 'Ada L.',
  decidedAt: '2026-09-22T15:02:00.000Z',
};

const RECEIPT: AcceptanceEvidenceDTO = {
  id: 'ae-1',
  workItemId: 'wi-acme-20',
  status: 'pending',
  videoUrl: 'https://blob.example/run.webm',
  mimeType: 'video/webm',
  sizeBytes: 1024,
  traceUrl: null,
  chapters: [{ label: 'Run the whole story', tSeconds: 14 }],
  commitSha: 'c0ffee1',
  ciRunUrl: null,
  producedByKey: 'ACME-24',
  approvedById: null,
  approvedAt: null,
  createdAt: '2026-09-22T14:40:00.000Z',
};

/** The route's answer for a story run whose acceptance leads the Development block. */
function storyRunRead(
  over: {
    gate?: ApprovalGateDTO;
    pullRequests?: (typeof CORE_PR)[];
    mergeSubjectVersion?: string | null;
  } = {},
): ApprovalGateOverlayReadDTO {
  const gate = over.gate ?? ACCEPTANCE_AWAITING;
  return {
    workItem: {
      id: 'wi-acme-20',
      identifier: 'ACME-20',
      title: 'Hold a basket',
      status: 'in_review',
      parentIdentifier: null,
    },
    statuses: [],
    gate,
    canDecide: true,
    canReplan: false,
    routedToLabel: 'Ada L.',
    stamp: gate.state === 'awaiting' ? 'v1.stamp-on-screen' : null,
    movedSince: [],
    earlierApproval: null,
    subject: {
      state: 'resolved',
      kind: 'pull_request_approval',
      pullRequests: over.pullRequests ?? [CORE_PR, GATEWAY_PR],
      repoDelivery: [],
      deliveries: [],
      howToTest: recordDto(),
      designEvidence: null,
      isDesignCard: false,
      acceptanceEvidence: RECEIPT,
      acceptanceGate: gate.kind === 'acceptance_result' ? gate : ACCEPTANCE_APPROVED,
      members: [],
      mergeSubjectVersion:
        over.mergeSubjectVersion === undefined ? SET_VERSION : over.mergeSubjectVersion,
    },
  };
}

async function openStoryRun() {
  params = new URLSearchParams('tab=approvals&approval=ACME-20&approvalKind=acceptance_result');
  render(<ApprovalOverlay />);
  await act(async () => {});
  return screen.getByRole('dialog');
}

const rowOf = (title: string) => screen.getByText(title).closest('li')!;

async function pressApproveAndMerge() {
  fireEvent.click(screen.getByRole('button', { name: pra.verb.approveAndMerge }));
  fireEvent.click(
    screen.getByRole('button', {
      name: fill(en.approvalGate.confirm.proceed, { verb: pra.verb.approveAndMerge }),
    }),
  );
  await waitFor(() => expect(approveAndMergeAction).toHaveBeenCalledTimes(1));
  await act(async () => {});
}

beforeEach(() => {
  params = new URLSearchParams();
  fetchApprovalGateOverlay.mockReset();
  approveAndMergeAction.mockReset();
  decideApprovalGateAction.mockReset();
  refresh.mockReset();
});

afterEach(cleanup);

describe('the overlay hands the frame the MERGE gate’s version (MOTIR-6079)', () => {
  it('the consequence names BOTH pull requests the press merges — the frame counts the merge set, not zero', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(storyRunRead());
    const dialog = await openStoryRun();

    expect(
      within(dialog).getByText(fill(acc.consequenceMerges, { key: 'ACME-20', prs: PAIR })),
    ).toBeTruthy();
  });
});

describe('after Approve and merge in the overlay (MOTIR-6079)', () => {
  function pressResolves() {
    approveAndMergeAction.mockResolvedValue({
      ok: true,
      gate: ACCEPTANCE_APPROVED,
      members: [
        { subjectVersion: CORE_V, pullRequestId: CORE_PR.id, outcome: 'merged' },
        { subjectVersion: GATEWAY_V, pullRequestId: GATEWAY_PR.id, outcome: 'enqueued' },
      ],
    });
  }

  it('each pull-request row shows its press outcome — Merged, Queued to merge', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(storyRunRead());
    pressResolves();
    await openStoryRun();

    await pressApproveAndMerge();

    expect(within(rowOf(CORE_PR.title)).getByText(pra.outcome.merged)).toBeTruthy();
    expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.outcome.queued)).toBeTruthy();
  });

  it('a refused member shows Not merged on its own row — the refusal lands where it happened', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(storyRunRead());
    approveAndMergeAction.mockResolvedValue({
      ok: true,
      gate: ACCEPTANCE_APPROVED,
      members: [
        { subjectVersion: CORE_V, pullRequestId: CORE_PR.id, outcome: 'merged' },
        {
          subjectVersion: GATEWAY_V,
          pullRequestId: GATEWAY_PR.id,
          outcome: 'refused',
          refusal: { tag: 'MERGE_CONFLICT' },
        },
      ],
    });
    await openStoryRun();

    await pressApproveAndMerge();

    expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.outcome.refused)).toBeTruthy();
  });

  it('re-reads the rows through the MERGE gate’s read, so their own state is current — without remounting the frame', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(storyRunRead());
    pressResolves();
    await openStoryRun();
    expect(fetchApprovalGateOverlay).toHaveBeenCalledTimes(1);
    expect(within(rowOf(CORE_PR.title)).getByText(en.github.development.prState.open)).toBeTruthy();
    // What the server says AFTER the press: the core pull request is merged, and the
    // merge gate — not the acceptance one, which no longer ports the block — is the read.
    fetchApprovalGateOverlay.mockResolvedValue(
      storyRunRead({
        gate: MERGE_APPROVED,
        pullRequests: [{ ...CORE_PR, state: 'merged' }, GATEWAY_PR],
        mergeSubjectVersion: null,
      }),
    );

    await pressApproveAndMerge();

    await waitFor(() => expect(fetchApprovalGateOverlay).toHaveBeenCalledTimes(2));
    expect(fetchApprovalGateOverlay.mock.calls[1]!.slice(0, 2)).toEqual([
      'ACME-20',
      'pull_request_approval',
    ]);
    // The row's OWN state pill now reads the host's state — it said *Open* until the
    // re-read, because the press's *Merged* is the outcome slot, not the state.
    await waitFor(() =>
      expect(
        within(rowOf(CORE_PR.title)).queryByText(en.github.development.prState.open),
      ).toBeNull(),
    );
    expect(
      within(rowOf(CORE_PR.title)).getByText(en.github.development.prState.merged),
    ).toBeTruthy();
    // … and the frame the reader pressed is still the one on screen: the queued member
    // keeps the outcome its press reported, and the band still names the acceptance.
    expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.outcome.queued)).toBeTruthy();
    expect(screen.getAllByText(acc.kindLabel).length).toBeGreaterThan(0);
  });

  it('a refused APPROVAL re-reads nothing — no merge was attempted', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(storyRunRead());
    approveAndMergeAction.mockResolvedValue({
      ok: false,
      refusal: { tag: 'APPROVAL_GATE_ALREADY_DECIDED', decidedByLabel: 'Ada L.' },
    });
    await openStoryRun();

    await pressApproveAndMerge();

    expect(fetchApprovalGateOverlay).toHaveBeenCalledTimes(1);
  });
});
