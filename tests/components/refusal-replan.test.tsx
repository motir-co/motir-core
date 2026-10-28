// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { refuseWithReason } from '../helpers/refuseWithReason';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { parseChoiceOptions } from '@/lib/approvalGates/choiceOptions';
import { parseDecisionRecord } from '@/lib/approvalGates/decisionRecord';
import { parsePlanningOverlay } from '@/lib/planning/launcher';
import { AWAITING_MERGE_GATE, CORE_PR } from '../helpers/howToTestFixtures';
import type {
  ApprovalGateDTO,
  ApprovalGateOverlayReadDTO,
  ConfirmedRecordDTO,
  DecisionChoicePortDTO,
} from '@/lib/dto/approvalGate';
import type { DecisionDocumentViewDTO } from '@/lib/dto/decisionDocument';
import type { DevelopmentGateActions } from '@/components/github/DevelopmentGateFrame';

// A REFUSAL ASKS, THEN HANDS OFF (Story MOTIR-6068 · Subtask MOTIR-6211), built to
// `design/work-items/approval-control--replan-door.mock.html` (panel 0 — the ask; panels
// 1–5 — the door) and `design/ai-chat/planning-workspace--refusal-seed.mock.html` sheet 1.
//
// What these hold in place, each of which fails silently:
//   · a refusal of the three kinds ASKS in the decided band and opens NOTHING;
//   · yes is ONE replace that strips the approval address and writes the planning one,
//     carrying the gate id and no reason text;
//   · Not now and Esc decline — Esc without closing the approval overlay — and the door
//     that replaces the ask takes focus;
//   · the ask is transient: a render of the decided record (a reload) draws the door;
//   · nothing else asks — not an approve, a pick, a confirm, a refused press, the
//     commits' Request changes, a design or an acceptance sent back;
//   · the overturned band's plain epic entrance is gone, its owed chips are not.

let params = new URLSearchParams();
let pathname = '/workbench';
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));

const { shallowPush, shallowReplace } = vi.hoisted(() => ({
  shallowPush: vi.fn(),
  shallowReplace: vi.fn(),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace }));

// The PICK ask names where the planner opens from the SEED READ (MOTIR-6436); the
// refusal ask never calls it.
const { fetchPlanningSeed } = vi.hoisted(() => ({ fetchPlanningSeed: vi.fn() }));
vi.mock('@/lib/planning/planningSeedClient', () => ({ fetchPlanningSeed }));

const { fetchApprovalGateOverlay } = vi.hoisted(() => ({ fetchApprovalGateOverlay: vi.fn() }));
vi.mock('@/lib/approvals/approvalOverlayClient', () => ({ fetchApprovalGateOverlay }));

const { decideApprovalGateAction } = vi.hoisted(() => ({ decideApprovalGateAction: vi.fn() }));
vi.mock('@/app/(authed)/items/[key]/approvalGateActions', () => ({
  decideApprovalGateAction,
  approveAndMergeAction: vi.fn(),
  retryApproveAndMergeMemberAction: vi.fn(),
}));

vi.mock('@/lib/approvals/decidedGates', () => ({
  announceGateDecided: vi.fn(),
  useDecidedGate: () => null,
  // The press-in-flight mark (MOTIR-9696) has nothing to tell a list here.
  markGatePressPending: () => {},
  clearGatePressPending: () => {},
  useGatePressPending: () => false,
}));

vi.mock('@/app/(authed)/items/[key]/_components/DesignResultPanel', () => ({
  DesignResultPanel: () => <div data-testid="design-port" />,
}));
vi.mock('@/components/acceptance/AcceptanceReceiptPlayer', () => ({
  AcceptanceReceiptPlayer: () => <div data-testid="receipt" />,
  AcceptanceReceiptProvenance: () => null,
}));

const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');
const { DevelopmentSectionBody } = await import('@/components/github/DevelopmentSection');
const { ChoiceSection } = await import('@/app/(authed)/items/[key]/_components/ChoiceSection');
const { DecisionConfirmSection } =
  await import('@/app/(authed)/items/[key]/_components/DecisionConfirmSection');
const {
  asksToReplanAfterPress,
  asksToPlanAfterPress,
  RefusalReplanAsk,
  RefusalReplanDoor,
  refusalReplanModeOf,
  useRefusalReplanSlots,
} = await import('@/components/approvals/RefusalReplan');
const { useOpenRefusalReplan } = await import('@/components/approvals/useOpenRefusalReplan');

const ask = en.approvalGate.replanAsk;
const door = en.approvalGate.replanDoor;
const NOT_NOW = en.planningWorkspace.handoff.notNow;
const REASON = 'Keep the download page — only the retention rule should change.';

beforeEach(() => {
  pathname = '/workbench';
  params = new URLSearchParams('tab=approvals&approval=ACME-12&approvalKind=decision_approval');
  shallowPush.mockReset();
  shallowReplace.mockReset();
  fetchApprovalGateOverlay.mockReset();
  decideApprovalGateAction.mockReset();
  refresh.mockReset();
  fetchPlanningSeed.mockReset().mockResolvedValue({ anchorKey: 'ACME-40' });
});
afterEach(cleanup);

const DECIDED = {
  decidedById: 'user-1',
  decidedAt: '2026-09-25T16:02:00.000Z',
  decidedByLabel: 'Yue',
  decidedUnderAuthority: 'assignee' as const,
  decisionSource: 'ui' as const,
};

/** The address a yes (or the door) writes, read back through the launcher's own parser. */
function writtenAddress(): { href: string; query: URLSearchParams; path: string } {
  expect(shallowReplace).toHaveBeenCalledTimes(1);
  const href = shallowReplace.mock.calls[0]![0] as string;
  const [path, qs = ''] = href.split('?');
  return { href, query: new URLSearchParams(qs), path: path! };
}

