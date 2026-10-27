// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refuseWithReason } from '../helpers/refuseWithReason';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { APPROVAL_GATE_KINDS, withoutApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';
import type {
  ApprovalGateDTO,
  ApprovalGateKindDTO,
  ApprovalGateOverlayReadDTO,
} from '@/lib/dto/approvalGate';

// THE APPROVAL OVERLAY HOST (Story MOTIR-5214 · Subtask MOTIR-5224), built to
// `design/workbench/approval-overlay.mock.html` + `design-notes.md` § 22.
//
// What this file holds in place is not "a dialog renders" — it is the properties
// the overlay is FOR, each of which fails silently:
//
//   · the open state is the ADDRESS and nothing else, so Back closes it;
//   · every close lands on ONE function, which strips exactly two parameters with
//     `shallowPush` and leaves the page underneath alone;
//   · the overlay is TOTAL — every answer the read can give has a drawn arm, and
//     none of them is an empty port or a crash;
//   · the frame is the shared one, and deciding leaves the overlay open on the
//     decided record with the server surfaces refreshed.

let params = new URLSearchParams();
let pathname = '/workbench';
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

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
  // Read only by the item page's hand-over (MOTIR-6323); no announcement reaches it here.
  useDecidedGate: () => null,
}));

// The design port has its OWN suite (`design-result-panel.test.ts`); here it
// stands in for itself so every assertion is about the OVERLAY.
vi.mock('@/app/(authed)/items/[key]/_components/DesignResultPanel', () => ({
  DesignResultPanel: ({ evidence }: { evidence: { id: string } | null }) => (
    <div data-testid="design-port" data-evidence={evidence?.id ?? ''} />
  ),
}));

const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');

const GATE: ApprovalGateDTO = {
  id: 'gate-1',
  workItemId: 'wi-1',
  kind: 'design_result',
  subjectId: 'ev-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: '9840d00ea1b2',
  decidedByLabel: null,
  routedToId: 'user-2',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  confirmedRecord: null,
  refusalVerdict: null,
  offersRefusalVerdict: false,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-08T04:00:00.000Z',
  updatedAt: '2026-09-08T04:00:00.000Z',
};

function readOf(overrides: Partial<ApprovalGateOverlayReadDTO> = {}): ApprovalGateOverlayReadDTO {
  return {
    workItem: {
      id: 'wi-1',
      identifier: 'GATE-1',
      title: 'Draw the row for a published design',
      status: 'in_review',
      parentIdentifier: null,
    },
    statuses: [],
    gate: GATE,
    canDecide: true,
    canReplan: false,
    routedToLabel: 'Riley Reviewer',
    stamp: 'v1.stamp-the-read-handed-over',
    // NOTHING HAS MOVED since this reader opened it (Story MOTIR-5238 · MOTIR-5243).
    // The field is REQUIRED rather than optional so a read that forgot to answer
    // *what changed?* is a compile error and not a silent empty notice.
    movedSince: [],
    earlierApproval: null,
    subject: {
      state: 'resolved',
      kind: 'design_result',
      evidence: { id: 'ev-1' } as never,
      filesKept: false,
    },
    ...overrides,
  };
}

function openAt(key: string, kind: string, host = 'tab=approvals&page=2') {
  pathname = '/workbench';
  params = new URLSearchParams(`${host}&approval=${key}&approvalKind=${kind}`);
}

/** Render, then let the read's microtask land inside an act scope. */
async function renderOverlay(messages?: Record<string, unknown>) {
  const utils = render(<ApprovalOverlay />, messages ? { messages, locale: 'zh' } : {});
  await act(async () => {});
  return utils;
}

beforeEach(() => {
  params = new URLSearchParams();
  pathname = '/workbench';
  fetchApprovalGateOverlay.mockReset();
  decideApprovalGateAction.mockReset();
  announceGateDecided.mockReset();
  shallowPush.mockReset();
  push.mockReset();
  refresh.mockReset();
});

afterEach(cleanup);

describe('the approval overlay is OPENED by its address and nothing else', () => {
  it('renders nothing, and reads nothing, when the address carries no approval', async () => {
    params = new URLSearchParams('tab=approvals');
    await renderOverlay();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchApprovalGateOverlay).not.toHaveBeenCalled();
  });

  it('opens over the page on `?approval=`, naming the kind and the item in its title', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();
    expect(fetchApprovalGateOverlay).toHaveBeenCalledWith(
      'GATE-1',
      'design_result',
      expect.any(AbortSignal),
    );
    const dialog = screen.getByRole('dialog', { name: 'Design result for GATE-1' });
    expect(within(dialog).getByTestId('design-port').dataset.evidence).toBe('ev-1');
  });

  it('closes when the address stops carrying it — the Back vector, with no call made', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    const { rerender } = await renderOverlay();
    expect(screen.getByRole('dialog')).toBeTruthy();
    params = new URLSearchParams('tab=approvals&page=2');
    rerender(<ApprovalOverlay />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('draws the loading bands while the read is in flight', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockReturnValue(new Promise(() => {}));
    await renderOverlay();
    // The dialog's own accessible name is also "Loading the approval" while the
    // read is in flight, so the busy REGION is found by its state, not its label.
    const busy = screen.getByRole('dialog').querySelector('[aria-busy="true"]');
    expect(busy?.getAttribute('aria-label')).toBe(en.approvalOverlay.loading);
    // Close alone in the exit row — no work item yet.
    expect(screen.queryByRole('link', { name: en.approvalOverlay.openWorkItemNewTab })).toBeNull();
  });
});

describe('every close lands on ONE function', () => {
  const closed = '/workbench?tab=approvals&page=2';

  it('the exit row’s Close strips exactly the two parameters, with shallowPush', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush).toHaveBeenCalledWith(closed);
    expect(withoutApprovalOverlay(`${closed}&approval=GATE-1&approvalKind=design_result`)).toBe(
      closed,
    );
  });

  it('Esc arrives at the same close', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush).toHaveBeenCalledWith(closed);
  });

  it('the not-available arm’s own Close is the same close too', async () => {
    openAt('GATE-1', 'merge');
    await renderOverlay();
    const dialog = screen.getByRole('dialog', { name: en.approvalOverlay.notAvailable.title });
    const closes = within(dialog).getAllByRole('button', { name: /^Close/ });
    fireEvent.click(closes[closes.length - 1]!);
    expect(shallowPush).toHaveBeenCalledWith(closed);
  });
});

