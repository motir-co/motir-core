// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import messages from '@/messages/en.json';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';

// THE LATE STACK GAINS NO HOW TO TEST SECTION (Story MOTIR-4906 · Subtask
// MOTIR-5336, design/github §20). How to test renders INSIDE the Development
// section card, below the rows — "never a section card or section header of its
// own". This renders the item page's real `LateUpperSections` over a fixture
// read, so a second `ContentSectionCard` for it anywhere in the stack fails here.

// The How-to-test write doors mount a provider that calls `useRouter` for the
// save's refresh (MOTIR-5455), and happy-dom has no app router. Only the router
// is stubbed — the REAL provider and its doors still render, so a door that
// stopped appearing would fail here rather than be mocked out of view.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  // The Development band's door builds its overlay address from the page's own (MOTIR-6323).
  usePathname: () => '/items/ACME-12',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages, namespace: namespace as never }),
}));
vi.mock('@/app/(authed)/items/[key]/_components/lateReads', () => ({ RUN_HISTORY_PAGE: 20 }));
vi.mock('@/app/(authed)/items/[key]/_components/runTimes', () => ({ formatRunTimes: () => ({}) }));
vi.mock('@/app/(authed)/items/[key]/_components/RunSection', () => ({ RunSection: () => null }));
vi.mock('@/app/(authed)/items/[key]/_components/AcceptancePanel', () => ({
  // A marker, so a test can see whether the STANDALONE section rendered.
  AcceptancePanel: () => <div data-testid="standalone-acceptance" />,
}));
vi.mock('@/app/(authed)/items/[key]/_components/DesignResultSection', () => ({
  // A marker, so a test can see whether the STANDALONE section rendered.
  DesignResultSection: () => <div data-testid="standalone-design-result" />,
}));
vi.mock('@/app/(authed)/items/[key]/_components/DecidedGateStatusBridge', () => ({
  // A marker, so a test can see whether the page listens for an overlay decision.
  DecidedGateStatusBridge: ({ gateId }: { gateId: string }) => (
    <div data-testid="decided-gate-status-bridge" data-gate-id={gateId} />
  ),
}));
vi.mock('@/app/(authed)/items/[key]/_components/DevelopmentLinkControl', () => ({
  DevelopmentLinkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LinkPullRequestDoor: () => null,
  LinkPullRequestForm: () => null,
  RemovePullRequestLinkButton: () => null,
}));

import { LateUpperSections } from '@/app/(authed)/items/[key]/_components/LateSections';
import type { LateReads } from '@/app/(authed)/items/[key]/_components/lateReads';
import type { DesignEvidenceDTO } from '@/lib/dto/designEvidence';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

afterEach(cleanup);

const htt = messages.github.development.howToTest;

function reads(): LateReads {
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
    // Not a story in review, so the acceptance section is not drawn at all.
    showAcceptance: false,
    acceptanceGate: {
      gate: null,
      canDecide: false,
      routedToLabel: null,
      earlierApproval: null,
      settingsDoor: null,
      stamp: null,
      // Nothing was asked, so nothing moved (Story MOTIR-5238 · MOTIR-5243).
      movedSince: [],
    },
    projectId: 'proj-acme',
    designEvidence: null,
    isDesignCard: false,
    designGate: {
      gate: null,
      canDecide: false,
      routedToLabel: null,
      earlierApproval: null,
      settingsDoor: null,
      stamp: null,
      // Nothing was asked, so nothing moved (Story MOTIR-5238 · MOTIR-5243).
      movedSince: [],
      subject: null,
    },
    runs: [],
    // No scoped run on this fixture's item (MOTIR-5363) — the Run section is
    // mocked here, and `null` is what the read answers for such an item.
    scopeRun: null,
    howToTest: recordDto(),
    mergeGate: {
      gate: null,
      canDecide: false,
      routedToLabel: null,
      earlierApproval: null,
      settingsDoor: null,
      stamp: null,
      // Nothing was asked, so nothing moved (Story MOTIR-5238 · MOTIR-5243).
      movedSince: [],
      members: [],
      autoQueueExits: [],
    },
    // No repair to show — also what a FAILED repair read answers (MOTIR-5466).
    repair: null,
    // No monitor links, no connection — the Errors section draws nothing (MOTIR-5732).
    monitorIssueLinks: [],
    monitorHasConnection: false,
    continueView: { state: 'none' },
    // Not a decision card — no decision gate, no document (MOTIR-5678).
    decisionGate: {
      gate: null,
      canDecide: false,
      routedToLabel: null,
      earlierApproval: null,
      settingsDoor: null,
      stamp: null,
      movedSince: [],
      document: null,
    },
    // Not a choice — no choice gate, no body (MOTIR-5896).
    choiceGate: {
      gate: null,
      canDecide: false,
      routedToLabel: null,
      earlierApproval: null,
      settingsDoor: null,
      stamp: null,
      movedSince: [],
      body: null,
    },
    // Not a `human` decision — no confirm gate, no body (MOTIR-5954).
    confirmGate: {
      gate: null,
      canDecide: false,
      routedToLabel: null,
      earlierApproval: null,
      settingsDoor: null,
      stamp: null,
      movedSince: [],
      body: null,
    },
    // No agent review on the card (MOTIR-6825).
    agentReview: null,
    gatedRun: null,
  };
}