function expectSeededAddress(gateId: string) {
  const { href, query, path } = writtenAddress();
  expect(path).toBe('/workbench');
  // The approval overlay's two names are gone; every other host parameter is kept.
  expect(query.get('approval')).toBeNull();
  expect(query.get('approvalKind')).toBeNull();
  expect(query.get('tab')).toBe('approvals');
  const launch = parsePlanningOverlay(query);
  expect(launch).toMatchObject({ mode: 'replan', from: 'refused-gate', gateId });
  // The gate id and nothing else (§10f): no reason text rides the address.
  expect(decodeURIComponent(href)).not.toContain('retention');
  expect(decodeURIComponent(href)).not.toContain('Postgres');
}

// ── decision_approval — Request changes, pressed in the Development frame ─────────────

const DECISION_V = 'moooon/motir-core:docs/decisions/page-body.md@3f9a2c10000000';
const DOC: DecisionDocumentViewDTO = {
  outcome: 'resolved',
  repo: 'moooon/motir-core',
  number: 131,
  path: 'docs/decisions/page-body.md',
  blobSha: '3f9a2c1000000000000000000000000000000000',
  headSha: '7a9e0c1000000000000000000000000000000000',
  markdown: '# ADR\n\n## Decision\n\nStore the body as a Yjs document.',
  hostUrl: 'https://github.com/moooon/motir-core/blob/7a9e0c1/docs/decisions/page-body.md',
};
const DECISION_AWAITING: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  id: 'gate-decision-1',
  kind: 'decision_approval',
  subjectId: 'wi-acme-12',
  subjectVersion: DECISION_V,
};
const DECISION_SENT_BACK: ApprovalGateDTO = {
  ...DECISION_AWAITING,
  ...DECIDED,
  state: 'changes_requested',
  noteMd: REASON,
};

function actions(result: unknown, approve?: unknown): DevelopmentGateActions {
  return {
    decide: vi.fn(async () => result),
    approveAndMerge: vi.fn(async () => approve),
    retryMember: vi.fn(),
  } as unknown as DevelopmentGateActions;
}

function renderDecision({
  gate = DECISION_AWAITING,
  canReplan = true,
  gateActions = actions({ ok: true, gate: DECISION_SENT_BACK }),
}: {
  gate?: ApprovalGateDTO;
  canReplan?: boolean;
  gateActions?: DevelopmentGateActions;
} = {}) {
  return render(
    <DevelopmentSectionBody
      pullRequests={[CORE_PR]}
      itemIdentifier="ACME-12"
      mergeGate={{
        gate,
        canDecide: gate.state === 'awaiting',
        routedToLabel: 'Yue',
        members: [],
        stamp: 'v1.stamp',
      }}
      gateActions={gateActions}
      gateLayout="fill"
      decision={{ document: DOC, gate }}
      canReplan={canReplan}
    />,
  );
}

const theAsk = () => screen.queryByRole('group', { name: ask.title.replace('{key}', 'ACME-12') });
const yesButton = () => screen.getByRole('button', { name: ask.yes });
const theDoor = () => screen.queryByTestId('refusal-replan-door');