describe('the overlay is TOTAL over what the read can answer', () => {
  it('an invalid kind opens on "not available" without asking the server', async () => {
    openAt('GATE-1', 'merge');
    await renderOverlay();
    expect(
      screen.getByRole('dialog', { name: en.approvalOverlay.notAvailable.title }),
    ).toBeTruthy();
    expect(screen.getByText(en.approvalOverlay.notAvailable.body)).toBeTruthy();
    expect(fetchApprovalGateOverlay).not.toHaveBeenCalled();
  });

  it('a 404 is "not available", and the exit row does NOT echo the key back', async () => {
    openAt('ZZZ-99', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(null);
    await renderOverlay();
    expect(screen.getByText(en.approvalOverlay.notAvailable.body)).toBeTruthy();
    expect(screen.queryByText('ZZZ-99')).toBeNull();
    expect(screen.queryByRole('link', { name: en.approvalOverlay.openWorkItemNewTab })).toBeNull();
  });

  it('a card with no gate of that kind is "not available" too', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(
      readOf({ gate: null, subject: { state: 'no_gate' } }),
    );
    await renderOverlay();
    expect(
      screen.getByRole('dialog', { name: en.approvalOverlay.notAvailable.title }),
    ).toBeTruthy();
    expect(screen.getByText(en.approvalOverlay.notAvailable.body)).toBeTruthy();
  });

  it('a failed read is "not available" — never a blank dialog or a live frame', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockRejectedValue(new Error('500'));
    await renderOverlay();
    expect(
      screen.getByRole('dialog', { name: en.approvalOverlay.notAvailable.title }),
    ).toBeTruthy();
    expect(screen.getByText(en.approvalOverlay.notAvailable.body)).toBeTruthy();
    expect(screen.queryByTestId('design-port')).toBeNull();
  });

  // Per member of the enum other than the one kind this build registers — the
  // address module's own suite ties that list to `UNREGISTERED_GATE_KINDS`.
  // `plan_approval` is not here: the overlay renders NO frame for it and sends the reader
  // to the planning surface instead (§11.5b, MOTIR-6037) — its own suite,
  // `approval-overlay-plan-arm.test.tsx`.
  for (const kind of APPROVAL_GATE_KINDS.filter(
    (k) => k !== 'design_result' && k !== 'plan_approval',
  )) {
    it(`draws "not built yet" for ${kind}, with no frame mounted`, async () => {
      openAt('GATE-1', kind);
      fetchApprovalGateOverlay.mockResolvedValue(
        readOf({
          gate: { ...GATE, kind: kind as ApprovalGateKindDTO },
          subject: { state: 'kind_not_built' },
        }),
      );
      await renderOverlay();
      expect(screen.getByText(en.workbench.approvals.notRenderable)).toBeTruthy();
      expect(screen.getByText(en.workbench.approvals.notBuiltYet)).toBeTruthy();
      expect(screen.queryByRole('button', { name: en.approvalGate.verb.approve })).toBeNull();
      expect(
        screen.getByRole('dialog', {
          name: `${
            // The approve-to-merge kind is named by its FRAME wherever it is named
            // (MOTIR-5440, § 24); every other kind by the row vocabulary.
            kind === 'pull_request_approval'
              ? en.approvalGate.pullRequestApproval.kindLabel
              : en.workbench.approvals.kind[kind as keyof typeof en.workbench.approvals.kind]
          } for GATE-1`,
        }),
      ).toBeTruthy();
    });
  }

  it('draws "the design is gone" for a subject that no longer resolves', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf({ subject: { state: 'gone' } }));
    await renderOverlay();
    expect(screen.getByText(en.workbench.approvals.subjectGone.design_result)).toBeTruthy();
    // A NEW TAB, not a navigation of this one (MOTIR-6000; design-notes § 28, DECISION 6).
    const [, panelLink] = screen.getAllByRole('link', {
      name: en.approvalOverlay.openWorkItemNewTab,
    });
    expect(panelLink!.getAttribute('href')).toBe('/items/GATE-1');
    expect(panelLink!.getAttribute('target')).toBe('_blank');
    expect(panelLink!.getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.click(panelLink!);
    expect(push).not.toHaveBeenCalled();
  });

  // Bug MOTIR-7146 — the gone copy named "the design" for every kind.
  it('names its OWN kind’s subject when it is gone, never “the design” for every kind', async () => {
    openAt('GATE-1', 'decision_choice');
    fetchApprovalGateOverlay.mockResolvedValue(
      readOf({
        gate: { ...GATE, kind: 'decision_choice', state: 'approved' },
        subject: { state: 'gone' },
      }),
    );
    await renderOverlay();
    expect(screen.getByText(en.workbench.approvals.subjectGone.decision_choice)).toBeTruthy();
    expect(screen.getByText(en.approvalOverlay.subjectGone.decision_choice)).toBeTruthy();
    expect(screen.queryByText(en.workbench.approvals.subjectGone.design_result)).toBeNull();
  });

  // Bug MOTIR-7146 — the read withdraws an awaiting gate over a gone subject, so what
  // opening one shows is the WITHDRAWN frame (state `G`), not the dead end of Panel 4b.
  it('a WITHDRAWN question over a gone subject draws state G — its cause, and no verb', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(
      readOf({
        gate: { ...GATE, state: 'superseded', supersededCause: 'subject_gone' },
        subject: { state: 'gone' },
      }),
    );
    await renderOverlay();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(en.approvalGate.withdrawn.cause.subject_gone)).toBeTruthy();
    expect(within(dialog).getByText(en.approvalGate.withdrawn.portCite)).toBeTruthy();
    expect(within(dialog).queryByText(en.workbench.approvals.subjectGone.design_result)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: en.approvalGate.verb.approve })).toBeNull();
  });
});