describe('the late stack — How to test is part of the Development card (MOTIR-5336)', () => {
  it('renders the rows and How to test inside ONE section card, and no How to test section', async () => {
    const ui = await LateUpperSections({
      reads: Promise.resolve(reads()),
      itemId: 'wi-acme-12',
      itemIdentifier: 'ACME-12',
      currentUserId: 'u-viewer',
      canEdit: true,
      repoDelivery: [],
      deliveries: [],
    });
    const { container } = render(ui);

    // Section titles in the stack are `h2`s; How to test is never one of them.
    const sectionTitles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(sectionTitles).toContain(messages.github.development.title);
    expect(sectionTitles).not.toContain(htt.title);

    const cards = [...container.querySelectorAll('[data-surface="card"]')];
    const development = cards.filter((card) =>
      within(card as HTMLElement).queryByRole('heading', {
        level: 2,
        name: messages.github.development.title,
      }),
    );
    expect(development).toHaveLength(1);
    const card = development[0] as HTMLElement;
    expect(within(card).getByText(CORE_PR.title)).toBeTruthy();
    expect(within(card).getByText(GATEWAY_PR.title)).toBeTruthy();
    expect(within(card).getByRole('heading', { level: 4, name: htt.title })).toBeTruthy();

    // Exactly one How to test on the whole stack, and it is that card's.
    const parts = screen.getAllByRole('group', { name: htt.title });
    expect(parts).toHaveLength(1);
    expect(card.contains(parts[0]!)).toBe(true);
    // The gloss is the replaced one.
    expect(card.textContent).toContain(messages.github.development.gloss);
    expect(messages.github.development.gloss).toBe(
      'Pull requests and how to test them · live PR and CI status',
    );
  });
});

// ── THE AGENT REVIEW — the smoke (Story MOTIR-1626 · MOTIR-6825; design/github § 30) ──
// The item page's REAL late stack over a card whose run target holds an awaiting
// `agent_review`: the Development card IS its frame, and the Reviewing landmark is in it —
// never the call-to-action band into the approval overlay (§12.1: it is not on To approve).
describe('the late stack — an awaiting agent review reads Reviewing in the Development card', () => {
  it('draws the Reviewing band and pill inside the Development card', async () => {
    const review: ApprovalGateDTO = {
      ...AWAITING_MERGE_GATE,
      id: 'gate-review-smoke',
      kind: 'agent_review',
      subjectVersion: `moooon/motir-core#131@${CORE_PR.headSha}`,
    };
    const ui = await LateUpperSections({
      reads: Promise.resolve({
        ...reads(),
        agentReview: {
          gate: review,
          canDecide: true,
          routedToLabel: 'Ada L.',
          stamp: 'stamp-review',
          reviewUnavailableReason: null,
          run: {
            id: 'run-611',
            label: 'motir review · 2026-09-29 09:41 UTC',
            startedAt: '2026-09-29T09:41:00.000Z',
          },
          settingsDoorHref: null,
        },
      }),
      itemId: 'wi-acme-12',
      itemIdentifier: 'ACME-12',
      currentUserId: 'user-2',
      canEdit: true,
      repoDelivery: [],
      deliveries: [],
    });
    const { container } = render(ui);
    const card = [...container.querySelectorAll('[data-surface="card"]')].find((c) =>
      within(c as HTMLElement).queryByRole('heading', {
        level: 2,
        name: messages.github.development.title,
      }),
    ) as HTMLElement;
    const landmark = within(card).getByTestId('agent-review-band');
    expect(landmark.getAttribute('role')).toBe('status');
    expect(landmark.textContent).toContain(messages.approvalGate.agentReview.reviewing.title);
    expect(within(card).getByText(messages.approvalGate.agentReview.state.reviewing)).toBeTruthy();
    expect(
      within(card).queryByRole('link', {
        name: messages.approvalGate.statusHeld.reviewAndApprove,
      }),
    ).toBeNull();
  });
});