describe('decision_approval — Request changes ASKS, and nothing opens', () => {
  it('shows the ask in the decided band, focused on Re-plan with AI, and writes no address', async () => {
    renderDecision();
    await refuseWithReason({ reason: REASON });
    const group = theAsk();
    expect(group).toBeTruthy();
    expect(group!.dataset.testid).toBe('refusal-replan-ask');
    expect(within(group!).getByText(ask.opens.replace('{key}', 'ACME-12'))).toBeTruthy();
    expect(within(group!).getByText(ask.unsent)).toBeTruthy();
    expect(within(group!).getByRole('button', { name: NOT_NOW })).toBeTruthy();
    // Enter means yes: the primary has focus the moment the band appears.
    expect(document.activeElement).toBe(yesButton());
    // Nothing opened: no address was written, and the door is not drawn beside the ask.
    expect(shallowReplace).not.toHaveBeenCalled();
    expect(shallowPush).not.toHaveBeenCalled();
    expect(theDoor()).toBeNull();
    // The decided record is on screen above it, the reason quoted.
    expect(screen.getByText(en.approvalGate.state.changesRequested)).toBeTruthy();
  });

  it('yes is ONE replace: the approval address stripped, the seeded planner written', async () => {
    renderDecision();
    await refuseWithReason({ reason: REASON });
    fireEvent.click(yesButton());
    expectSeededAddress('gate-decision-1');
    expect(shallowPush).not.toHaveBeenCalled();
    expect(theAsk()).toBeNull();
  });

  it('Not now opens nothing and puts focus on the Re-plan with AI door that replaces the ask', async () => {
    renderDecision();
    await refuseWithReason({ reason: REASON });
    fireEvent.click(screen.getByRole('button', { name: NOT_NOW }));
    expect(theAsk()).toBeNull();
    const d = theDoor()!;
    expect(d.textContent).toBe(door.label);
    expect(d.getAttribute('aria-label')).toBe(door.aria.replace('{item}', 'ACME-12'));
    expect(document.activeElement).toBe(d);
    expect(shallowReplace).not.toHaveBeenCalled();
    // Pressing the door later IS the yes — no second ask.
    fireEvent.click(d);
    expect(theAsk()).toBeNull();
    expectSeededAddress('gate-decision-1');
  });

  it('Esc is Not now — and stops before the document, where the dialog listens', async () => {
    const reachedDocument = vi.fn();
    document.addEventListener('keydown', reachedDocument, { capture: true });
    try {
      renderDecision();
      await refuseWithReason({ reason: REASON });
      fireEvent.keyDown(yesButton(), { key: 'Escape' });
      expect(reachedDocument).not.toHaveBeenCalled();
      expect(theAsk()).toBeNull();
      expect(document.activeElement).toBe(theDoor());
      expect(shallowReplace).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', reachedDocument, { capture: true });
    }
  });

  it('only Esc, and only from inside the ask, declines it', async () => {
    renderDecision();
    await refuseWithReason({ reason: REASON });
    fireEvent.keyDown(yesButton(), { key: 'Enter' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(theAsk()).toBeTruthy();
    expect(shallowReplace).not.toHaveBeenCalled();
  });

  it('a refused press (`ok: false`) asks nothing and draws no door', async () => {
    renderDecision({
      gateActions: actions({ ok: false, refusal: { tag: 'APPROVAL_GATE_NOT_AUTHORISED' } }),
    });
    await refuseWithReason({ reason: REASON });
    expect(theAsk()).toBeNull();
    expect(theDoor()).toBeNull();
    expect(shallowReplace).not.toHaveBeenCalled();
  });

  it('where planning is unavailable, the press asks nothing and the record has no door', async () => {
    renderDecision({ canReplan: false });
    await refuseWithReason({ reason: REASON });
    expect(screen.getByText(en.approvalGate.state.changesRequested)).toBeTruthy();
    expect(theAsk()).toBeNull();
    expect(theDoor()).toBeNull();
  });

  it('approving the decision asks nothing', async () => {
    const approved: ApprovalGateDTO = { ...DECISION_AWAITING, ...DECIDED, state: 'approved' };
    renderDecision({
      gateActions: actions(null, { ok: true, gate: approved, members: [] }),
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
        }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: en.approvalGate.confirm.proceed.replace(
            '{verb}',
            en.approvalGate.pullRequestApproval.verb.approveAndMerge,
          ),
        }),
      );
    });
    expect(screen.getByText(en.approvalGate.state.approved)).toBeTruthy();
    expect(theAsk()).toBeNull();
    expect(theDoor()).toBeNull();
  });

  it('the commits sent back (`pull_request_approval`) ask nothing and draw no door', async () => {
    const sentBack: ApprovalGateDTO = {
      ...AWAITING_MERGE_GATE,
      ...DECIDED,
      state: 'changes_requested',
      noteMd: REASON,
    };
    render(
      <DevelopmentSectionBody
        pullRequests={[CORE_PR]}
        itemIdentifier="ACME-12"
        mergeGate={{
          gate: AWAITING_MERGE_GATE,
          canDecide: true,
          routedToLabel: 'Yue',
          members: [],
          stamp: 'v1.stamp',
          mergeSubjectVersion: 'moooon/motir-core#7@abc',
        }}
        gateActions={actions({ ok: true, gate: sentBack })}
        gateLayout="fill"
        canReplan
      />,
    );
    await refuseWithReason({ reason: REASON });
    expect(screen.getByText(en.approvalGate.state.changesRequested)).toBeTruthy();
    expect(theAsk()).toBeNull();
    expect(theDoor()).toBeNull();
  });
});

describe('the decided record — a reload shows the DOOR, never the ask', () => {
  it('a decision sent back carries Re-plan with AI on its own line; pressing it opens the planner', () => {
    renderDecision({ gate: DECISION_SENT_BACK });
    expect(theAsk()).toBeNull();
    const d = theDoor()!;
    expect(d.dataset.mode).toBe('replan');
    // A real link: a ⌘-click opens the same seeded address in a new tab.
    const href = new URLSearchParams(d.getAttribute('href')!.split('?')[1]);
    expect(href.get('planGate')).toBe('gate-decision-1');
    expect(href.get('approval')).toBeNull();
    // A focus on mount is Not now's alone — an ordinary render steals nothing.
    expect(document.activeElement).not.toBe(d);
    fireEvent.click(d);
    expectSeededAddress('gate-decision-1');
  });

  it('a modified click is the browser’s — no replace', () => {
    renderDecision({ gate: DECISION_SENT_BACK });
    fireEvent.click(theDoor()!, { metaKey: true });
    expect(shallowReplace).not.toHaveBeenCalled();
  });

  it.each([
    ['approved', { ...DECISION_AWAITING, ...DECIDED, state: 'approved' as const }],
    ['awaiting', DECISION_AWAITING],
    [
      'superseded',
      {
        ...DECISION_AWAITING,
        state: 'superseded' as const,
        supersededCause: 'republished' as const,
      },
    ],
  ])('no door on a %s decision', (_state, gate) => {
    renderDecision({ gate });
    expect(theDoor()).toBeNull();
  });

  it('no door for a reader who may not plan', () => {
    renderDecision({ gate: DECISION_SENT_BACK, canReplan: false });
    expect(theDoor()).toBeNull();
  });
});

// ── the item page's decided sections: None of these, and the overturn ──────────────────

function choicePort(): DecisionChoicePortDTO {
  const parse = parseChoiceOptions(
    [
      '## Question',
      'Where do exported reports live?',
      '## Why this is a choice',
      '**Situation:** better than your decision',
      '**You said:** "Store the exports in our own Postgres."',
      'Research found a cheaper store.',
      '## Options',
      '### Managed object storage',
      '**Best if you want:** less to operate',
      'The provider runs it.',
      '### Our own Postgres',
      '**Best if you want:** more cost-effective',
      'No new vendor.',
      '## What this choice gates',
      'The export story.',
    ].join('\n'),
  );
  if (!parse.ok) throw new Error(JSON.stringify(parse.defects));
  const { ok: _ok, ...port } = parse;
  return port;
}
const CHOICE_AWAITING: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  id: 'gate-choice-1',
  workItemId: 'wi-42',
  kind: 'decision_choice',
  subjectId: 'wi-42',
  subjectVersion: 'a'.repeat(64),
};
const CHOICE_NONE: ApprovalGateDTO = {
  ...CHOICE_AWAITING,
  ...DECIDED,
  state: 'changes_requested',
  noteMd: 'None of these keeps the files in the customer’s bucket.',
};

