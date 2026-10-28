// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';
import type { ApprovalGateDTO, ApprovalGateOverlayReadDTO } from '@/lib/dto/approvalGate';
import type { DecisionDocumentViewDTO } from '@/lib/dto/decisionDocument';
import type { DesignEvidenceDTO } from '@/lib/dto/designEvidence';

// A DESIGN OR DECISION PRIMARY THAT ALSO MERGES LANDS EACH MERGE ON ITS ROW (Bug MOTIR-6080).
//
// The Development frame counts the pull requests one press merges out of a version, and it
// used to read the LEADING gate's. A design gate is versioned by its published commit and a
// decision gate by `owner/name:path@blob` — neither is a delivery set, so the frame counted
// zero members: a design-led consequence named no pull request, and after *Approve and merge*
// the per-member outcomes had no row to land on. MOTIR-6079 fixed the acceptance primary;
// the item page and the overlay now hand the merge gate's version for every primary. The
// item page's half is `LateSections`' `frameGateFor`, rendered here through the real
// `LateUpperSections`; the overlay's half is the route (`approval-gate-route.test.ts`) plus
// the frame the overlay composes from its answer, rendered here.

let params = new URLSearchParams();
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({
    push,
    refresh,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => '/workbench',
  useSearchParams: () => params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
}));

const { fetchApprovalGateOverlay } = vi.hoisted(() => ({ fetchApprovalGateOverlay: vi.fn() }));
vi.mock('@/lib/approvals/approvalOverlayClient', () => ({ fetchApprovalGateOverlay }));

const {
  decideApprovalGateAction,
  approveAndMergeAction,
  retryApproveAndMergeMemberAction,
  queueAgainAutoAction,
} = vi.hoisted(() => ({
  decideApprovalGateAction: vi.fn(),
  approveAndMergeAction: vi.fn(),
  retryApproveAndMergeMemberAction: vi.fn(),
  queueAgainAutoAction: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/approvalGateActions', () => ({
  decideApprovalGateAction,
  approveAndMergeAction,
  retryApproveAndMergeMemberAction,
  queueAgainAutoAction,
}));
vi.mock('@/lib/approvals/decidedGates', () => ({
  announceGateDecided: vi.fn(),
  // Read only by the item page's hand-over (MOTIR-6323); no announcement reaches it here.
  useDecidedGate: () => null,
  // The press-in-flight mark (MOTIR-9696) has nothing to tell a list here.
  markGatePressPending: () => {},
  clearGatePressPending: () => {},
  useGatePressPending: () => false,
}));

// The item page's late stack, with only its unrelated neighbours stubbed — the same set
// `late-stack-development-block.test.tsx` stubs.
vi.mock('@/app/(authed)/items/[key]/_components/lateReads', () => ({ RUN_HISTORY_PAGE: 20 }));
vi.mock('@/app/(authed)/items/[key]/_components/runTimes', () => ({ formatRunTimes: () => ({}) }));
vi.mock('@/app/(authed)/items/[key]/_components/RunSection', () => ({ RunSection: () => null }));
vi.mock('@/app/(authed)/items/[key]/_components/AcceptancePanel', () => ({
  AcceptancePanel: () => null,
}));
vi.mock('@/app/(authed)/items/[key]/_components/DesignResultSection', () => ({
  DesignResultSection: () => null,
}));
vi.mock('@/app/(authed)/items/[key]/_components/DecidedGateStatusBridge', () => ({
  DecidedGateStatusBridge: () => null,
}));
vi.mock('@/app/(authed)/items/[key]/_components/DevelopmentLinkControl', () => ({
  DevelopmentLinkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LinkPullRequestDoor: () => null,
  LinkPullRequestForm: () => null,
  RemovePullRequestLinkButton: () => null,
}));

const { LateUpperSections } = await import('@/app/(authed)/items/[key]/_components/LateSections');
const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');
type LateReads = import('@/app/(authed)/items/[key]/_components/lateReads').LateReads;

const pra = en.approvalGate.pullRequestApproval;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

const CORE_V = `${CORE_PR.repo}#${CORE_PR.number}@${CORE_PR.headSha}`;
const GATEWAY_V = `${GATEWAY_PR.repo}#${GATEWAY_PR.number}@${GATEWAY_PR.headSha}`;
const SET_VERSION = [CORE_V, GATEWAY_V].sort().join(',');
const PAIR = fill(pra.list.pair, {
  a: `${CORE_PR.repo} · #${CORE_PR.number}`,
  b: `${GATEWAY_PR.repo} · #${GATEWAY_PR.number}`,
});

