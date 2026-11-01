// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type {
  DevelopmentGateActions,
  DevelopmentGateRead,
} from '@/components/github/DevelopmentGateFrame';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type {
  DecisionDocumentViewDTO,
  DecisionDocumentViewReason,
} from '@/lib/dto/decisionDocument';
import { AWAITING_MERGE_GATE, CORE_PR, recordDto } from '../helpers/howToTestFixtures';

// THE DECISION PORT (Story MOTIR-4907 · Subtask MOTIR-5678; `design/github/design-notes.md`
// §27, `approve-and-merge--decision.mock.html`). The Development block is mounted whole —
// the real slot, the real rows, the real frame — and only the server actions are fakes,
// handed in as the item page hands the real ones.

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const dec = en.approvalGate.decision;
const pra = en.approvalGate.pullRequestApproval;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
/** The copy with its rich tags dropped — what a reader sees. */
const plain = (text: string) =>
  ['<b>', '</b>', '<mono>', '</mono>'].reduce((out, tag) => out.split(tag).join(''), text);

const PATH = 'docs/decisions/page-body.md';
const BLOB = '3f9a2c1000000000000000000000000000000000';
const HEAD = '7a9e0c1000000000000000000000000000000000';
const DECISION_V = `moooon/motir-core:${PATH}@${BLOB}`;

const AWAITING: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  id: 'gate-decision-1',
  kind: 'decision_approval',
  subjectId: 'wi-acme-12',
  subjectVersion: DECISION_V,
};
const APPROVED: ApprovalGateDTO = {
  ...AWAITING,
  state: 'approved',
  decidedById: 'user-2',
  decidedByLabel: 'Ada L.',
  decidedAt: '2026-09-19T15:02:00.000Z',
  outcomeRef: 'approved',
};

const RESOLVED: DecisionDocumentViewDTO = {
  outcome: 'resolved',
  repo: 'moooon/motir-core',
  number: 131,
  path: PATH,
  blobSha: BLOB,
  headSha: HEAD,
  markdown: '# ADR: How a page stores its body\n\n## Decision\n\nStore the body as a Yjs document.',
  workItemRefs: {},
  hostUrl: `https://github.com/moooon/motir-core/blob/${HEAD}/${PATH}`,
};

const unresolvable = (
  reason: DecisionDocumentViewReason,
  over: Partial<Extract<DecisionDocumentViewDTO, { outcome: 'unresolvable' }>> = {},
): DecisionDocumentViewDTO => ({
  outcome: 'unresolvable',
  reason,
  repo: 'moooon/motir-core',
  number: 131,
  headSha: HEAD,
  path: null,
  paths: [],
  hostUrl: null,
  ...over,
});

function fakeActions(overrides: Partial<Record<keyof DevelopmentGateActions, unknown>> = {}) {
  return {
    decide: vi.fn(),
    approveAndMerge: vi.fn(),
    retryMember: vi.fn(),
    ...overrides,
  } as unknown as DevelopmentGateActions & {
    decide: ReturnType<typeof vi.fn>;
    approveAndMerge: ReturnType<typeof vi.fn>;
  };
}

function renderPort({
  gate = AWAITING,
  document = RESOLVED,
  read = {},
  actions = fakeActions(),
}: {
  gate?: ApprovalGateDTO;
  document?: DecisionDocumentViewDTO | null;
  read?: Partial<DevelopmentGateRead>;
  actions?: DevelopmentGateActions;
} = {}) {
  return render(
    <DevelopmentSectionBody
      pullRequests={[CORE_PR]}
      itemIdentifier="ACME-12"
      manualLinkable
      // A run wrote How to test for this card — and the decision port still draws none.
      howToTest={recordDto()}
      mergeGate={{
        gate,
        canDecide: true,
        routedToLabel: 'Mara S.',
        members: [],
        stamp: 'v1.stamp-on-screen',
        ...read,
      }}
      gateActions={actions}
      decision={{ document, gate }}
    />,
  );
}