const RECORD: ConfirmedRecordDTO = { kind: 'none' };
function confirmPort() {
  const parse = parseDecisionRecord(
    [
      '## Decision',
      'Exports move to managed object storage.',
      '## What changed',
      '**Change:** workflow · less requirement',
      'The approved plan kept exports in Postgres.',
      '## Supersedes',
      'ACME-6 and ACME-9',
      '## Resulting direction',
      'Every export is written to the bucket.',
    ].join('\n'),
  );
  if (!parse.ok) throw new Error(parse.defect.reason);
  const { ok: _ok, ...sections } = parse;
  return {
    ...sections,
    record: RECORD,
    recordCount: 0,
    presentRecordIds: [],
    supersedesItems: [
      { key: 'ACME-6', title: 'Postgres export table' },
      { key: 'ACME-9', title: null },
    ],
    epic: {
      key: 'ACME-1',
      title: 'Exports',
      hasDescription: true,
      archived: false,
      statusCategory: 'in_progress' as const,
      canPlan: true,
    },
  };
}
const CONFIRM_AWAITING: ApprovalGateDTO = {
  ...CHOICE_AWAITING,
  id: 'gate-confirm-1',
  kind: 'decision_confirmation',
};
const OVERTURNED: ApprovalGateDTO = {
  ...CONFIRM_AWAITING,
  ...DECIDED,
  state: 'overturned',
  outcomeRef: 'cancelled',
  noteMd: 'We agreed to keep Postgres and add a cache.',
  replanOwed: { keys: ['ACME-6', 'ACME-9'] },
};

describe('the item page — the door on None of these and on the overturn', () => {
  it('None of these: the record carries Re-plan with AI', () => {
    pathname = '/items/ACME-42';
    params = new URLSearchParams();
    render(
      <ChoiceSection
        body={{ ok: true, port: choicePort() }}
        gate={CHOICE_NONE}
        canDecide={false}
        routedToLabel="Yue"
        routedToViewer
        itemIdentifier="ACME-42"
        canReplan
      />,
    );
    const d = theDoor()!;
    expect(d.getAttribute('aria-label')).toBe(door.aria.replace('{item}', 'ACME-42'));
    fireEvent.click(d);
    const href = shallowReplace.mock.calls[0]![0] as string;
    expect(href.startsWith('/items/ACME-42?')).toBe(true);
    expect(new URLSearchParams(href.split('?')[1]).get('planGate')).toBe('gate-choice-1');
  });

  it('a chosen option carries the Plan with AI door (MOTIR-6436), never the Re-plan door', () => {
    pathname = '/items/ACME-42';
    params = new URLSearchParams();
    render(
      <ChoiceSection
        body={{ ok: true, port: choicePort() }}
        gate={{
          ...CHOICE_AWAITING,
          ...DECIDED,
          state: 'approved',
          chosenOption: {
            optionId: 'managed-object-storage',
            label: 'Managed object storage',
            bestFor: 'less to operate',
            followUp: 'The export story.',
            situation: 'better_than_your_decision',
          },
        }}
        canDecide={false}
        routedToLabel="Yue"
        routedToViewer
        itemIdentifier="ACME-42"
        canReplan
      />,
    );
    expect(theDoor()).toBeNull();
    const d = screen.getByTestId('pick-plan-door');
    expect(d.getAttribute('aria-label')).toBe(
      en.approvalGate.planDoor.aria.replace('{item}', 'ACME-42'),
    );
    expect(d.textContent).toBe(en.approvalGate.planDoor.label);
    expect(d.getAttribute('data-mode')).toBe('plan');
    expect(screen.queryByText(/planning owed/)).toBeNull();
    fireEvent.click(d);
    const href = shallowReplace.mock.calls[0]![0] as string;
    expect(new URLSearchParams(href.split('?')[1]).get('planGate')).toBe('gate-choice-1');
  });

  it('a chosen option shows no door to a reader who may not plan', () => {
    render(
      <ChoiceSection
        body={{ ok: true, port: choicePort() }}
        gate={{
          ...CHOICE_AWAITING,
          ...DECIDED,
          state: 'approved',
          chosenOption: {
            optionId: 'managed-object-storage',
            label: 'Managed object storage',
            bestFor: 'less to operate',
            followUp: 'The export story.',
            situation: 'better_than_your_decision',
          },
        }}
        canDecide={false}
        routedToLabel="Yue"
        routedToViewer
        itemIdentifier="ACME-42"
      />,
    );
    expect(screen.queryByTestId('pick-plan-door')).toBeNull();
  });

  it('Overturned: the door REPLACES the plain epic entrance; the owed chip and every supersedes chip stay', () => {
    const body = confirmPort();
    render(
      <DecisionConfirmSection
        body={{ ok: true, port: body }}
        gate={OVERTURNED}
        canDecide={false}
        routedToLabel="Yue"
        routedToViewer
        itemIdentifier="ACME-42"
        canReplan
      />,
    );
    expect(screen.getByText(en.approvalGate.decisionConfirm.band.replanOwed)).toBeTruthy();
    expect(screen.getByText(en.approvalGate.decisionConfirm.band.replanOwedDetail)).toBeTruthy();
    // The band's own supersedes chips (the port draws them too, above it).
    const chips = screen.getAllByRole('link', { name: /ACME-6/ });
    expect(chips.length).toBe(2);
    expect(screen.getAllByText('ACME-9').length).toBe(2);
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
    expect(screen.queryByText('Exports (ACME-1)')).toBeNull();
    // The door sits AFTER the supersedes chips, at the foot of the record.
    const d = theDoor()!;
    const chip = chips[chips.length - 1]!;
    expect(chip.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Overturned, for a reader who may not plan: no door, and still no epic entrance', () => {
    render(
      <DecisionConfirmSection
        body={{ ok: true, port: confirmPort() }}
        gate={OVERTURNED}
        canDecide={false}
        routedToLabel="Yue"
        routedToViewer
        itemIdentifier="ACME-42"
      />,
    );
    expect(theDoor()).toBeNull();
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
    expect(screen.getByText(en.approvalGate.decisionConfirm.band.replanOwed)).toBeTruthy();
  });

  it('a confirmed decision carries no door', () => {
    render(
      <DecisionConfirmSection
        body={{ ok: true, port: confirmPort() }}
        gate={{ ...CONFIRM_AWAITING, ...DECIDED, state: 'approved', confirmedRecord: RECORD }}
        canDecide={false}
        routedToLabel="Yue"
        routedToViewer
        itemIdentifier="ACME-42"
        canReplan
      />,
    );
    expect(theDoor()).toBeNull();
  });
});

// ── the approval overlay — Overturn and None of these are pressed THERE ────────────────

function overlayRead(
  gate: ApprovalGateDTO,
  subject: ApprovalGateOverlayReadDTO['subject'],
  canReplan = true,
): ApprovalGateOverlayReadDTO {
  return {
    workItem: {
      id: 'wi-42',
      identifier: 'ACME-42',
      title: 'Where exports live',
      status: 'in_review',
      parentIdentifier: null,
    },
    statuses: [],
    gate,
    canDecide: true,
    canReplan,
    routedToLabel: 'Yue',
    stamp: 'v1.stamp',
    movedSince: [],
    earlierApproval: null,
    subject,
  };
}

async function openOverlay(kind: string, read: ApprovalGateOverlayReadDTO, messages?: unknown) {
  pathname = '/workbench';
  params = new URLSearchParams(`tab=approvals&approval=ACME-42&approvalKind=${kind}`);
  fetchApprovalGateOverlay.mockResolvedValue(read);
  render(<ApprovalOverlay />, messages ? { messages: messages as typeof en, locale: 'zh' } : {});
  await act(async () => {});
  return screen.getByRole('dialog');
}

async function overturn(dialog: HTMLElement) {
  const t = en.approvalGate.decisionConfirm;
  fireEvent.click(within(dialog).getByRole('button', { name: t.verb.overturn }));
  fireEvent.change(within(dialog).getByLabelText(t.note.label), {
    target: { value: 'Keep Postgres and add a cache.' },
  });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: t.overturnStep.proceed }));
  });
}

