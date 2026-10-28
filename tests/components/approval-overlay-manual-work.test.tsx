// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type {
  ApprovalGateDTO,
  ApprovalGateOverlayReadDTO,
  ManualWorkPortDTO,
} from '@/lib/dto/approvalGate';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';

// THE MANUAL-WORK PORT in the approval overlay (Story MOTIR-7460 · Subtask MOTIR-7478),
// built to `design/workbench/approval-overlay--manual-work.mock.html` and § 33.3 of
// `design/workbench/design-notes.md`: band 1's kind line with the to-do progress, the
// card's to-do list READ-ONLY (the box drawn by state, never a control), and band 3's two
// controls — *Guide me through* (a door) and *Mark done* (the one verb, no confirm). No
// Request changes. A reader it is not routed to sees no control at all (state `B`).

let params = new URLSearchParams();
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/workbench',
  useSearchParams: () => params,
}));

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { fetchApprovalGateOverlay } = vi.hoisted(() => ({ fetchApprovalGateOverlay: vi.fn() }));
vi.mock('@/lib/approvals/approvalOverlayClient', () => ({ fetchApprovalGateOverlay }));

const { decideApprovalGateAction } = vi.hoisted(() => ({ decideApprovalGateAction: vi.fn() }));
vi.mock('@/app/(authed)/items/[key]/approvalGateActions', () => ({
  decideApprovalGateAction,
  approveAndMergeAction: vi.fn(),
  retryApproveAndMergeMemberAction: vi.fn(),
}));

const { announceGateDecided } = vi.hoisted(() => ({ announceGateDecided: vi.fn() }));
vi.mock('@/lib/approvals/decidedGates', () => ({
  announceGateDecided,
  useDecidedGate: () => null,
  useDecidedGateState: () => null,
  // The press-in-flight mark (MOTIR-9696) has nothing to tell a list here.
  markGatePressPending: () => {},
  clearGatePressPending: () => {},
  useGatePressPending: () => false,
}));

const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');

const GATE: ApprovalGateDTO = {
  id: 'gate-mw',
  workItemId: 'wi-31',
  kind: 'manual_work',
  subjectId: 'wi-31',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: null,
  decidedByLabel: null,
  routedToId: 'user-1',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  confirmedRecord: null,
  refusalVerdict: null,
  offersRefusalVerdict: false,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-10-03T04:00:00.000Z',
  updatedAt: '2026-10-03T04:00:00.000Z',
};

function todo(id: string, text: string, done: boolean): WorkItemTodoDto {
  return {
    id,
    text,
    commandText: null,
    notesMd: null,
    executor: null,
    done,
    doneBy: done ? { id: 'user-1', name: 'Yue Zhu' } : null,
  } as unknown as WorkItemTodoDto;
}

const WITH_LIST: ManualWorkPortDTO = {
  todos: [
    todo('t1', 'Sign in to Stripe as the company owner', true),
    todo('t2', 'Verify the business details and the bank account', true),
    todo('t3', 'Turn on live mode and create a restricted key', false),
  ],
  progress: { done: 2, total: 3 },
  mergeWritesDone: false,
};

function readOf(
  view: ManualWorkPortDTO = WITH_LIST,
  overrides: Partial<ApprovalGateOverlayReadDTO> = {},
): ApprovalGateOverlayReadDTO {
  return {
    workItem: {
      id: 'wi-31',
      identifier: 'ACME-31',
      title: 'Create the production Stripe account',
      status: 'todo',
      parentIdentifier: null,
    },
    statuses: [],
    gate: GATE,
    canDecide: true,
    canReplan: false,
    routedToLabel: 'Mara S.',
    stamp: 'v1.the-read-stamp',
    movedSince: [],
    earlierApproval: null,
    subject: { state: 'resolved', kind: 'manual_work', manualWork: view },
    ...overrides,
  };
}

async function renderOverlay(locale: 'en' | 'zh' = 'en') {
  params = new URLSearchParams('tab=approvals&approval=ACME-31&approvalKind=manual_work');
  const utils = render(<ApprovalOverlay />, {
    locale,
    messages: locale === 'en' ? en : zh,
  });
  await act(async () => {});
  return utils;
}

const mw = en.approvalGate.manualWork;