/** Band 1's text — the kind label and its meta, then the state pill. */
const bandOne = () =>
  screen.getByRole('group', { name: en.approvalGate.port.label }).parentElement!.firstElementChild!
    .textContent ?? '';

const approveButton = () =>
  screen.getByRole('button', { name: pra.verb.approveAndMerge }) as HTMLButtonElement;

describe('awaiting, routed to you (Panel 1)', () => {
  it('draws the document ABOVE the pull-request rows, and names the document in band 1', () => {
    renderPort();
    const slot = screen.getByTestId('decision-document');
    const rows = screen.getByRole('group', { name: en.github.development.pullRequestsGroup });
    // The document leads: the slot precedes the rows in document order.
    expect(slot.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(slot).getByRole('heading', { name: 'ADR: How a page stores its body' }));
    expect(within(slot).getByText(PATH)).toBeTruthy();
    expect(within(slot).getByRole('link', { name: dec.viewOnHost }).getAttribute('href')).toBe(
      RESOLVED.hostUrl,
    );
    // Band 1: the kind reads Decision, and its meta leads with the path.
    expect(bandOne()).toMatch(
      new RegExp(`^${dec.kindLabel}${PATH} · 1 pull request · delivered by`),
    );
    expect(within(rows).getByText(CORE_PR.title)).toBeTruthy();
  });

  it('renders NO How-to-test part, even when a run wrote one (§27, Revised on review)', () => {
    renderPort();
    expect(screen.queryByTestId('how-to-test')).toBeNull();
    expect(screen.queryByRole('group', { name: en.github.development.howToTest.title })).toBeNull();
  });

  it('one press on Approve and merge records the decision and triggers the merge path', async () => {
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({ ok: true, gate: APPROVED, members: [] }),
    });
    renderPort({ actions });
    expect(document.body.textContent).toContain(
      plain(fill(dec.consequence, { prs: 'moooon/motir-core · #131', key: 'ACME-12' })),
    );
    expect(approveButton().disabled).toBe(false);

    fireEvent.click(approveButton());
    fireEvent.click(
      screen.getByRole('button', {
        name: fill(en.approvalGate.confirm.proceed, { verb: pra.verb.approveAndMerge }),
      }),
    );
    await waitFor(() => expect(screen.getByText(en.approvalGate.state.approved)).toBeTruthy());
    // ONE press, addressed to the DECISION gate, with the stamp on screen.
    expect(actions.approveAndMerge).toHaveBeenCalledTimes(1);
    expect(actions.approveAndMerge).toHaveBeenCalledWith({
      gateId: 'gate-decision-1',
      identifier: 'ACME-12',
      stamp: 'v1.stamp-on-screen',
    });
    expect(actions.decide).not.toHaveBeenCalled();
  });
});

describe('UNRESOLVABLE — each reason in its own words, Approve disabled (Panels 3a–3d)', () => {
  const cases: [DecisionDocumentViewDTO | null, string][] = [
    [unresolvable('none'), dec.unresolvable.none],
    [
      unresolvable('several', { paths: ['docs/decisions/a.md', 'docs/decisions/b.md'] }),
      fill(dec.unresolvable.several, {
        count: 2,
        paths: 'docs/decisions/a.md, docs/decisions/b.md',
      }),
    ],
    [unresolvable('gone_at_head', { path: PATH }), dec.unresolvable.gone_at_head],
    [unresolvable('host_unreachable', { path: PATH }), dec.unresolvable.host_unreachable],
    // The CAPTURE's `unreadable` says what the READ's host_unreachable says (§27 mapping).
    [unresolvable('unreadable'), dec.unresolvable.host_unreachable],
    [unresolvable('too_large', { path: PATH }), dec.unresolvable.too_large],
    [unresolvable('not_connected', { path: PATH }), dec.unresolvable.not_connected],
    // Nothing captured yet: nothing can be shown, and nothing can be approved.
    [null, dec.unresolvable.host_unreachable],
  ];

  it.each(cases)('%# renders its reason, disables Approve, keeps Request changes', (doc, copy) => {
    renderPort({ document: doc });
    const callout = within(screen.getByTestId('decision-document')).getByRole('status');
    expect(callout.textContent).toContain(plain(copy));
    expect(approveButton().disabled).toBe(true);
    expect(approveButton().getAttribute('aria-disabled')).toBe('true');
    const requestChanges = screen.getByRole('button', {
      name: en.approvalGate.verb.requestChanges,
    }) as HTMLButtonElement;
    expect(requestChanges.disabled).toBe(false);
    // The reason Approve is off, said in band 3.
    expect(screen.getByText(dec.blocked)).toBeTruthy();
  });

  it('band 1 says what the head carries — no document, or how many', () => {
    renderPort({ document: unresolvable('none') });
    expect(bandOne()).toContain('No decision document · 1 pull request · delivered by');
    cleanup();
    renderPort({
      document: unresolvable('several', { paths: ['docs/decisions/a.md', 'docs/decisions/b.md'] }),
    });
    expect(bandOne()).toContain('2 decision documents · 1 pull request · delivered by');
  });

  it('a document too large to show still links to the host', () => {
    renderPort({
      document: unresolvable('too_large', { path: PATH, hostUrl: RESOLVED.hostUrl }),
    });
    expect(screen.getByRole('link', { name: dec.viewOnHost }).getAttribute('href')).toBe(
      RESOLVED.hostUrl,
    );
  });
});