describe('the approval overlay — Overturn and None of these ask first', () => {
  it('Overturn: the band asks; Esc declines WITHOUT closing the overlay, and the door takes focus', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: OVERTURNED,
      filesKept: null,
      statusWritten: 'cancelled',
    });
    const dialog = await openOverlay(
      'decision_confirmation',
      overlayRead(CONFIRM_AWAITING, {
        state: 'resolved',
        kind: 'decision_confirmation',
        confirm: confirmPort(),
      }),
    );
    await overturn(dialog);
    expect(
      within(dialog).getByRole('group', { name: ask.title.replace('{key}', 'ACME-42') }),
    ).toBeTruthy();
    expect(shallowReplace).not.toHaveBeenCalled();

    fireEvent.keyDown(within(dialog).getByRole('button', { name: ask.yes }), { key: 'Escape' });
    // The overlay is still open on the decided record — no close was written.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(shallowPush).not.toHaveBeenCalled();
    expect(theAsk()).toBeNull();
    const d = within(dialog).getByTestId('refusal-replan-door');
    expect(document.activeElement).toBe(d);
    // The door replaced the epic entrance in the overlay too.
    expect(within(dialog).queryByTestId('work-item-plan-entrance')).toBeNull();
    fireEvent.click(d);
    const href = shallowReplace.mock.calls[0]![0] as string;
    const q = new URLSearchParams(href.split('?')[1]);
    expect(q.get('approval')).toBeNull();
    expect(q.get('planGate')).toBe('gate-confirm-1');
  });

  it('None of these: the band asks, focus on yes; yes strips the approval address in one replace', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: CHOICE_NONE,
      filesKept: null,
      statusWritten: null,
    });
    const dialog = await openOverlay(
      'decision_choice',
      overlayRead(CHOICE_AWAITING, {
        state: 'resolved',
        kind: 'decision_choice',
        choice: choicePort(),
      }),
    );
    await refuseWithReason({ scope: within(dialog), verb: 'choice', reason: 'None fit.' });
    const yes = within(dialog).getByRole('button', { name: ask.yes });
    expect(document.activeElement).toBe(yes);
    fireEvent.click(yes);
    const href = shallowReplace.mock.calls[0]![0] as string;
    const q = new URLSearchParams(href.split('?')[1]);
    expect(q.get('approval')).toBeNull();
    expect(q.get('approvalKind')).toBeNull();
    expect(q.get('tab')).toBe('approvals');
    expect(parsePlanningOverlay(q)).toMatchObject({
      from: 'refused-gate',
      gateId: 'gate-choice-1',
    });
    expect(href).not.toContain('None');
    // The close seam was never used — this is a replace, not a close then a push.
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('the ask in zh', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: CHOICE_NONE,
      filesKept: null,
      statusWritten: null,
    });
    const dialog = await openOverlay(
      'decision_choice',
      overlayRead(CHOICE_AWAITING, {
        state: 'resolved',
        kind: 'decision_choice',
        choice: choicePort(),
      }),
      zh,
    );
    await refuseWithReason({
      scope: within(dialog),
      verb: 'choice',
      reason: '都不合适。',
      messages: zh as unknown as typeof en,
    });
    const z = zh.approvalGate.replanAsk;
    expect(within(dialog).getByText(z.title.replace('{key}', 'ACME-42'))).toBeTruthy();
    expect(within(dialog).getByText(z.opens.replace('{key}', 'ACME-42'))).toBeTruthy();
    expect(within(dialog).getByText(z.unsent)).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: zh.planningWorkspace.handoff.notNow }),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: z.yes })).toBeTruthy();
  });

  async function choosePostgres() {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: {
        ...CHOICE_AWAITING,
        ...DECIDED,
        state: 'approved',
        chosenOption: {
          optionId: 'our-own-postgres',
          label: 'Our own Postgres',
          bestFor: 'more cost-effective',
          followUp: 'The export story.',
          situation: 'better_than_your_decision',
        },
      },
      filesKept: null,
      statusWritten: 'done',
    });
    const dialog = await openOverlay(
      'decision_choice',
      overlayRead(CHOICE_AWAITING, {
        state: 'resolved',
        kind: 'decision_choice',
        choice: choicePort(),
      }),
    );
    fireEvent.click(within(dialog).getByRole('radio', { name: /Our own Postgres/ }));
    const c = en.approvalGate.choice;
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: c.verb.choose.replace('{label}', 'Our own Postgres'),
      }),
    );
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole('button', {
          name: c.confirm.proceed.replace('{label}', 'Our own Postgres'),
        }),
      );
    });
    return dialog;
  }
  const planAsk = en.approvalGate.planAsk;

  it('a PICK asks to plan the follow-up (MOTIR-6436): the planner starts, nothing to send, focus on yes', async () => {
    const dialog = await choosePostgres();
    const group = within(dialog).getByTestId('pick-plan-ask');
    expect(within(group).getByText(planAsk.title)).toBeTruthy();
    // Where it opens comes from the seed read's resolved anchor.
    expect(within(group).getByText(planAsk.opens.replace('{key}', 'ACME-40'))).toBeTruthy();
    expect(within(group).getByText(planAsk.nothingToSend)).toBeTruthy();
    expect(document.activeElement).toBe(within(group).getByRole('button', { name: planAsk.yes }));
    // Never the refusal's words, and nothing says the person must send a message.
    expect(theAsk()).toBeNull();
    expect(group.textContent).not.toMatch(/until you send|edit it first/i);
    expect(shallowReplace).not.toHaveBeenCalled();
  });

  it('a PICK’s yes opens the planner through the planGate address, in one replace', async () => {
    const dialog = await choosePostgres();
    fireEvent.click(within(dialog).getByRole('button', { name: planAsk.yes }));
    const href = shallowReplace.mock.calls[0]![0] as string;
    const q = new URLSearchParams(href.split('?')[1]);
    expect(q.get('approval')).toBeNull();
    expect(q.get('planGate')).toBe('gate-choice-1');
  });

  it('a PICK’s Not now opens nothing and focuses the Plan with AI door; Esc does the same without closing', async () => {
    const dialog = await choosePostgres();
    fireEvent.keyDown(within(dialog).getByRole('button', { name: planAsk.yes }), {
      key: 'Escape',
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(shallowPush).not.toHaveBeenCalled();
    expect(within(dialog).queryByTestId('pick-plan-ask')).toBeNull();
    const d = within(dialog).getByTestId('pick-plan-door');
    expect(document.activeElement).toBe(d);
    expect(shallowReplace).not.toHaveBeenCalled();
  });

  it('a PICK at the project says the planner opens on your project', async () => {
    fetchPlanningSeed.mockResolvedValue({ anchorKey: null });
    const dialog = await choosePostgres();
    expect(within(dialog).getByText(planAsk.opensProject)).toBeTruthy();
  });

  it('a Confirm asks nothing', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: { ...CONFIRM_AWAITING, ...DECIDED, state: 'approved', confirmedRecord: RECORD },
      filesKept: null,
      statusWritten: 'done',
    });
    const dialog = await openOverlay(
      'decision_confirmation',
      overlayRead(CONFIRM_AWAITING, {
        state: 'resolved',
        kind: 'decision_confirmation',
        confirm: confirmPort(),
      }),
    );
    const t = en.approvalGate.decisionConfirm;
    fireEvent.click(within(dialog).getByRole('button', { name: t.verb.confirm }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: t.confirmStep.proceed }));
    });
    expect(screen.getByText(t.state.confirmed)).toBeTruthy();
    expect(theAsk()).toBeNull();
    expect(theDoor()).toBeNull();
  });

  it('a refused Overturn (`ok: false`) asks nothing', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: false,
      refusal: { tag: 'APPROVAL_GATE_NOT_AUTHORISED' },
    });
    const dialog = await openOverlay(
      'decision_confirmation',
      overlayRead(CONFIRM_AWAITING, {
        state: 'resolved',
        kind: 'decision_confirmation',
        confirm: confirmPort(),
      }),
    );
    await overturn(dialog);
    expect(theAsk()).toBeNull();
    expect(theDoor()).toBeNull();
  });

  it('an Overturn where planning is unavailable asks nothing and draws no door', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: OVERTURNED,
      filesKept: null,
      statusWritten: 'cancelled',
    });
    const dialog = await openOverlay(
      'decision_confirmation',
      overlayRead(
        CONFIRM_AWAITING,
        { state: 'resolved', kind: 'decision_confirmation', confirm: confirmPort() },
        false,
      ),
    );
    await overturn(dialog);
    expect(screen.getByText(en.approvalGate.state.overturned)).toBeTruthy();
    expect(theAsk()).toBeNull();
    expect(theDoor()).toBeNull();
  });

  it.each([
    ['design_result', { state: 'resolved', kind: 'design_result', evidence: { id: 'ev-1' } }],
    [
      'acceptance_result',
      { state: 'resolved', kind: 'acceptance_result', evidence: { id: 'rc-1' } },
    ],
  ] as const)('a %s sent back asks nothing and draws no door', async (kind, subject) => {
    const awaiting: ApprovalGateDTO = { ...CHOICE_AWAITING, id: `gate-${kind}`, kind };
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: { ...awaiting, ...DECIDED, state: 'changes_requested', noteMd: REASON },
      filesKept: null,
      statusWritten: null,
    });
    const dialog = await openOverlay(
      kind,
      overlayRead(awaiting, subject as unknown as ApprovalGateOverlayReadDTO['subject']),
    );
    await refuseWithReason({ scope: within(dialog), reason: REASON });
    expect(screen.getByText(en.approvalGate.state.changesRequested)).toBeTruthy();
    expect(theAsk()).toBeNull();
    expect(theDoor()).toBeNull();
    expect(shallowReplace).not.toHaveBeenCalled();
  });
});