describe('the exit row’s TITLE opens the quick view ABOVE the overlay (MOTIR-6000, § 28 DECISION 6)', () => {
  const realFetch = globalThis.fetch;
  const peekFetch = vi.fn();
  beforeEach(() => {
    // The quick view reads its own item; a 404 lands on its shipped not-found panel,
    // which is also the answer a reader who cannot see the work item gets.
    peekFetch.mockReset().mockResolvedValue({ ok: false, status: 404 });
    globalThis.fetch = peekFetch as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const titleDoor = () =>
    screen.getByRole('link', { name: /^GATE-1\s*Draw the row for a published design$/ });
  const quickView = () => screen.queryByRole('dialog', { name: 'Quick view: GATE-1' });

  it('a plain click opens the quick view STACKED over the approval — no `?peek=`, no address change', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();

    const door = titleDoor();
    expect(door.getAttribute('href')).toBe('/items/GATE-1');
    expect(door.getAttribute('aria-haspopup')).toBe('dialog');
    await act(async () => {
      fireEvent.click(door, { button: 0 });
    });

    expect(quickView()).toBeTruthy();
    expect(peekFetch).toHaveBeenCalledWith(
      '/api/work-items/peek?key=GATE-1',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(screen.getByText(en.issueViews.quickViewUnavailableTitle)).toBeTruthy();
    // The approval is still open UNDER it — hidden from the accessibility tree while the
    // modal peek is on top, exactly as a nested Radix dialog should — and nothing was
    // written to the address.
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    expect(document.body.textContent).toContain('Design result for GATE-1');
    expect(shallowPush).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('Esc closes the quick view ONLY — the approval stays open on the same gate', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();
    await act(async () => {
      fireEvent.click(titleDoor(), { button: 0 });
    });

    fireEvent.keyDown(quickView()!, { key: 'Escape' });

    expect(quickView()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Design result for GATE-1' })).toBeTruthy();
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('a MODIFIED click keeps its native meaning — the card in a new tab, nothing intercepted', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();

    const proceeded = fireEvent.click(titleDoor(), { button: 0, metaKey: true });

    expect(proceeded).toBe(true);
    expect(quickView()).toBeNull();
  });

  it('a DIFFERENT approval never inherits the peek — it belongs to its address', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    const view = await renderOverlay();
    await act(async () => {
      fireEvent.click(titleDoor(), { button: 0 });
    });
    expect(quickView()).toBeTruthy();

    // Back / forward lands on another gate's address: the peek does not follow.
    openAt('GATE-2', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(
      readOf({
        workItem: {
          id: 'wi-2',
          identifier: 'GATE-2',
          title: 'Another design',
          status: 'in_review',
          parentIdentifier: null,
        },
      }),
    );
    view.rerender(<ApprovalOverlay />);
    await act(async () => {});

    expect(quickView()).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Quick view: GATE-2' })).toBeNull();
  });
});

describe('the frame, composed at full size', () => {
  it('carries the work item in the exit row — once — and a NEW-TAB link out to it', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();
    const link = screen.getByRole('link', { name: en.approvalOverlay.openWorkItemNewTab });
    expect(link.getAttribute('href')).toBe('/items/GATE-1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText('Draw the row for a published design')).toBeTruthy();
    // "Design result" is band 1's, and appears exactly once on screen.
    expect(screen.getAllByText(en.approvalGate.designResult.kindLabel)).toHaveLength(1);
  });

  it('gives a reader who may see but not decide the port and no verbs', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf({ canDecide: false }));
    await renderOverlay();
    expect(screen.getByTestId('design-port')).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.approvalGate.verb.approve })).toBeNull();
  });

  it('decides in place: the decided record, the overlay still open, the server surfaces refreshed', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: {
        ...GATE,
        state: 'approved',
        decidedByLabel: 'Riley Reviewer',
        decidedAt: GATE.updatedAt,
      },
      filesKept: true,
    });
    await renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.approve }));
    const proceed = en.approvalGate.confirm.proceed.replace('{verb}', en.approvalGate.verb.approve);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: proceed }));
    });
    expect(decideApprovalGateAction).toHaveBeenCalledWith({
      gateId: 'gate-1',
      decision: 'approve',
      identifier: 'GATE-1',
      // The stamp the READ handed over — never one fetched at press time (MOTIR-5235).
      stamp: 'v1.stamp-the-read-handed-over',
    });
    expect(screen.getByText(en.approvalGate.state.approved)).toBeTruthy();
    expect(screen.getByText(en.approvalGate.record.filesKept)).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
    // …and the row underneath is TOLD, because a refresh cannot reach its island.
    // The WHOLE decision: the item page underneath reads its `outcomeRef` and
    // `filesKept` (MOTIR-5570).
    expect(announceGateDecided).toHaveBeenCalledWith({
      gate: expect.objectContaining({ id: 'gate-1', state: 'approved' }),
      filesKept: true,
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('Request changes on a design ASKS WHY: empty is refused in place, filled sends the reason (MOTIR-6075)', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.approvalGate.reason.proceed }));
    });
    expect(screen.getByText(en.approvalGate.reason.required)).toBeTruthy();
    expect(decideApprovalGateAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(en.approvalGate.reason.label), {
      target: { value: 'The empty state needs the illustration.' },
    });
    // …and a DESIGN also names its verdict (MOTIR-6427): the reason alone is still refused.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.approvalGate.reason.proceed }));
    });
    expect(screen.getByText(en.approvalGate.reason.verdict.required)).toBeTruthy();
    expect(decideApprovalGateAction).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('radio', {
        name: new RegExp(`^${en.approvalGate.reason.verdict.revise.label}`),
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.approvalGate.reason.proceed }));
    });
    expect(decideApprovalGateAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        decision: 'request_changes',
        noteMd: 'The empty state needs the illustration.',
        refusalVerdict: 'revise',
      }),
    );
  });

  it('draws a refusal IN PLACE and neither closes nor refreshes on it', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    decideApprovalGateAction.mockResolvedValue({
      ok: false,
      refusal: { tag: 'APPROVAL_GATE_ALREADY_DECIDED', decidedByLabel: 'Sam Someone' },
    });
    await renderOverlay();
    await refuseWithReason();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    expect(announceGateDecided).not.toHaveBeenCalled();
    expect(shallowPush).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('speaks zh — the exit row’s link and the dialog’s name', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay(zh as unknown as Record<string, unknown>);
    expect(screen.getByRole('link', { name: zh.approvalOverlay.openWorkItemNewTab })).toBeTruthy();
    expect(
      screen.getByRole('dialog', { name: `GATE-1 的${zh.workbench.approvals.kind.design_result}` }),
    ).toBeTruthy();
  });
});