beforeEach(() => {
  fetchApprovalGateOverlay.mockReset();
  decideApprovalGateAction.mockReset();
  announceGateDecided.mockReset();
  shallowPush.mockReset();
  refresh.mockReset();
});
afterEach(cleanup);

describe('the manual-work port, PENDING', () => {
  it('names the kind, the progress and the list — read-only, the box drawn by state', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();

    const dialog = screen.getByRole('dialog', { name: 'Manual work for ACME-31' });
    expect(within(dialog).getByText(en.workbench.approvals.kind.manual_work)).toBeTruthy();
    expect(
      within(dialog).getByText(mw.meta.replace('{done}', '2').replace('{total}', '3')),
    ).toBeTruthy();
    expect(within(dialog).getByText(mw.lead)).toBeTruthy();
    expect(within(dialog).getByText('2 of 3 done')).toBeTruthy();

    const rows = within(dialog).getAllByTestId('todo-row-readonly');
    expect(rows).toHaveLength(3);
    // THE BOX IS NOT A CONTROL — no checkbox anywhere in the port.
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    const boxes = within(dialog).getAllByTestId('todo-checkbox-inert');
    expect(boxes.map((box) => box.dataset.todoDone)).toEqual(['true', 'true', 'false']);
  });

  it('offers Guide me through (a link) and Mark done — and no Request changes', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();

    const door = screen.getByRole('link', { name: en.runs.guide.door });
    expect(door.getAttribute('href')).toBe(
      '/items/ACME-31?plan=guide&planFrom=guide&planItem=ACME-31',
    );
    expect(screen.getByRole('button', { name: en.workbench.approvals.markDone })).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.approvalGate.verb.requestChanges })).toBeNull();
    expect(screen.getByText(mw.consequence.replace('{key}', 'ACME-31'))).toBeTruthy();
  });

  it('Guide me through leaves the approval for the guide, over the same page', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();

    fireEvent.click(screen.getByRole('link', { name: en.runs.guide.door }));
    expect(shallowPush).toHaveBeenCalledTimes(1);
    const to = new URL(shallowPush.mock.calls[0]![0] as string, 'http://x');
    expect(to.pathname).toBe('/workbench');
    expect(to.searchParams.get('tab')).toBe('approvals');
    expect(to.searchParams.get('plan')).toBe('guide');
    expect(to.searchParams.get('planItem')).toBe('ACME-31');
    expect(to.searchParams.get('approval')).toBeNull();
  });

  it('with no to-do list: says so, never *0 of 0*, and keeps both controls', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(
      readOf({ todos: [], progress: { done: 0, total: 0 }, mergeWritesDone: false }),
    );
    await renderOverlay();

    expect(screen.getByText(mw.metaNoList)).toBeTruthy();
    expect(screen.getByText(mw.leadNoList)).toBeTruthy();
    expect(screen.getByText(mw.noList.title)).toBeTruthy();
    expect(screen.getByText(mw.noList.body)).toBeTruthy();
    expect(screen.queryByText(/0 of 0/)).toBeNull();
    expect(screen.getByRole('link', { name: en.runs.guide.door })).toBeTruthy();
    expect(screen.getByRole('button', { name: en.workbench.approvals.markDone })).toBeTruthy();
  });

  it('with an open pull request the consequence says the merge writes Done', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(readOf({ ...WITH_LIST, mergeWritesDone: true }));
    await renderOverlay();
    expect(screen.getByText(mw.consequenceMerges.replace('{key}', 'ACME-31'))).toBeTruthy();
  });

  it('renders in zh', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay('zh');
    expect(
      screen.getByRole('dialog', {
        name: zh.approvalOverlay.dialogTitle
          .replace('{kind}', zh.workbench.approvals.kind.manual_work)
          .replace('{key}', 'ACME-31'),
      }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: zh.runs.guide.door })).toBeTruthy();
    expect(screen.getByRole('button', { name: zh.workbench.approvals.markDone })).toBeTruthy();
  });
});