// ── The FIX PART (Story MOTIR-5460 · MOTIR-5466, design/github § 21) ─────────
describe('the late stack — the fix part sits inside the Development card', () => {
  const fix = messages.github.development.fix;
  const render_ = async (repair: LateReads['repair']) =>
    render(
      await LateUpperSections({
        reads: Promise.resolve({ ...reads(), repair }),
        itemId: 'wi-acme-12',
        itemIdentifier: 'ACME-12',
        currentUserId: 'u-viewer',
        canEdit: true,
        repoDelivery: [],
        deliveries: [],
      }),
    );

  it('draws the part below the rows and above How to test, in the same card', async () => {
    await render_({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [
        {
          repo: CORE_PR.repo,
          number: CORE_PR.number,
          ci: 'failing',
          queueExit: null,
          conflict: null,
        },
      ],
      lastGaveUp: null,
    });

    const part = screen.getByRole('group', { name: fix.aria.part });
    const howToTest = screen.getByRole('group', { name: htt.title });
    expect(part.compareDocumentPosition(howToTest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const row = screen.getByText(CORE_PR.title);
    expect(row.compareDocumentPosition(part) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(part).getByText('motir fix ACME-12')).toBeTruthy();
  });

  it('a failed repair read (null) renders the block WITHOUT the part — never an error', async () => {
    const { container } = await render_(null);

    expect(screen.queryByRole('group', { name: fix.aria.part })).toBeNull();
    expect(container.textContent).toContain(CORE_PR.title);
    expect(screen.getByRole('group', { name: htt.title })).toBeTruthy();
  });
});

// ── Q8 (Story MOTIR-5488 · MOTIR-5498) ───────────────────────────────────────
// A design card whose open linked pull requests carry the decision renders its
// result INSIDE the Development card and no standalone Design result section;
// the same card with no open pull request gets the section back.
describe('the late stack — a design result with open linked pull requests (Q8)', () => {
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
      {
        id: 'a-note',
        kind: 'note_file',
        url: '/api/attachments/att-note/content',
        mimeType: 'text/markdown',
        sizeBytes: 10,
        sourcePath: 'design/work-items/design-notes.md',
        position: 1,
      },
    ],
    commitSha: 'cafe1234567',
    ciRunUrl: null,
    producedByKey: 'ACME-12',
    createdAt: '2026-09-14T00:00:00.000Z',
    withdrawnAt: null,
    withdrawnById: null,
    withdrawnReason: null,
  };

  async function renderStack(pullRequests: LateReads['pullRequests']) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ type: 'opaqueredirect', ok: false, status: 0 })),
    );
    const base = reads();
    const ui = await LateUpperSections({
      reads: Promise.resolve({
        ...base,
        pullRequests,
        designEvidence: EVIDENCE,
        isDesignCard: true,
        // ⚠️ THE CARD HOLDS ITS DESIGN GATE (MOTIR-5667, reversing AMENDMENT 4 Q8).
        // These fixtures carried NO design gate because a card with an open pull
        // request raised none — which is MOTIR-5652, and the state the product no
        // longer produces. The placement is derived from the gate now, so a fixture
        // without one is describing a card that cannot exist.
        designGate: {
          ...base.designGate,
          gate: {
            id: 'gate-design-1',
            workItemId: 'wi-acme-12',
            kind: 'design_result' as const,
            subjectId: EVIDENCE.id,
            state: 'awaiting' as const,
            decidedById: null,
            decidedAt: null,
            noteMd: null,
            supersededCause: null,
            subjectVersion: EVIDENCE.commitSha,
            decidedByLabel: null,
            routedToId: 'u-viewer',
            decidedUnderAuthority: null,
            decisionSource: null,
            outcomeRef: null,
            confirmedRecord: null,
            refusalVerdict: null,
            offersRefusalVerdict: false,
            replanOwed: null,
            chosenOption: null,
            createdAt: '2026-09-14T00:00:00.000Z',
            updatedAt: '2026-09-14T00:00:00.000Z',
          },
        },
      }),
      itemId: 'wi-acme-12',
      itemIdentifier: 'ACME-12',
      currentUserId: 'u-viewer',
      canEdit: true,
      repoDelivery: [],
      deliveries: [],
    });
    return render(ui);
  }

  afterEach(() => vi.unstubAllGlobals());

  it('two open pull requests in two repositories: ONE Development card holds the design once, no standalone section', async () => {
    const { container } = await renderStack([CORE_PR, GATEWAY_PR]);
    expect(screen.queryByTestId('standalone-design-result')).toBeNull();

    const slots = screen.getAllByRole('group', { name: messages.designResult.title });
    expect(slots).toHaveLength(1);
    const card = slots[0]!.closest('[data-surface="card"]') as HTMLElement;
    expect(
      within(card).getByRole('heading', { level: 2, name: messages.github.development.title }),
    ).toBeTruthy();
    expect(within(card).getByRole('link', { name: /Open note/ })).toBeTruthy();
    expect(within(card).getByText(CORE_PR.title)).toBeTruthy();
    expect(within(card).getByText(GATEWAY_PR.title)).toBeTruthy();
    expect(card.textContent).toContain(messages.github.development.glossWithDesign);
    expect(container.querySelectorAll('[data-testid="development-design-result"]')).toHaveLength(1);
  });

  it('every pull request merged or closed: the standalone section is back, no slot', async () => {
    await renderStack([
      { ...CORE_PR, state: 'merged' },
      { ...GATEWAY_PR, state: 'closed' },
    ]);
    expect(screen.getByTestId('standalone-design-result')).toBeTruthy();
    expect(screen.queryByTestId('development-design-result')).toBeNull();
    expect(document.body.textContent).toContain(messages.github.development.gloss);
  });
});