const MERGE_AWAITING: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  subjectVersion: SET_VERSION,
};
const DESIGN_AWAITING: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  id: 'gate-design-1',
  kind: 'design_result',
  subjectId: 'ev-1',
  // The design's PUBLISHED COMMIT — not a delivery set, which is the whole defect.
  subjectVersion: 'cafe1234567',
};
const DECISION_AWAITING: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  id: 'gate-decision-1',
  kind: 'decision_approval',
  subjectId: 'wi-acme-12',
  // `owner/name:path@blob` — the document, not a delivery set.
  subjectVersion: 'moooon/motir-core:docs/decisions/rate-limit.md@b10b000',
};
const approvedOf = (gate: ApprovalGateDTO): ApprovalGateDTO => ({
  ...gate,
  state: 'approved',
  decidedById: 'user-2',
  decidedByLabel: 'Ada L.',
  decidedAt: '2026-09-23T10:00:00.000Z',
});

const EVIDENCE: DesignEvidenceDTO = {
  id: 'ev-1',
  workItemId: 'wi-acme-12',
  noteMd: null,
  noteTruncated: false,
  assets: [
    {
      id: 'a-mock',
      kind: 'mock',
      url: '/api/attachments/att-mock/content',
      mimeType: 'text/html',
      sizeBytes: 10,
      sourcePath: 'design/work-items/x--change.mock.html',
      position: 0,
    },
  ],
  commitSha: 'cafe1234567',
  ciRunUrl: null,
  producedByKey: 'ACME-12',
  createdAt: '2026-09-23T09:00:00.000Z',
  withdrawnAt: null,
  withdrawnById: null,
  withdrawnReason: null,
};

const DOCUMENT: DecisionDocumentViewDTO = {
  outcome: 'resolved',
  repo: CORE_PR.repo,
  number: CORE_PR.number,
  path: 'docs/decisions/rate-limit.md',
  blobSha: 'b10b000',
  headSha: CORE_PR.headSha,
  markdown: '# ADR: Rate-limit the public API',
  workItemRefs: {},
  hostUrl: `https://github.com/${CORE_PR.repo}/blob/${CORE_PR.headSha}/docs/decisions/rate-limit.md`,
};

/** The press's answer: one member merged now, the other queued. */
function pressResolves(gate: ApprovalGateDTO) {
  approveAndMergeAction.mockResolvedValue({
    ok: true,
    gate: approvedOf(gate),
    members: [
      { subjectVersion: CORE_V, pullRequestId: CORE_PR.id, outcome: 'merged' },
      { subjectVersion: GATEWAY_V, pullRequestId: GATEWAY_PR.id, outcome: 'enqueued' },
    ],
  });
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

function expectRowOutcomes() {
  expect(within(rowOf(CORE_PR.title)).getByText(pra.outcome.merged)).toBeTruthy();
  expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.outcome.queued)).toBeTruthy();
}

beforeEach(() => {
  params = new URLSearchParams();
  fetchApprovalGateOverlay.mockReset();
  approveAndMergeAction.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ type: 'opaqueredirect', ok: false, status: 0 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── THE ITEM PAGE ─────────────────────────────────────────────────────────────

const noGate = {
  gate: null,
  canDecide: false,
  routedToLabel: null,
  earlierApproval: null,
  settingsDoor: null,
  stamp: null,
  movedSince: [],
};

/** A card with two open pull requests, an awaiting merge gate, and `over`'s primary. */
function reads(over: Partial<LateReads>): LateReads {
  return {
    pullRequests: [CORE_PR, GATEWAY_PR],
    commentCaps: {} as LateReads['commentCaps'],
    attachmentCaps: {} as LateReads['attachmentCaps'],
    initialComments: null,
    initialHistory: null,
    initialAll: null,
    initialAttachments: null,
    acceptanceEligibility: null,
    acceptanceEvidence: null,
    showAcceptance: false,
    acceptanceGate: noGate,
    projectId: 'proj-acme',
    designEvidence: null,
    isDesignCard: false,
    designGate: { ...noGate, subject: null },
    runs: [],
    scopeRun: null,
    howToTest: recordDto(),
    mergeGate: {
      ...noGate,
      gate: MERGE_AWAITING,
      canDecide: true,
      stamp: 'stamp-merge',
      members: [],
      autoQueueExits: [],
    },
    repair: null,
    monitorIssueLinks: [],
    monitorHasConnection: false,
    continueView: { state: 'none' },
    decisionGate: { ...noGate, document: null },
    choiceGate: { ...noGate, body: null },
    confirmGate: { ...noGate, body: null },
    agentReview: null,
    ...over,
  } as LateReads;
}

async function renderItemPage(r: LateReads) {
  const ui = await LateUpperSections({
    reads: Promise.resolve(r),
    itemId: 'wi-acme-12',
    itemIdentifier: 'ACME-12',
    currentUserId: 'user-2',
    canEdit: true,
    repoDelivery: [],
    deliveries: [],
  });
  const result = render(ui);
  // The design port reports RENDERED once its mock probe settles, and only then does the
  // frame draw its verbs (state `X`) — let that probe land.
  await act(async () => {});
  return result;
}

const designLed = () =>
  reads({
    designEvidence: EVIDENCE,
    isDesignCard: true,
    designGate: {
      ...noGate,
      gate: DESIGN_AWAITING,
      canDecide: true,
      routedToLabel: 'Ada L.',
      stamp: 'stamp-design',
      subject: null,
    },
  });

const decisionLed = () =>
  reads({
    decisionGate: {
      ...noGate,
      gate: DECISION_AWAITING,
      canDecide: true,
      routedToLabel: 'Ada L.',
      stamp: 'stamp-decision',
      document: DOCUMENT,
    },
  });

// ⚠️ AMENDED by MOTIR-6323: the item page HANDS THE DECISION OVER. A decider's page draws the
// block and the band's ONE door — no frame and no press — so the page half of MOTIR-6080 is
// that the band COUNTS the set one press merges and opens the overlay on the LEADING gate;
// the press and its per-row outcomes are the overlay's, asserted below.
const door = () => screen.getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove });

describe('the item page — a DESIGN-led question beside an awaiting merge gate (MOTIR-6080)', () => {
  it('the band counts BOTH pull requests one press merges, and opens the DESIGN question', async () => {
    await renderItemPage(designLed());

    expect(
      screen.getByText(
        new RegExp(`^${en.approvalGate.designResult.kindLabel} · 2 pull requests · `),
      ),
    ).toBeTruthy();
    expect(door().getAttribute('href')).toContain('design_result');
  });

  it('no press on the page — the verb is the overlay’s', async () => {
    await renderItemPage(designLed());

    expect(screen.queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
    expect(approveAndMergeAction).not.toHaveBeenCalled();
  });
});

describe('the item page — a DECISION-led question beside an awaiting merge gate (MOTIR-6080)', () => {
  it('the band opens the DECISION question, and the page draws no press', async () => {
    await renderItemPage(decisionLed());

    expect(door().getAttribute('href')).toContain('decision_approval');
    expect(screen.getByText(pra.cta.bodyDecision)).toBeTruthy();
    expect(screen.queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
  });
});

// ── THE APPROVAL OVERLAY ──────────────────────────────────────────────────────

/** The route's answer when a design or decision gate leads the Development block. */
function primaryRead(gate: ApprovalGateDTO): ApprovalGateOverlayReadDTO {
  return {
    workItem: {
      id: 'wi-acme-12',
      identifier: 'ACME-12',
      title: 'Throttle the public API',
      status: 'in_review',
      parentIdentifier: null,
    },
    statuses: [],
    gate,
    canDecide: true,
    canReplan: false,
    routedToLabel: 'Ada L.',
    stamp: 'v1.stamp-on-screen',
    movedSince: [],
    earlierApproval: null,
    subject: {
      state: 'resolved',
      kind: 'pull_request_approval',
      pullRequests: [CORE_PR, GATEWAY_PR],
      repoDelivery: [],
      deliveries: [],
      howToTest: recordDto(),
      designEvidence: gate.kind === 'design_result' ? EVIDENCE : null,
      isDesignCard: false,
      acceptanceEvidence: null,
      acceptanceGate: null,
      members: [],
      // What the route now hands back for every primary (MOTIR-6080).
      mergeSubjectVersion: SET_VERSION,
      ...(gate.kind === 'decision_approval' ? { decision: { document: DOCUMENT } } : {}),
    },
  };
}

async function openOverlay(kind: 'design_result' | 'decision_approval') {
  params = new URLSearchParams(`tab=approvals&approval=ACME-12&approvalKind=${kind}`);
  render(<ApprovalOverlay />);
  await act(async () => {});
  return screen.getByRole('dialog');
}

describe('the approval overlay — a DESIGN-led port (MOTIR-6080)', () => {
  it('names both pull requests, and after Approve and merge each row shows its outcome', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(primaryRead(DESIGN_AWAITING));
    pressResolves(DESIGN_AWAITING);
    const dialog = await openOverlay('design_result');
    expect(
      within(dialog).getByText(fill(pra.consequence.named, { prs: PAIR, key: 'ACME-12' })),
    ).toBeTruthy();

    await pressApproveAndMerge();

    expectRowOutcomes();
  });
});

describe('the approval overlay — a DECISION-led port (MOTIR-6080)', () => {
  it('after Approve and merge each row shows its outcome', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(primaryRead(DECISION_AWAITING));
    pressResolves(DECISION_AWAITING);
    await openOverlay('decision_approval');

    await pressApproveAndMerge();

    expectRowOutcomes();
  });
});