describe('MARK DONE in the overlay', () => {
  it('decides with the read’s stamp and no confirm; while it records, Marking… and the door dims', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    let resolve!: (value: unknown) => void;
    decideApprovalGateAction.mockReturnValue(new Promise((r) => (resolve = r)));
    await renderOverlay();

    fireEvent.click(screen.getByRole('button', { name: en.workbench.approvals.markDone }));
    expect(decideApprovalGateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        gateId: 'gate-mw',
        decision: 'approve',
        identifier: 'ACME-31',
        stamp: 'v1.the-read-stamp',
      }),
    );
    const pending = screen.getByRole('button', { name: en.workbench.approvals.marking });
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    const door = screen.getByRole('link', { name: en.runs.guide.door, hidden: true });
    expect(door.getAttribute('aria-disabled')).toBe('true');

    await act(async () => {
      resolve({
        ok: true,
        gate: {
          ...GATE,
          state: 'approved',
          decidedByLabel: 'Yue Zhu',
          decidedAt: '2026-10-03T05:00:00.000Z',
        },
        filesKept: null,
        statusWritten: 'done',
      });
    });

    // DECIDED — the overlay stays open on the record: *Marked done*, the done lead, who.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(mw.state.markedDone)).toBeTruthy();
    expect(screen.getByText(mw.leadDone)).toBeTruthy();
    expect(screen.getByText('Yue Zhu')).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.workbench.approvals.markDone })).toBeNull();
    expect(screen.queryByRole('link', { name: en.runs.guide.door })).toBeNull();
    expect(announceGateDecided).toHaveBeenCalledWith(
      expect.objectContaining({ gate: expect.objectContaining({ state: 'approved' }) }),
    );
    expect(refresh).toHaveBeenCalled();
  });
});

describe('a STALE Mark done', () => {
  // The manual-work arm mounts its own frame, as the choice and confirm arms do — so its
  // stale refusal's *Show the current version* is asserted here, not assumed to follow
  // from theirs. Its moved notice is in `approval-overlay-subject-moved.test.tsx`.
  it('a stale press draws the refusal with its one control, and the control re-reads', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    decideApprovalGateAction.mockResolvedValue({
      ok: false,
      refusal: { tag: 'APPROVAL_GATE_STALE_SUBJECT', moved: ['subject'] },
    });
    await renderOverlay();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.workbench.approvals.markDone }));
    });
    const alert = await screen.findByRole('alert');
    const before = fetchApprovalGateOverlay.mock.calls.length;
    await act(async () => {
      fireEvent.click(
        within(alert).getByRole('button', { name: en.approvalGate.refusal.stale.control }),
      );
    });
    expect(fetchApprovalGateOverlay.mock.calls.length).toBeGreaterThan(before);
    expect(announceGateDecided).not.toHaveBeenCalled();
  });
});

describe('READ-ONLY and WITHDRAWN', () => {
  it('a reader it is not routed to sees the list and who it waits on — no control at all', async () => {
    fetchApprovalGateOverlay.mockResolvedValue(readOf(WITH_LIST, { canDecide: false }));
    await renderOverlay();

    expect(screen.getAllByTestId('todo-row-readonly')).toHaveLength(3);
    expect(screen.getByText(en.approvalGate.state.awaiting)).toBeTruthy();
    expect(screen.getByText(/Waiting on Mara S\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.workbench.approvals.markDone })).toBeNull();
    expect(screen.queryByRole('link', { name: en.runs.guide.door })).toBeNull();
  });

  it.each([
    ['no_longer_manual', en.approvalGate.withdrawn.cause.no_longer_manual],
    ['closed_without_decision', en.approvalGate.withdrawn.cause.closed_without_decision],
    ['pulled_back', en.approvalGate.withdrawn.causeByKind.manual_work.pulled_back],
  ] as const)(
    'a gate withdrawn for `%s` says why, names nobody, offers nothing',
    async (cause, line) => {
      fetchApprovalGateOverlay.mockResolvedValue(
        readOf(WITH_LIST, { gate: { ...GATE, state: 'superseded', supersededCause: cause } }),
      );
      await renderOverlay();

      expect(screen.getByText(line)).toBeTruthy();
      expect(screen.getByText(en.approvalGate.state.withdrawn)).toBeTruthy();
      expect(screen.getByText(en.approvalGate.withdrawn.record)).toBeTruthy();
      expect(screen.queryByRole('button', { name: en.workbench.approvals.markDone })).toBeNull();
      expect(screen.queryByRole('link', { name: en.runs.guide.door })).toBeNull();
    },
  );
});