// ── MOTIR-5570 ────────────────────────────────────────────────────────────────
// The approval overlay decides outside this page's optimistic status provider, so
// the page mounts a listener beside the Design result section whenever it has a
// `design_result` gate to hear about — and none when it has no gate.
describe('the late stack — the page listens for a decision made in the overlay (MOTIR-5570)', () => {
  function designCard(gate: ApprovalGateDTO | null): LateReads {
    const base = reads();
    return {
      ...base,
      pullRequests: [],
      isDesignCard: true,
      designGate: { ...base.designGate, gate },
    };
  }

  async function renderStack(r: LateReads) {
    const ui = await LateUpperSections({
      reads: Promise.resolve(r),
      itemId: 'wi-acme-12',
      itemIdentifier: 'ACME-12',
      currentUserId: 'u-viewer',
      canEdit: true,
      repoDelivery: [],
      deliveries: [],
    });
    return render(ui);
  }

  it('mounts the listener for the card’s design gate, beside the section', async () => {
    await renderStack(designCard({ id: 'gate-42', state: 'awaiting' } as ApprovalGateDTO));
    const bridge = screen.getByTestId('decided-gate-status-bridge');
    expect(bridge.getAttribute('data-gate-id')).toBe('gate-42');
    expect(screen.getByTestId('standalone-design-result')).toBeTruthy();
  });

  it('mounts no listener on a design card with no gate', async () => {
    await renderStack(designCard(null));
    expect(screen.getByTestId('standalone-design-result')).toBeTruthy();
    expect(screen.queryByTestId('decided-gate-status-bridge')).toBeNull();
  });
});