describe('a STALE press (Story MOTIR-5232 · Subtask MOTIR-5235)', () => {
  const stale = en.approvalGate.refusal.stale;
  const staleRefusal = (moved: ('subject' | 'pull_requests' | 'criteria')[]) => ({
    ok: false as const,
    refusal: { tag: 'APPROVAL_GATE_STALE_SUBJECT' as const, moved },
  });
  const requestChanges = () => refuseWithReason();

  it('draws the refusal IN PLACE naming what moved, with its ONE control — and writes, refreshes and closes nothing', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    decideApprovalGateAction.mockResolvedValue(staleRefusal(['criteria']));
    await renderOverlay();
    await requestChanges();

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(stale.criteria)).toBeTruthy();
    expect(within(alert).getByText(stale.next)).toBeTruthy();
    expect(within(alert).getByRole('button', { name: stale.control })).toBeTruthy();
    // Pressing again would be refused again: the refusal's own control is the only way on.
    expect(
      (
        screen.getByRole('button', {
          name: en.approvalGate.verb.requestChanges,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(announceGateDecided).not.toHaveBeenCalled();
    expect(shallowPush).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('“Show the current version” re-reads IN PLACE, and the second press — with the FRESH stamp — lands', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay
      .mockResolvedValueOnce(readOf())
      .mockResolvedValueOnce(
        readOf({ stamp: 'v1.the-current-version', gate: { ...GATE, subjectVersion: 'c0ffee12' } }),
      );
    decideApprovalGateAction
      .mockResolvedValueOnce(staleRefusal(['subject']))
      .mockResolvedValueOnce({
        ok: true,
        gate: { ...GATE, state: 'changes_requested', decidedAt: GATE.updatedAt },
        filesKept: null,
      });
    await renderOverlay();
    await requestChanges();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: stale.control }));
    });

    // The SAME read the overlay opened with, run again — never a navigation.
    expect(fetchApprovalGateOverlay).toHaveBeenCalledTimes(2);
    expect(fetchApprovalGateOverlay.mock.calls[1]!.slice(0, 2)).toEqual([
      'GATE-1',
      'design_result',
    ]);
    expect(shallowPush).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    // The refusal is gone and the verbs are back — a fresh read is a fresh frame.
    expect(screen.queryByRole('alert')).toBeNull();
    // …and the reader starts again from the top of what changed: the port has focus.
    expect(document.activeElement?.getAttribute('role')).toBe('group');
    await requestChanges();
    expect(decideApprovalGateAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ stamp: 'v1.the-current-version' }),
    );
    expect(screen.getByText(en.approvalGate.state.changesRequested)).toBeTruthy();
  });

  it('keeps the THREE live-gate refusals apart: three sentences, and only the stale one has a control', async () => {
    const sentences: string[] = [];
    for (const refusal of [
      { tag: 'APPROVAL_GATE_ALREADY_DECIDED', decidedByLabel: 'Sam Someone' },
      { tag: 'APPROVAL_GATE_SUPERSEDED', supersedeCause: 'republished' },
      { tag: 'APPROVAL_GATE_STALE_SUBJECT', moved: ['subject', 'criteria'] },
    ]) {
      cleanup();
      openAt('GATE-1', 'design_result');
      fetchApprovalGateOverlay.mockResolvedValue(readOf());
      decideApprovalGateAction.mockResolvedValue({ ok: false, refusal });
      await renderOverlay();
      await requestChanges();
      const alert = screen.getByRole('alert');
      sentences.push(alert.textContent ?? '');
      expect(Boolean(within(alert).queryByRole('button', { name: stale.control }))).toBe(
        refusal.tag === 'APPROVAL_GATE_STALE_SUBJECT',
      );
    }
    expect(new Set(sentences).size).toBe(3);
    expect(sentences[2]).toContain(
      stale.several.replace('{things}', `${stale.noun.subject} and ${stale.noun.criteria}`),
    );
  });

  it('speaks zh — the sentence, the next action and the control', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    decideApprovalGateAction.mockResolvedValue(staleRefusal(['pull_requests']));
    await renderOverlay(zh as unknown as Record<string, unknown>);
    await refuseWithReason({ messages: zh as unknown as typeof en });
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(zh.approvalGate.refusal.stale.pullRequests)).toBeTruthy();
    expect(within(alert).getByText(zh.approvalGate.refusal.stale.next)).toBeTruthy();
    expect(
      within(alert).getByRole('button', { name: zh.approvalGate.refusal.stale.control }),
    ).toBeTruthy();
  });
});