// ── the predicate and the hook ─────────────────────────────────────────────────────────

describe('who asks a PICK — `asksToPlanAfterPress` (MOTIR-6436)', () => {
  const STAMP = { optionId: 'a', label: 'A', bestFor: 'x', followUp: 'y', situation: 'z' };
  it.each([
    ['decision_choice', 'approved', 'ui', STAMP, true],
    ['decision_choice', 'approved', 'mcp', STAMP, true],
    ['decision_choice', 'approved', 'github', STAMP, false],
    ['decision_choice', 'approved', 'ui', null, false],
    ['decision_choice', 'changes_requested', 'ui', null, false],
    ['decision_approval', 'approved', 'ui', STAMP, false],
  ] as const)(
    '%s · %s · %s · stamp %# → %s',
    (kind, state, decisionSource, chosenOption, expected) => {
      expect(
        asksToPlanAfterPress({ kind, state, decisionSource, chosenOption, refusalVerdict: null }),
      ).toBe(expected);
    },
  );
});

describe('who asks — `asksToReplanAfterPress`', () => {
  it.each([
    ['decision_approval', 'changes_requested', 'ui', true],
    ['decision_choice', 'changes_requested', 'ui', true],
    ['decision_confirmation', 'overturned', 'mcp', true],
    // A GitHub-sourced decision was never pressed in Motir.
    ['decision_approval', 'changes_requested', 'github', false],
    ['decision_approval', 'approved', 'ui', false],
    ['decision_choice', 'approved', 'ui', false],
    ['decision_confirmation', 'approved', 'ui', false],
    ['pull_request_approval', 'changes_requested', 'ui', false],
    ['design_result', 'changes_requested', 'ui', false],
    // MOTIR-6504 — a finished story's refusal (no verdict) asks for a remedy.
    ['acceptance_result', 'changes_requested', 'ui', true],
    ['acceptance_result', 'changes_requested', 'github', false],
    ['plan_approval', 'declined', 'ui', false],
  ] as const)('%s · %s · %s → %s', (kind, state, decisionSource, expected) => {
    expect(asksToReplanAfterPress({ kind, state, decisionSource, refusalVerdict: null })).toBe(
      expected,
    );
  });

  // MOTIR-6424 — a design sent back asks ONLY with the Re-plan verdict, and never when
  // it was synced out of GitHub.
  it.each([
    ['re_plan', 'ui', true],
    ['re_plan', 'mcp', true],
    ['revise', 'ui', false],
    [null, 'ui', false],
    [null, 'github', false],
    ['re_plan', 'github', false],
  ] as const)(
    'design_result · changes_requested · verdict %s · %s → %s',
    (refusalVerdict, decisionSource, expected) => {
      expect(
        asksToReplanAfterPress({
          kind: 'design_result',
          state: 'changes_requested',
          decisionSource,
          refusalVerdict,
        }),
      ).toBe(expected);
    },
  );

  // MOTIR-6504 — an acceptance asks after a Re-plan or a finished story's refusal, never
  // after a Re-run (that is `motir fix`'s) and never from GitHub.
  it.each([
    ['re_plan', 'ui', true],
    [null, 'ui', true],
    ['revise', 'ui', false],
    ['re_plan', 'github', false],
  ] as const)(
    'acceptance_result · changes_requested · verdict %s · %s → %s',
    (refusalVerdict, decisionSource, expected) => {
      expect(
        asksToReplanAfterPress({
          kind: 'acceptance_result',
          state: 'changes_requested',
          decisionSource,
          refusalVerdict,
        }),
      ).toBe(expected);
    },
  );
});