// ── MOTIR-5792 ────────────────────────────────────────────────────────────────
// WHERE A STORY'S ACCEPTANCE QUESTION IS ASKED, by what the block can carry.
//
// MOTIR-5790 moved the receipt into the Development block whenever the story had an
// open pull request, and suppressed the standalone section there. But the FRAME that
// carries the question is the merge gate's, so a story whose pull requests are open and
// not yet green had neither: the receipt rendered as a subject with no verbs, and the
// awaiting question had no door on the item page at all. Found while recording this
// story's receipt (`tests/e2e/regression-gate.spec.ts`).
describe('a story run — the acceptance question is asked where it can be answered (MOTIR-5792)', () => {
  const EVIDENCE = {
    id: 'ae-1',
    status: 'pending',
    videoUrl: null,
    chapters: [],
    traceUrl: null,
    commitSha: 'c0ffee1',
    ciRunUrl: null,
    producedByKey: 'ACME-24',
    approvedById: null,
    approvedAt: null,
  } as unknown as LateReads['acceptanceEvidence'];
  const gate = (state: ApprovalGateDTO['state']) => ({ id: 'gate-acc', state }) as ApprovalGateDTO;

  function story(over: {
    acceptance: ApprovalGateDTO | null;
    merge: ApprovalGateDTO | null;
  }): LateReads {
    const base = reads();
    return {
      ...base,
      showAcceptance: true,
      acceptanceEligibility: { applicable: false } as LateReads['acceptanceEligibility'],
      acceptanceEvidence: EVIDENCE,
      acceptanceGate: { ...base.acceptanceGate, gate: over.acceptance },
      mergeGate: { ...base.mergeGate, gate: over.merge },
    };
  }

  async function renderStack(r: LateReads) {
    const ui = await LateUpperSections({
      reads: Promise.resolve(r),
      itemId: 'wi-acme-12',
      itemIdentifier: 'ACME-12',
      currentUserId: 'u-viewer',
      canEdit: true,
      repoDelivery: [],
      deliveries: [],
    });
    return render(ui);
  }

  it('the set is green: the receipt LEADS the block, and the section is not drawn twice', async () => {
    await renderStack(
      story({ acceptance: gate('awaiting'), merge: { id: 'gate-merge' } as ApprovalGateDTO }),
    );
    expect(screen.getByTestId('acceptance-development-slot')).toBeTruthy();
    expect(screen.queryByTestId('standalone-acceptance')).toBeNull();
  });

  it('the pull requests are open and NOT green: the question keeps its own section', async () => {
    // No merge gate, so the block has no frame — and an awaiting question with nowhere to
    // press it is the defect this case exists for.
    await renderStack(story({ acceptance: gate('awaiting'), merge: null }));
    expect(screen.getByTestId('standalone-acceptance')).toBeTruthy();
    expect(screen.queryByTestId('acceptance-development-slot')).toBeNull();
  });

  it('accepted before green: the DECIDED receipt stays in the block, beside its commits', async () => {
    // Panel B — nothing is being asked, so there is no question to strand.
    await renderStack(story({ acceptance: gate('approved'), merge: null }));
    expect(screen.getByTestId('acceptance-development-slot')).toBeTruthy();
    expect(screen.queryByTestId('standalone-acceptance')).toBeNull();
  });

  // ONE SENT BACK KEEPS THE FRAME (Story MOTIR-6071 · MOTIR-6506; design choice 4). The
  // refusal withdrew the merge gate `pulled_back`; handing it the frame would say the work
  // was pulled back out of review, which is false.
  const SENT_BACK: ApprovalGateDTO = {
    ...AWAITING_MERGE_GATE,
    id: 'gate-acc',
    kind: 'acceptance_result',
    subjectId: 'ae-1',
    subjectVersion: 'c0ffee1',
    state: 'changes_requested',
    decidedById: 'u-2',
    decidedByLabel: 'Ada L.',
    decidedAt: '2026-09-26T10:00:00.000Z',
    decisionSource: 'ui',
    noteMd: 'Exports need a date filter.',
    refusalVerdict: 're_plan',
  };
  const WITHDRAWN_MERGE: ApprovalGateDTO = {
    ...AWAITING_MERGE_GATE,
    state: 'superseded',
    supersededCause: 'pulled_back',
  };
  const pulledBack = messages.approvalGate.withdrawn.cause.pulled_back;

  async function renderSentBack(acceptance: ApprovalGateDTO) {
    const ui = await LateUpperSections({
      reads: Promise.resolve(story({ acceptance, merge: WITHDRAWN_MERGE })),
      itemId: 'wi-acme-12',
      itemIdentifier: 'ACME-12',
      currentUserId: 'u-viewer',
      canEdit: true,
      repoDelivery: [],
      deliveries: [],
      canReplan: true,
    });
    return render(ui);
  }

  it('sent back over the CURRENT receipt: the acceptance keeps the frame — its record and door, no merge band', async () => {
    await renderSentBack(SENT_BACK);
    expect(
      screen.getAllByText(messages.approvalGate.acceptanceResult.kindLabel).length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId('refusal-verdict').textContent).toBe(
      messages.approvalGate.reason.record.verdict.replan,
    );
    const door = screen.getByTestId('refusal-replan-door');
    expect(door.getAttribute('data-mode')).toBe('replan');
    expect(screen.queryByText(pulledBack)).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: messages.approvalGate.pullRequestApproval.verb.approveAndMerge,
      }),
    ).toBeNull();
    expect(screen.queryByTestId('standalone-acceptance')).toBeNull();
  });

  it('sent back over an OLDER receipt: the frame is the merge gate’s again', async () => {
    await renderSentBack({ ...SENT_BACK, subjectId: 'ae-older' });
    expect(screen.queryByTestId('refusal-verdict')).toBeNull();
    expect(screen.queryByTestId('refusal-replan-door')).toBeNull();
  });
});