describe('the overlay across a CHANGING address (MOTIR-5226)', () => {
  it('a read superseded by a new address never lands on it', async () => {
    let resolveFirst!: (read: ApprovalGateOverlayReadDTO) => void;
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );
    fetchApprovalGateOverlay.mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = await renderOverlay();

    openAt('GATE-2', 'design_result');
    rerender(<ApprovalOverlay />);
    await act(async () => resolveFirst(readOf()));

    // GATE-1's answer was for an address nobody is on any more.
    expect(screen.queryByRole('dialog', { name: 'Design result for GATE-1' })).toBeNull();
    expect(screen.getByRole('dialog').querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it('a FAILED read superseded by a new address does not draw "not available" over it', async () => {
    let rejectFirst!: (err: Error) => void;
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectFirst = reject)),
    );
    fetchApprovalGateOverlay.mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = await renderOverlay();

    openAt('GATE-2', 'design_result');
    rerender(<ApprovalOverlay />);
    await act(async () => rejectFirst(new Error('Approval gate read failed (500)')));

    expect(screen.queryByText(en.approvalOverlay.notAvailable.body)).toBeNull();
    expect(screen.getByRole('dialog').querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it('returns focus to whatever opened it — a URL write is not Radix’s Trigger', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'the row';
    document.body.appendChild(opener);
    opener.focus();
    params = new URLSearchParams('tab=approvals');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    const { rerender } = await renderOverlay();

    openAt('GATE-1', 'design_result');
    rerender(<ApprovalOverlay />);
    await act(async () => {});
    expect(screen.getByRole('dialog', { name: 'Design result for GATE-1' })).toBeTruthy();

    params = new URLSearchParams('tab=approvals&page=2');
    rerender(<ApprovalOverlay />);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('names the published design plainly when the gate carries no version', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf({ gate: { ...GATE, subjectVersion: null } }));
    await renderOverlay();

    const dialog = screen.getByRole('dialog', { name: 'Design result for GATE-1' });
    expect(within(dialog).getByText(en.approvalGate.designResult.meta.plain)).toBeTruthy();
  });
});

// THE APPROVE-TO-MERGE PORT (Story MOTIR-5437 · Subtask MOTIR-5440), built to
// `design/workbench/design-notes.md` § 24 and its delta mock.
//
// Band 2 is the item page's Development block, COMPOSED: the same component, fed the
// same fields, in the `fill` box instead of the `flush` one. So what this file holds is
// the OVERLAY's half — that the block is what mounts, that the frame's verbs come with
// it, and that a reader who may not decide gets the port and nothing to press. The
// block's own contents have their own suites (`development-block`, `how-to-test-block`).
describe('the APPROVE-TO-MERGE gate — the Development block as the port (§ 24)', () => {
  const PR_GATE: ApprovalGateDTO = {
    ...GATE,
    kind: 'pull_request_approval',
    // The set version names every member; `membersOf` parses band 1's count from it.
    subjectVersion: `${CORE_PR.repo}#${CORE_PR.number}@abc1234,${GATEWAY_PR.repo}#${GATEWAY_PR.number}@def5678`,
    subjectId: 'wi-1',
  };

  function pullRequestRead(
    over: {
      canDecide?: boolean;
      howToTest?: ReturnType<typeof recordDto>;
      designEvidence?: { id: string } | null;
      isDesignCard?: boolean;
      acceptanceEvidence?: unknown;
      acceptanceGate?: unknown;
    } = {},
  ): ApprovalGateOverlayReadDTO {
    return readOf({
      gate: PR_GATE,
      workItem: {
        id: 'wi-1',
        identifier: 'ACME-12',
        title: 'Throttle the public API',
        status: 'in_review',
        parentIdentifier: null,
      },
      statuses: [],
      canDecide: over.canDecide ?? true,
      subject: {
        state: 'resolved',
        kind: 'pull_request_approval',
        pullRequests: [CORE_PR, GATEWAY_PR],
        repoDelivery: [],
        deliveries: [],
        howToTest: over.howToTest ?? recordDto(),
        designEvidence: (over.designEvidence ?? null) as never,
        // A pull-request subject on a card with no receipt, unless the caller gives one:
        // a STORY RUN ports its recording here, leading the block (MOTIR-5790).
        acceptanceEvidence: (over.acceptanceEvidence ?? null) as never,
        acceptanceGate: (over.acceptanceGate ?? null) as never,
        isDesignCard: over.isDesignCard ?? false,
        members: [],
      },
    });
  }

  const openPullRequestGate = async (over?: Parameters<typeof pullRequestRead>[0]) => {
    openAt('ACME-12', 'pull_request_approval');
    fetchApprovalGateOverlay.mockResolvedValue(pullRequestRead(over));
    await renderOverlay();
    return screen.getByRole('dialog', { name: /Pull requests for ACME-12/ });
  };

  it('mounts ONE frame whose band 2 holds BOTH pull requests and How to test, with the gate’s verbs', async () => {
    const dialog = await openPullRequestGate();

    const ports = within(dialog).getAllByRole('group', { name: en.approvalGate.port.label });
    expect(ports).toHaveLength(1);
    const port = ports[0]!;
    expect(within(port).getByText(CORE_PR.title)).toBeTruthy();
    expect(within(port).getByText(GATEWAY_PR.title)).toBeTruthy();
    expect(
      within(port).getByRole('group', { name: en.github.development.howToTest.title }),
    ).toBeTruthy();
    // The kind's own verbs, from the shared frame — and no second approve control.
    expect(
      within(dialog).getByRole('button', {
        name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
      }),
    ).toBeTruthy();
    expect(
      within(dialog).getAllByRole('button', { name: en.approvalGate.verb.requestChanges }),
    ).toHaveLength(1);
    // The design port belongs to the other kind; nothing of it is mounted here.
    expect(screen.queryByTestId('design-port')).toBeNull();
  });

  it('is the FILL form — the port takes the viewport, not the item page’s 34rem ceiling', async () => {
    const dialog = await openPullRequestGate();
    const port = within(dialog).getByRole('group', { name: en.approvalGate.port.label });

    expect(port.className).not.toContain('max-h-[34rem]');
    expect(port.className).toContain('flex-1');
  });

  it('a code block’s copy control copies THAT block’s text, exactly', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const dialog = await openPullRequestGate();

    // The run's two fenced commands — each copies its own text, inside the overlay
    // exactly as on the item page (`how-to-test-block.test.tsx` asserts the same two).
    // They are the ONLY copy controls: the per-repository fetch block is retired
    // (MOTIR-5691, design/github § 25).
    const controls = within(dialog).getAllByRole('button', {
      name: en.github.development.howToTest.code.copyAria,
    });
    expect(controls).toHaveLength(2);
    await act(async () => {
      fireEvent.click(controls[0]!);
    });
    expect(writeText).toHaveBeenLastCalledWith('pnpm install --frozen-lockfile && pnpm db:seed');

    await act(async () => {
      fireEvent.click(controls[1]!);
    });
    expect(writeText).toHaveBeenLastCalledWith('pnpm dev');
  });

  it('a STALE Request changes re-reads through the SAME overlay read, and the fresh stamp lands (MOTIR-5235)', async () => {
    decideApprovalGateAction
      .mockResolvedValueOnce({
        ok: false,
        refusal: { tag: 'APPROVAL_GATE_STALE_SUBJECT', moved: ['pull_requests'] },
      })
      .mockResolvedValueOnce({
        ok: true,
        gate: { ...PR_GATE, state: 'changes_requested', decidedAt: PR_GATE.updatedAt },
        filesKept: null,
      });
    const dialog = await openPullRequestGate();
    fetchApprovalGateOverlay.mockResolvedValue({
      ...pullRequestRead(),
      stamp: 'v1.the-current-pull-requests',
    });

    await refuseWithReason({ scope: within(dialog) });
    const alert = within(dialog).getByRole('alert');
    expect(within(alert).getByText(en.approvalGate.refusal.stale.pullRequests)).toBeTruthy();

    await act(async () => {
      fireEvent.click(
        within(alert).getByRole('button', { name: en.approvalGate.refusal.stale.control }),
      );
    });
    expect(fetchApprovalGateOverlay).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();

    await refuseWithReason({ scope: within(screen.getByRole('dialog')) });
    expect(decideApprovalGateAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ stamp: 'v1.the-current-pull-requests' }),
    );
  });

  it('a reader who may SEE but not DECIDE gets the port and no verbs', async () => {
    const dialog = await openPullRequestGate({ canDecide: false });

    expect(within(dialog).getByRole('group', { name: en.approvalGate.port.label })).toBeTruthy();
    expect(within(dialog).getByText(CORE_PR.title)).toBeTruthy();
    for (const verb of [
      en.approvalGate.pullRequestApproval.verb.approveAndMerge,
      en.approvalGate.verb.requestChanges,
    ]) {
      expect(within(dialog).queryByRole('button', { name: verb })).toBeNull();
    }
  });

  it('a record-missing item shows the block’s own missing state INSIDE the port, verbs intact', async () => {
    const dialog = await openPullRequestGate({
      howToTest: recordDto({ state: 'record_missing', record: null }),
    });

    const port = within(dialog).getByRole('group', { name: en.approvalGate.port.label });
    expect(within(port).getByText(en.github.development.howToTest.missing.title)).toBeTruthy();
    // The gate is real, and a reviewer may approve without instructions (§ 24).
    expect(
      within(dialog).getByRole('button', {
        name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
      }),
    ).toBeTruthy();
  });

  it('a STORY RUN carries its RECORDING inside the same port, leading it (MOTIR-5790)', async () => {
    // The queue lists such a story by its ACCEPTANCE gate, and its row opens this overlay
    // — so this port is where that reader meets the pull requests the one press merges.
    const dialog = await openPullRequestGate({
      acceptanceEvidence: {
        id: 'ae-1',
        workItemId: 'wi-1',
        status: 'pending',
        videoUrl: 'https://blob.example/run.webm',
        mimeType: 'video/webm',
        sizeBytes: 1024,
        traceUrl: null,
        chapters: [{ label: 'Run the whole story', tSeconds: 4 }],
        commitSha: 'c0ffee1',
        ciRunUrl: null,
        producedByKey: 'ACME-24',
        approvedById: null,
        approvedAt: null,
        createdAt: '2026-09-19T14:40:00.000Z',
      },
      acceptanceGate: { ...GATE, id: 'gate-acc', kind: 'acceptance_result', state: 'awaiting' },
    });

    const port = within(dialog).getByRole('group', { name: en.approvalGate.port.label });
    const slot = within(port).getByTestId('acceptance-development-slot');
    // …and it LEADS: the recording, then How to test, then the rows (the design's order).
    const howToTest = within(port).getByRole('group', {
      name: en.github.development.howToTest.title,
    });
    expect(slot.compareDocumentPosition(howToTest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(slot).getByRole('button', { name: /Run the whole story/ })).toBeTruthy();
  });

  it('an ACCEPTED recording beside the merge question says the video STANDS, not that it is being asked again', async () => {
    const dialog = await openPullRequestGate({
      acceptanceEvidence: {
        id: 'ae-1',
        workItemId: 'wi-1',
        status: 'approved',
        videoUrl: null,
        mimeType: 'video/webm',
        sizeBytes: 1024,
        traceUrl: null,
        chapters: [],
        commitSha: 'c0ffee1',
        ciRunUrl: null,
        producedByKey: 'ACME-24',
        approvedById: 'user-2',
        approvedAt: '2026-09-19T15:02:00.000Z',
        createdAt: '2026-09-19T14:40:00.000Z',
      },
      acceptanceGate: {
        ...GATE,
        id: 'gate-acc',
        kind: 'acceptance_result',
        state: 'approved',
        decidedByLabel: 'Ada L.',
        decidedAt: '2026-09-19T15:02:00.000Z',
      },
    });

    const slot = within(dialog).getByTestId('acceptance-development-slot');
    expect(within(slot).getByText(/the video stands/)).toBeTruthy();
  });

  it('a DESIGN card carries its design result inside the same port (state 7)', async () => {
    const dialog = await openPullRequestGate({
      designEvidence: { id: 'ev-9' },
      isDesignCard: true,
    });

    const port = within(dialog).getByRole('group', { name: en.approvalGate.port.label });
    const design = within(port).getByTestId('design-port');
    expect(design.getAttribute('data-evidence')).toBe('ev-9');
    // …and it leads the block: the design, then How to test, then the rows (§ 24).
    const howToTest = within(port).getByRole('group', {
      name: en.github.development.howToTest.title,
    });
    expect(
      design.compareDocumentPosition(howToTest) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

// ── THE ACCEPTANCE PORT (Story MOTIR-4949 · Subtask MOTIR-5792) ──────────────────────
//
// The overlay renders a story's RECORDING in the same frame every other kind uses, with
// the shared verbs — and it is the one place an acceptance decision is submitted, since
// MOTIR-5790 took the verbs off the story page. This is that arm, which the route's own
// tests reach from the other side (`tests/api/approval-gate-route.test.ts`).
describe('the ACCEPTANCE port — a story\u2019s recording, in the shared frame', () => {
  const ACCEPTANCE_GATE: ApprovalGateDTO = {
    ...GATE,
    id: 'gate-acc',
    kind: 'acceptance_result',
    subjectId: 'ae-1',
    subjectVersion: 'c0ffee1234567890',
  };

  const RECEIPT = {
    id: 'ae-1',
    workItemId: 'wi-1',
    status: 'pending',
    videoUrl: 'https://blob.example/run.webm',
    mimeType: 'video/webm',
    sizeBytes: 1024,
    traceUrl: null,
    chapters: [{ label: 'Open the story', tSeconds: 0 }],
    commitSha: 'c0ffee1234567890',
    ciRunUrl: null,
    producedByKey: 'GATE-24',
    approvedById: null,
    approvedAt: null,
    createdAt: '2026-09-19T14:40:00.000Z',
  };

  async function openAcceptanceGate() {
    openAt('GATE-1', 'acceptance_result');
    fetchApprovalGateOverlay.mockResolvedValue(
      readOf({
        gate: ACCEPTANCE_GATE,
        subject: {
          state: 'resolved',
          kind: 'acceptance_result',
          evidence: RECEIPT,
        } as never,
      }),
    );
    await renderOverlay();
    return screen.getByRole('dialog');
  }

  it('renders the recording as the port, named by the ACCEPTANCE kind and its version', async () => {
    const dialog = await openAcceptanceGate();

    expect(within(dialog).getByText(en.approvalGate.acceptanceResult.kindLabel)).toBeTruthy();
    expect(
      within(dialog).getByText(
        en.approvalGate.acceptanceResult.meta.withVersion.replace('{version}', 'c0ffee12'),
      ),
    ).toBeTruthy();
    // The recording itself — the same player the story page shows.
    expect(within(dialog).getByRole('button', { name: /Open the story/ })).toBeTruthy();
  });

  it('carries the SHARED verbs, and a press submits the decision through the one door', async () => {
    const dialog = await openAcceptanceGate();
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: { ...ACCEPTANCE_GATE, state: 'approved', decidedByLabel: 'Ada L.' },
      filesKept: null,
    });

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: en.approvalGate.verb.approve }));
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole('button', {
          name: en.approvalGate.confirm.proceed.replace('{verb}', en.approvalGate.verb.approve),
        }),
      );
    });

    // ⚠️ THE STAMP THE READ HANDED OVER, never one fetched at press time (MOTIR-5235).
    expect(decideApprovalGateAction).toHaveBeenCalledWith({
      gateId: 'gate-acc',
      decision: 'approve',
      identifier: 'GATE-1',
      stamp: 'v1.stamp-the-read-handed-over',
    });
    expect(announceGateDecided).toHaveBeenCalled();
  });

  it('a receipt with NO version names the recording plainly rather than an empty citation', async () => {
    openAt('GATE-1', 'acceptance_result');
    fetchApprovalGateOverlay.mockResolvedValue(
      readOf({
        gate: { ...ACCEPTANCE_GATE, subjectVersion: null },
        subject: { state: 'resolved', kind: 'acceptance_result', evidence: RECEIPT } as never,
      }),
    );
    await renderOverlay();

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(en.approvalGate.acceptanceResult.meta.plain)).toBeTruthy();
  });

  it('a DECIDED acceptance keeps its port and loses its verbs — state `B`, the read\u2019s answer', async () => {
    openAt('GATE-1', 'acceptance_result');
    fetchApprovalGateOverlay.mockResolvedValue(
      readOf({
        gate: {
          ...ACCEPTANCE_GATE,
          state: 'approved',
          decidedByLabel: 'Ada L.',
          decidedAt: '2026-09-19T15:02:00.000Z',
        },
        canDecide: false,
        subject: { state: 'resolved', kind: 'acceptance_result', evidence: RECEIPT } as never,
      }),
    );
    await renderOverlay();

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /Open the story/ })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: en.approvalGate.verb.approve })).toBeNull();
  });

  it('a STALE press is refused in place, and the recording\u2019s own *Show the current version* re-reads it (MOTIR-5792)', async () => {
    // The acceptance arm mounts its OWN frame, so its re-read handler is a separate line
    // of code from the design arm's — asserted here rather than assumed to follow.
    openAt('GATE-1', 'acceptance_result');
    const acceptanceRead = (over: Partial<ApprovalGateOverlayReadDTO> = {}) =>
      readOf({
        gate: ACCEPTANCE_GATE,
        subject: { state: 'resolved', kind: 'acceptance_result', evidence: RECEIPT } as never,
        ...over,
      });
    fetchApprovalGateOverlay
      .mockResolvedValueOnce(acceptanceRead())
      .mockResolvedValueOnce(acceptanceRead({ stamp: 'v1.the-current-recording' }));
    decideApprovalGateAction.mockResolvedValue({
      ok: false,
      refusal: { tag: 'APPROVAL_GATE_STALE_SUBJECT', moved: ['subject'] },
    });
    await renderOverlay();

    await refuseWithReason();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(en.approvalGate.refusal.stale.subject)).toBeTruthy();

    await act(async () => {
      fireEvent.click(
        within(alert).getByRole('button', { name: en.approvalGate.refusal.stale.control }),
      );
    });

    // The SAME read, run again — the recording is re-read in place, never navigated to.
    expect(fetchApprovalGateOverlay).toHaveBeenCalledTimes(2);
    expect(fetchApprovalGateOverlay.mock.calls[1]!.slice(0, 2)).toEqual([
      'GATE-1',
      'acceptance_result',
    ]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // THE REFUSAL ASKS BY RUN SHAPE, THEN HANDS OFF (Story MOTIR-6071 · MOTIR-6506; design
  // `approval-control--acceptance-verdict.mock.html` panels 3a, 7a, 8a).
  const reasonCopy = en.approvalGate.reason;
  const acceptanceCopy = en.approvalGate.acceptanceResult;
  const REASON = 'Scheduled exports send at UTC midnight, not the workspace time zone.';
  const STATUSES = [
    { key: 'in_review', label: 'In Review', category: 'in_progress', isInitial: false },
    { key: 'done', label: 'Done', category: 'done', isInitial: false },
  ] as ApprovalGateOverlayReadDTO['statuses'];

  async function openRefusable(offersRefusalVerdict: boolean) {
    openAt('GATE-1', 'acceptance_result');
    fetchApprovalGateOverlay.mockResolvedValue(
      readOf({
        gate: { ...ACCEPTANCE_GATE, offersRefusalVerdict },
        canReplan: true,
        statuses: STATUSES,
        subject: { state: 'resolved', kind: 'acceptance_result', evidence: RECEIPT } as never,
      }),
    );
    await renderOverlay();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: en.approvalGate.verb.requestChanges }),
    );
    return dialog;
  }

  const refused = (refusalVerdict: ApprovalGateDTO['refusalVerdict']): ApprovalGateDTO => ({
    ...ACCEPTANCE_GATE,
    state: 'changes_requested',
    decidedById: 'user-1',
    decidedByLabel: 'Ada L.',
    decidedAt: '2026-09-26T10:00:00.000Z',
    decisionSource: 'ui',
    noteMd: REASON,
    refusalVerdict,
  });

  it('a FINISHED story: the reason only, the no-re-run line, the shipped two lines — and no verdict group', async () => {
    const dialog = await openRefusable(false);
    expect(within(dialog).getByLabelText(reasonCopy.label)).toBeTruthy();
    expect(within(dialog).queryByTestId('refusal-verdict-group')).toBeNull();
    expect(within(dialog).getByTestId('refusal-no-rerun').textContent).toBe(
      acceptanceCopy.refusal.noRerun,
    );
    expect(within(dialog).getByText(reasonCopy.consequence.versionBack)).toBeTruthy();
    expect(within(dialog).getByText('Leave GATE-1 where it is — nothing moves yet.')).toBeTruthy();
  });

  it('a STORY RUN in the standalone arm: the Re-run / Re-plan pair, and no no-re-run line', async () => {
    const dialog = await openRefusable(true);
    const group = within(dialog).getByRole('radiogroup', { name: acceptanceCopy.verdict.legend });
    expect(within(group).getByRole('radio', { name: /^Re-run/ })).toBeTruthy();
    expect(within(group).getByRole('radio', { name: /^Re-plan/ })).toBeTruthy();
    expect(within(dialog).queryByTestId('refusal-no-rerun')).toBeNull();
    expect(within(dialog).queryByText('Leave GATE-1 where it is — nothing moves yet.')).toBeNull();
  });

  it('a finished-story press sends NO verdict, never repaints the header, and ASKS for a remedy', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: refused(null),
      filesKept: null,
      // Even a stale server answering a status is not painted for an acceptance refusal.
      statusWritten: 'done',
    });
    const dialog = await openRefusable(false);
    fireEvent.change(within(dialog).getByLabelText(reasonCopy.label), {
      target: { value: REASON },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: reasonCopy.proceed }));
    });

    const sent = decideApprovalGateAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ decision: 'request_changes', noteMd: REASON });
    expect(sent).not.toHaveProperty('refusalVerdict');
    expect(within(dialog).getAllByText('In Review', { exact: true })).toHaveLength(1);
    expect(within(dialog).queryByText('Done', { exact: true })).toBeNull();
    // The chip: this reader's own press knows the story is finished.
    expect(within(dialog).getByTestId('refusal-verdict').textContent).toBe(
      reasonCopy.record.verdict.remedy,
    );
    const ask = screen.getByTestId('refusal-replan-ask');
    expect(ask.getAttribute('data-mode')).toBe('remedy');
    expect(
      within(ask).getByText(acceptanceCopy.remedyAsk.title.replace('{key}', 'GATE-1')),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: en.planningWorkspace.handoff.notNow }));
    const door = screen.getByTestId('refusal-replan-door');
    expect(door.getAttribute('data-mode')).toBe('remedy');
    expect(door.textContent).toBe(acceptanceCopy.remedyDoor.label);
  });

  it('a story-run Re-run in the standalone arm sends `revise` and asks NOTHING', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: refused('revise'),
      filesKept: null,
      statusWritten: null,
    });
    const dialog = await openRefusable(true);
    fireEvent.change(within(dialog).getByLabelText(reasonCopy.label), {
      target: { value: REASON },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Re-run/ }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: reasonCopy.proceed }));
    });
    expect(decideApprovalGateAction).toHaveBeenCalledWith(
      expect.objectContaining({ refusalVerdict: 'revise' }),
    );
    expect(within(dialog).getByTestId('refusal-verdict').textContent).toBe(
      reasonCopy.record.verdict.rerun,
    );
    expect(screen.queryByTestId('refusal-replan-ask')).toBeNull();
    expect(screen.queryByTestId('refusal-replan-door')).toBeNull();
  });

  it('a later reader of a verdict-less record sees the door but no remedy chip (the run shape is unknown here)', async () => {
    openAt('GATE-1', 'acceptance_result');
    fetchApprovalGateOverlay.mockResolvedValue(
      readOf({
        gate: refused(null),
        canDecide: false,
        canReplan: true,
        subject: { state: 'resolved', kind: 'acceptance_result', evidence: RECEIPT } as never,
      }),
    );
    await renderOverlay();
    expect(screen.queryByTestId('refusal-verdict')).toBeNull();
    expect(screen.getByTestId('refusal-replan-door').getAttribute('data-mode')).toBe('remedy');
  });

  it('a recording that no longer resolves is the GONE state, not an empty player', async () => {
    openAt('GATE-1', 'acceptance_result');
    fetchApprovalGateOverlay.mockResolvedValue(
      readOf({ gate: ACCEPTANCE_GATE, subject: { state: 'gone' } as never }),
    );
    await renderOverlay();

    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(en.workbench.approvals.subjectGone.acceptance_result),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: en.approvalGate.verb.approve })).toBeNull();
  });
});