describe('useOpenRefusalReplan', () => {
  function Probe({ gateId }: { gateId: string }) {
    const { hrefFor, open } = useOpenRefusalReplan();
    return (
      <button type="button" data-href={hrefFor(gateId)} onClick={() => open(gateId)}>
        go
      </button>
    );
  }

  it('on a page with no approval address, keeps every host parameter and adds the seeded launch', () => {
    pathname = '/items/ACME-42';
    params = new URLSearchParams('peek=ACME-7');
    render(<Probe gateId="gate-9" />);
    const button = screen.getByRole('button', { name: 'go' });
    fireEvent.click(button);
    const href = shallowReplace.mock.calls[0]![0] as string;
    expect(href).toBe(button.dataset.href);
    const q = new URLSearchParams(href.split('?')[1]);
    expect(q.get('peek')).toBe('ACME-7');
    expect(q.get('plan')).toBe('replan');
    expect(q.get('planFrom')).toBe('refused-gate');
    expect(q.get('planGate')).toBe('gate-9');
  });

  it('on a bare path, writes only the planning parameters', () => {
    pathname = '/items/ACME-42';
    params = new URLSearchParams();
    render(<Probe gateId="gate-9" />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(shallowReplace.mock.calls[0]![0]).toMatch(/^\/items\/ACME-42\?/);
  });
});

describe('the ask in the frame’s SECTION form (MOTIR-6212)', () => {
  // The item page draws a decided record as a section of its host card; there the ask
  // is a hairline band set off from the record above it, not the overlay's flush band.
  it.each([
    [true, true],
    [false, false],
  ] as const)('sectioned=%s → spaced from the record: %s', (sectioned, spaced) => {
    render(
      <RefusalReplanAsk
        gateId="gate-9"
        itemKey="ACME-12"
        sectioned={sectioned}
        onAnswered={vi.fn()}
        onNotNow={vi.fn()}
      />,
    );
    const band = screen.getByTestId('refusal-replan-ask');
    expect(band.classList.contains('mt-3')).toBe(spaced);
    expect(within(band).getByRole('button', { name: ask.yes })).toBeTruthy();
  });
});

// THE REMEDY COPY SET (Story MOTIR-6071 · MOTIR-6506; design
// `approval-control--acceptance-verdict.mock.html` panels 7–8): the ask and the door speak
// `replan` or `remedy`, keyed off the gate's verdict, and say which as `data-mode`.
describe('the ask and the door in their two copy sets (MOTIR-6506)', () => {
  const remedyAsk = en.approvalGate.acceptanceResult.remedyAsk;
  const remedyDoor = en.approvalGate.acceptanceResult.remedyDoor;

  it.each([
    ['acceptance_result', null, 'remedy'],
    ['acceptance_result', 're_plan', 'replan'],
    ['design_result', 're_plan', 'replan'],
    ['decision_approval', null, 'replan'],
  ] as const)('%s · verdict %s → %s', (kind, refusalVerdict, mode) => {
    expect(
      refusalReplanModeOf({
        kind,
        state: 'changes_requested',
        decisionSource: 'ui',
        refusalVerdict,
      }),
    ).toBe(mode);
  });

  it('the REMEDY ask: *Plan a remedy for {key} with Motir AI?*, the shipped two lines, its own yes', () => {
    const onAnswered = vi.fn();
    render(
      <RefusalReplanAsk
        gateId="gate-70"
        itemKey="ACME-70"
        sectioned={false}
        intent="remedy"
        onAnswered={onAnswered}
        onNotNow={vi.fn()}
      />,
    );
    const band = screen.getByRole('group', {
      name: remedyAsk.title.replace('{key}', 'ACME-70'),
    });
    expect(band.getAttribute('data-mode')).toBe('remedy');
    expect(within(band).getByText(ask.opens.replace('{key}', 'ACME-70'))).toBeTruthy();
    expect(within(band).getByText(ask.unsent)).toBeTruthy();
    const yes = within(band).getByRole('button', { name: remedyAsk.yes });
    expect(document.activeElement).toBe(yes);
    fireEvent.click(yes);
    expect(onAnswered).toHaveBeenCalledTimes(1);
    expect(shallowReplace.mock.calls[0]![0] as string).toContain('gate-70');
  });

  it('the shipped ask is the `replan` set', () => {
    render(
      <RefusalReplanAsk
        gateId="gate-60"
        itemKey="ACME-60"
        sectioned={false}
        onAnswered={vi.fn()}
        onNotNow={vi.fn()}
      />,
    );
    const band = screen.getByTestId('refusal-replan-ask');
    expect(band.getAttribute('data-mode')).toBe('replan');
    expect(within(band).getByText(ask.title.replace('{key}', 'ACME-60'))).toBeTruthy();
  });

  it('the REMEDY door: *Plan a remedy with AI*, named for the story', () => {
    render(<RefusalReplanDoor gateId="gate-70" itemKey="ACME-70" intent="remedy" />);
    const link = screen.getByTestId('refusal-replan-door');
    expect(link.getAttribute('data-mode')).toBe('remedy');
    expect(link.textContent).toBe(remedyDoor.label);
    expect(link.getAttribute('aria-label')).toBe(remedyDoor.aria.replace('{item}', 'ACME-70'));
  });

  it('the slots pick the set from the gate: a finished story’s refusal asks for a remedy, Not now leaves the remedy door', () => {
    function Slots({ asking }: { asking: boolean }) {
      const { door, ask: theAsk } = useRefusalReplanSlots({
        gate: {
          id: 'gate-70',
          kind: 'acceptance_result',
          state: 'changes_requested',
          decisionSource: 'ui',
          refusalVerdict: null,
        },
        itemKey: 'ACME-70',
        replan: { canReplan: true, asking, onAskDone: vi.fn() },
        sectioned: true,
      });
      return (
        <>
          {door}
          {theAsk}
        </>
      );
    }
    const { rerender } = render(<Slots asking />);
    expect(screen.getByTestId('refusal-replan-ask').getAttribute('data-mode')).toBe('remedy');
    fireEvent.click(screen.getByRole('button', { name: NOT_NOW }));
    rerender(<Slots asking={false} />);
    const link = screen.getByTestId('refusal-replan-door');
    expect(link.getAttribute('data-mode')).toBe('remedy');
    expect(document.activeElement).toBe(link);
  });

  it('a Re-run never offers the planner — no ask and no door', () => {
    function Slots() {
      const { door, ask: theAsk } = useRefusalReplanSlots({
        gate: {
          id: 'gate-60',
          kind: 'acceptance_result',
          state: 'changes_requested',
          decisionSource: 'ui',
          refusalVerdict: 'revise',
        },
        itemKey: 'ACME-60',
        replan: { canReplan: true, asking: true },
        sectioned: false,
      });
      return (
        <>
          {door}
          {theAsk}
        </>
      );
    }
    render(<Slots />);
    expect(screen.queryByTestId('refusal-replan-ask')).toBeNull();
    expect(screen.queryByTestId('refusal-replan-door')).toBeNull();
  });

  it('the remedy set in zh', () => {
    render(
      <RefusalReplanAsk
        gateId="gate-70"
        itemKey="ACME-70"
        sectioned={false}
        intent="remedy"
        onAnswered={vi.fn()}
        onNotNow={vi.fn()}
      />,
      { messages: zh as unknown as typeof en, locale: 'zh' },
    );
    expect(
      screen.getByText(
        zh.approvalGate.acceptanceResult.remedyAsk.title.replace('{key}', 'ACME-70'),
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: zh.approvalGate.acceptanceResult.remedyAsk.yes }),
    ).toBeTruthy();
  });
});