// THE PAGE HOST THREADS THE SPENT APPROVAL (Bug MOTIR-5863). `frameGateFor` builds the
// frame's read field by field, so a field the merge read carries and this host forgets is
// dropped silently — the band then loses its first line on the item page while every
// frame-level test stays green.
describe('the item page’s re-asked merge gate names the approval it replaced', () => {
  it('the merge read’s `earlierApproval` reaches the record band', async () => {
    const GATEWAY_SHA = 'aa11bb2000000000000000000000000000000000';
    const CORE_V = `moooon/motir-core#131@3f2a91c0000000000000000000000000000000aa`;
    const GATEWAY_V = `moooon/motir-gateway#57@${GATEWAY_SHA}`;
    const gate: ApprovalGateDTO = {
      ...AWAITING_MERGE_GATE,
      state: 'awaiting',
      subjectVersion: [CORE_V, GATEWAY_V].sort().join(','),
    };
    const member = (subjectVersion: string, pullRequestId: string, exited: boolean) => ({
      subjectVersion,
      pullRequestId,
      queued: false,
      retryable: false,
      exit: exited
        ? {
            rawReason: 'CI_FAILURE',
            disposition: 'failure' as const,
            headSha: GATEWAY_SHA,
            exitedAt: '2026-09-19T15:00:00.000Z',
            requeuedAt: null,
            failingCheckName: 'CI complete',
            failingCheckUrl: 'https://github.com/moooon/motir-gateway/actions/runs/1/job/2',
            failingCheckConclusion: 'failure',
          }
        : null,
      exitAtApprovedHead: exited,
      requeueable: exited,
      refusal: null,
      retryDecidesGateId: gate.id,
    });
    const base = reads();
    const stack = (canDecide: boolean) =>
      LateUpperSections({
        reads: Promise.resolve({
          ...base,
          mergeGate: {
            ...base.mergeGate,
            gate,
            canDecide,
            members: [member(CORE_V, CORE_PR.id, false), member(GATEWAY_V, GATEWAY_PR.id, true)],
            earlierApproval: {
              decidedByLabel: 'Ada L.',
              decidedAt: '2026-09-15T14:22:00.000Z',
              commits: 2,
            },
          },
        }),
        itemId: 'wi-acme-12',
        itemIdentifier: 'ACME-12',
        currentUserId: 'u-viewer',
        canEdit: true,
        repoDelivery: [],
        deliveries: [],
      });
    // ⚠️ A READER WHO MAY ONLY LOOK (MOTIR-6323): the page's frame is theirs — a decider's
    // question is handed over to the overlay (the case below), which draws the same band.
    const { container, unmount } = render(await stack(false));

    const line = container.querySelector('[data-earlier-approval]');
    expect(line?.textContent).toBe(
      `Approved earlier by Ada L. · ${new Date('2026-09-15T14:22:00.000Z').toLocaleString()} · 2 commits — not merged`,
    );
    unmount();

    // The DECIDER's page hands the re-asked question over: the band's door, no frame.
    const decider = render(await stack(true));
    expect(decider.container.querySelector('[data-earlier-approval]')).toBeNull();
    expect(
      decider.getByRole('link', { name: messages.approvalGate.statusHeld.reviewAndApprove }),
    ).toBeTruthy();
  });
});