describe('a CHOICE in the overlay (Story MOTIR-4914 · MOTIR-5896)', () => {
  const ch = en.approvalGate.choice;
  const stale = en.approvalGate.refusal.stale;
  const staleRefusal = (moved: ('subject' | 'pull_requests' | 'criteria')[]) => ({
    ok: false as const,
    refusal: { tag: 'APPROVAL_GATE_STALE_SUBJECT' as const, moved },
  });
  const CHOICE_READ = () =>
    readOf({
      gate: { ...GATE, kind: 'decision_choice', subjectId: 'wi-1' },
      subject: {
        state: 'resolved',
        kind: 'decision_choice',
        choice: {
          question: 'Where do exports live?',
          why: { situation: 'two_workflows', youSaid: null, evidenceMd: 'It forks.' },
          options: [
            { id: 'managed', label: 'Managed', bestFor: 'less to operate', whyMd: 'A.' },
            { id: 'ours', label: 'Ours', bestFor: 'more cost-effective', whyMd: 'B.' },
          ],
          followUpMd: 'The export story.',
          subjectVersion: 'a'.repeat(64),
        },
      },
    });

  async function pick(label: string) {
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: new RegExp(label) }));
    });
    fireEvent.click(screen.getByRole('button', { name: ch.verb.choose.replace('{label}', label) }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: ch.confirm.proceed.replace('{label}', label) }),
      );
    });
  }

  it('sends the OPTION with the choose, and announces what the decision WROTE', async () => {
    openAt('GATE-1', 'decision_choice');
    fetchApprovalGateOverlay.mockResolvedValue(CHOICE_READ());
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: { ...GATE, kind: 'decision_choice', state: 'approved', outcomeRef: 'ours' },
      filesKept: null,
      statusWritten: 'done',
    });
    await renderOverlay();
    await pick('Ours');
    expect(decideApprovalGateAction).toHaveBeenCalledWith({
      gateId: 'gate-1',
      decision: 'choose',
      optionId: 'ours',
      identifier: 'GATE-1',
      stamp: 'v1.stamp-the-read-handed-over',
    });
    // The rail underneath reads `statusWritten`, never the choice's option-id outcomeRef.
    expect(announceGateDecided).toHaveBeenCalledWith(
      expect.objectContaining({ statusWritten: 'done' }),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a stale refusal offers “Show the current version”, which re-reads the choice in place', async () => {
    openAt('GATE-1', 'decision_choice');
    fetchApprovalGateOverlay.mockResolvedValue(CHOICE_READ());
    decideApprovalGateAction.mockResolvedValue(staleRefusal(['subject']));
    await renderOverlay();
    await pick('Managed');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: stale.control }));
    });
    expect(fetchApprovalGateOverlay).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('radiogroup')).toBeTruthy();
  });
});