describe('not yours (Panel 2)', () => {
  it('shows the document and no verbs at all', () => {
    renderPort({ read: { canDecide: false } });
    expect(screen.getByRole('heading', { name: 'ADR: How a page stores its body' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
    expect(screen.queryByRole('button', { name: en.approvalGate.verb.requestChanges })).toBeNull();
    expect(screen.getByText(fill(en.approvalGate.waitingOn, { name: 'Mara S.' }))).toBeTruthy();
  });
});

describe('decided and withdrawn (Panels 4, 5a, 5b, 6a)', () => {
  it('approved with the pull request still open: accepted, the blob named, the merge held — no verb', () => {
    renderPort({ gate: APPROVED, read: { canDecide: false } });
    expect(screen.getByText('Ada L.')).toBeTruthy();
    expect(screen.getByText(dec.mergeHeld)).toBeTruthy();
    // The accepted BLOB is named in the record band (and in the slot's own meta).
    expect(screen.getAllByText('3f9a2c1').length).toBe(2);
    expect(screen.queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
  });

  it('withdrawn by a push that CHANGED the document: the per-kind cause, not the shared line', () => {
    renderPort({
      gate: { ...AWAITING, state: 'superseded', supersededCause: 'head_moved' },
      read: { canDecide: false, stamp: null },
    });
    expect(
      screen.getByText(en.approvalGate.withdrawn.causeByKind.decision_approval.head_moved),
    ).toBeTruthy();
    expect(screen.getByText(dec.withdrawnNext)).toBeTruthy();
    expect(screen.queryByText(en.approvalGate.withdrawn.cause.head_moved)).toBeNull();
    expect(screen.getByText(`${PATH} · blob 3f9a2c1`)).toBeTruthy();
  });

  it('a push that left the document alone: the merge question leads, and the decision stands as a line', () => {
    const MERGE: ApprovalGateDTO = {
      ...AWAITING_MERGE_GATE,
      subjectVersion: `moooon/motir-core#131@${HEAD}`,
    };
    render(
      <DevelopmentSectionBody
        pullRequests={[CORE_PR]}
        itemIdentifier="ACME-12"
        mergeGate={{
          gate: MERGE,
          canDecide: true,
          routedToLabel: null,
          members: [],
          stamp: 's',
        }}
        gateActions={fakeActions()}
        decision={{ document: RESOLVED, gate: APPROVED }}
      />,
    );
    expect(screen.getByText(pra.kindLabel)).toBeTruthy();
    const slot = screen.getByTestId('decision-document');
    expect(slot.textContent).toContain('— unchanged at the new head');
    expect(slot.textContent).toContain('Ada L.');
    expect(approveButton().disabled).toBe(false);
  });
});