// A PULL REQUEST MERGED ON GITHUB WHILE ITS GATE AWAITED (Bug MOTIR-5884; `design/github`
// § 29, Panel 2). The merge supersedes the gate `member_closed`, nothing is left open to
// re-raise it, and the card goes Done — so `frameGateFor` hands the block NO frame, and the
// row shows its own *Merged* pill. Before the fix the withdrawn box REPLACED the rows and
// promised a re-ask that could not happen.
describe('a merge made on GitHub with nothing left open renders no frame', () => {
  const CORE_V = `moooon/motir-core#131@3f2a91c0000000000000000000000000000000aa`;
  const GATEWAY_V = `moooon/motir-gateway#57@aa11bb2000000000000000000000000000000000`;
  const withdrawn = (subjectVersion: string): ApprovalGateDTO => ({
    ...AWAITING_MERGE_GATE,
    state: 'superseded',
    supersededCause: 'member_closed',
    subjectVersion,
  });
  const renderStack = async (
    pullRequests: LateReads['pullRequests'],
    gate: ApprovalGateDTO,
    statusCategory: string,
  ) => {
    const base = reads();
    return render(
      await LateUpperSections({
        reads: Promise.resolve({
          ...base,
          pullRequests,
          mergeGate: { ...base.mergeGate, gate, canDecide: true },
        }),
        itemId: 'wi-acme-12',
        itemIdentifier: 'ACME-12',
        currentUserId: 'u-viewer',
        canEdit: true,
        repoDelivery: [],
        deliveries: [],
        statusCategory,
      }),
    );
  };
  const pra = messages.approvalGate.pullRequestApproval;

  it('draws the merged row with its Merged pill, and no Withdrawn pill, band or re-ask', async () => {
    const { container } = await renderStack(
      [{ ...CORE_PR, state: 'merged' }],
      withdrawn(CORE_V),
      'done',
    );
    const row = screen.getByText(CORE_PR.title).closest('li')!;
    expect(within(row).getByText(messages.github.development.prState.merged)).toBeTruthy();
    expect(screen.queryByText(messages.approvalGate.state.withdrawn)).toBeNull();
    expect(container.querySelector('[data-withdrawn-band]')).toBeNull();
    // The two sentences the done card used to carry.
    expect(container.textContent).not.toContain(pra.withdrawn.portCite);
    expect(container.textContent).not.toContain('the set changed');
    // And How to test is still in the block.
    expect(screen.getByRole('group', { name: htt.title })).toBeTruthy();
  });

  it('keeps the frame while a member is still open — the band over BOTH rows (Panel 3a)', async () => {
    const { container } = await renderStack(
      [{ ...CORE_PR, state: 'merged' }, GATEWAY_PR],
      withdrawn([CORE_V, GATEWAY_V].sort().join(',')),
      'in_progress',
    );
    const band = container.querySelector('[data-withdrawn-band]') as HTMLElement;
    expect(band.textContent).toContain(
      pra.withdrawn.portMerged
        .replace('{pr}', 'moooon/motir-core · #131')
        .replace('{host}', 'GitHub'),
    );
    expect(band.textContent).toContain(pra.withdrawn.portCite);
    expect(screen.getByText(CORE_PR.title)).toBeTruthy();
    expect(screen.getByText(GATEWAY_PR.title)).toBeTruthy();
  });
});
