// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type {
  ApprovalGateDTO,
  ApprovalQueueRowDto,
  ApprovalRecordDecidedRowDto,
  ManualWorkSubjectSummaryDTO,
} from '@/lib/dto/approvalGate';

// THE MANUAL-WORK ROW (Story MOTIR-7460 · Subtask MOTIR-7478), built to
// `design/workbench/approvals-row--manual-work.mock.html` and § 33.2 of
// `design/workbench/design-notes.md`: the one kind whose SENTENCE depends on state and
// routing, whose details carry the to-do progress and the Guide me through door, and whose
// Decide cell holds MARK DONE — the one row that decides from the row, settling in place
// from the write's own response (`lib/approvals/decidedGates.ts`).

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=approvals'),
}));
const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));
const { decideApprovalGateAction } = vi.hoisted(() => ({ decideApprovalGateAction: vi.fn() }));
vi.mock('@/app/(authed)/items/[key]/approvalGateActions', () => ({
  decideApprovalGateAction,
  approveAndMergeAction: vi.fn(),
  retryApproveAndMergeMemberAction: vi.fn(),
}));

const { ApprovalRow } = await import('@/components/approvals/ApprovalRow');

const TITLE = { en: 'Create the production Stripe account', zh: '创建生产环境的 Stripe 账户' };
const WITH_LIST: ManualWorkSubjectSummaryDTO = {
  kind: 'manual_work',
  todos: { done: 2, total: 5 },
  stamp: 'v1.row-stamp',
};
const NO_LIST: ManualWorkSubjectSummaryDTO = { kind: 'manual_work', todos: null, stamp: 'v1.s' };

let seq = 0;
function awaiting(
  subject: ManualWorkSubjectSummaryDTO | null = WITH_LIST,
  locale: 'en' | 'zh' = 'en',
  canDecide = true,
): ApprovalQueueRowDto {
  seq += 1;
  return {
    // A fresh gate per test: the decided-gates store is page-global.
    gateId: `gate-mw-${seq}`,
    kind: 'manual_work',
    state: 'awaiting',
    canDecide,
    routedToName: 'Mara S.',
    waitingSince: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    workItem: {
      id: 'wi-31',
      key: 31,
      identifier: 'ACME-31',
      title: TITLE[locale],
      kind: 'task',
      type: 'manual',
    },
    subject,
  } as ApprovalQueueRowDto;
}

function sentence(locale: 'en' | 'zh', key: string): string {
  const messages = locale === 'en' ? en : zh;
  return (messages.workbench.approvals.sentence as Record<string, string>)
    [key]!.replace(/<\/?title>/g, '')
    .replace('{name}', TITLE[locale]);
}

function render(
  props: Parameters<typeof ApprovalRow>[0],
  locale: 'en' | 'zh' = 'en',
): ReturnType<typeof renderWithIntl> {
  return renderWithIntl(<ApprovalRow {...props} />, {
    locale,
    messages: locale === 'en' ? en : zh,
  });
}

/** The row door's accessible name carries the whole sentence. */
function doorName(): string {
  return screen.getAllByRole('link')[0]!.getAttribute('aria-label') ?? '';
}

const t = en.workbench.approvals;

beforeEach(() => {
  decideApprovalGateAction.mockReset();
  shallowPush.mockReset();
  refresh.mockReset();
});
afterEach(cleanup);

describe('a PENDING manual-work row in the tab', () => {
  it('reads *is waiting on you*, with the progress, the door, the age and Mark done', () => {
    render({ record: { section: 'awaiting', row: awaiting() }, routedToReader: true });

    expect(doorName()).toBe(`Review ACME-31 — ${sentence('en', 'manual_work')}`);
    expect(
      screen.getByText(t.manualSteps.replace('{done}', '2').replace('{total}', '5')),
    ).toBeTruthy();
    const door = screen.getByRole('link', { name: en.runs.guide.door });
    expect(door.getAttribute('href')).toBe(
      '/items/ACME-31?plan=guide&planFrom=guide&planItem=ACME-31',
    );
    // Above the stretched row door, as the title door is.
    expect(door.className).toMatch(/\brelative\b.*\bz-10\b/);
    expect(screen.getByText(/2h/)).toBeTruthy();
    expect(screen.getByRole('button', { name: t.markDone })).toBeTruthy();
    // Mark done takes Review's place — there is no Review button on this row.
    expect(screen.queryByRole('button', { name: t.review })).toBeNull();
  });

  it('a card with no to-do list says so, never *0/0*', () => {
    render({ record: { section: 'awaiting', row: awaiting(NO_LIST) }, routedToReader: true });
    expect(screen.getByText(t.manualNoList)).toBeTruthy();
    expect(screen.queryByText(/0\/0/)).toBeNull();
    expect(screen.getByRole('link', { name: en.runs.guide.door })).toBeTruthy();
  });

  it('Guide me through opens the guide over the Workbench; a modified click keeps the href', () => {
    render({ record: { section: 'awaiting', row: awaiting() }, routedToReader: true });
    const door = screen.getByRole('link', { name: en.runs.guide.door });

    fireEvent.click(door, { metaKey: true });
    expect(shallowPush).not.toHaveBeenCalled();

    fireEvent.click(door);
    expect(shallowPush).toHaveBeenCalledTimes(1);
    const to = new URL(shallowPush.mock.calls[0]![0] as string, 'http://x');
    expect(to.pathname).toBe('/workbench');
    expect(to.searchParams.get('tab')).toBe('approvals');
    expect(to.searchParams.get('plan')).toBe('guide');
    expect(to.searchParams.get('planFrom')).toBe('guide');
    expect(to.searchParams.get('planItem')).toBe('ACME-31');
  });

  it('renders in zh', () => {
    render(
      { record: { section: 'awaiting', row: awaiting(WITH_LIST, 'zh') }, routedToReader: true },
      'zh',
    );
    expect(doorName()).toContain(sentence('zh', 'manual_work'));
    expect(screen.getByText('2/5 步')).toBeTruthy();
    expect(screen.getByRole('link', { name: zh.runs.guide.door })).toBeTruthy();
    expect(screen.getByRole('button', { name: zh.workbench.approvals.markDone })).toBeTruthy();
  });
});

describe('MARK DONE decides from the row and the row SETTLES in place', () => {
  it('presses the decide door with the row’s stamp, shows Marking…, then reads *was marked done*', async () => {
    const row = awaiting();
    let resolve!: (value: unknown) => void;
    decideApprovalGateAction.mockReturnValue(new Promise((r) => (resolve = r)));
    render({ record: { section: 'awaiting', row }, routedToReader: true });

    fireEvent.click(screen.getByRole('button', { name: t.markDone }));
    expect(decideApprovalGateAction).toHaveBeenCalledWith({
      gateId: row.gateId,
      decision: 'approve',
      identifier: 'ACME-31',
      stamp: 'v1.row-stamp',
    });
    const pending = screen.getByRole('button', { name: t.marking });
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect((pending as HTMLButtonElement).disabled).toBe(true);

    const gate = { id: row.gateId, kind: 'manual_work', state: 'approved' } as ApprovalGateDTO;
    await act(async () => {
      resolve({ ok: true, gate, filesKept: null, statusWritten: 'done' });
    });

    // SETTLED, NOT GONE — the § 22 signal, which a client island needs (case 3).
    expect(doorName()).toBe(`Review ACME-31 — ${sentence('en', 'manual_work_done')}`);
    expect(screen.getByText(en.approvalGate.manualWork.state.markedDone)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.markDone })).toBeNull();
    expect(screen.queryByRole('link', { name: en.runs.guide.door })).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it('a REFUSED press opens the approval overlay, where the frame says why', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: false,
      refusal: { tag: 'APPROVAL_GATE_ALREADY_DECIDED', decidedByLabel: 'Sam' },
    });
    render({ record: { section: 'awaiting', row: awaiting() }, routedToReader: true });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.markDone }));
    });
    expect(shallowPush).toHaveBeenCalledWith(
      '/workbench?tab=approvals&approval=ACME-31&approvalKind=manual_work',
    );
    expect(screen.getByRole('button', { name: t.markDone })).toBeTruthy();
  });
});

// THE PRESS RACES THE LIST (Bug MOTIR-9696). A later list read — the action's own
// `revalidatePath` re-seed, or a live window read — can drop the gate BEFORE the press's
// answer arrives, and the list then hands the row back as HELD. A held row with no
// announced state draws *Decided elsewhere*, which is false for a press made on this row:
// the page-wide pending mark is what tells the two apart.
describe('a HELD section that lands BEFORE the press answers (MOTIR-9696)', () => {
  function pressThenHold() {
    const row = awaiting();
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    decideApprovalGateAction.mockReturnValue(
      new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      }),
    );
    const view = render({ record: { section: 'awaiting', row }, routedToReader: true });
    fireEvent.click(screen.getByRole('button', { name: t.markDone }));
    // The list read lands first: the row comes back HELD.
    view.rerender(<ApprovalRow record={{ section: 'held', row }} routedToReader />);
    return { row, resolve, reject };
  }

  it('keeps drawing Marking…, never *Decided elsewhere*, then settles as marked done', async () => {
    const { row, resolve } = pressThenHold();

    expect(screen.queryByText(t.live.decidedElsewhere)).toBeNull();
    const pending = screen.getByRole('button', { name: t.marking });
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    // The sentence is still the pending question's, not the held form.
    expect(doorName()).toBe(`Review ACME-31 — ${sentence('en', 'manual_work')}`);

    const gate = { id: row.gateId, kind: 'manual_work', state: 'approved' } as ApprovalGateDTO;
    await act(async () => {
      resolve({ ok: true, gate, filesKept: null, statusWritten: 'done' });
    });

    expect(screen.queryByText(t.live.decidedElsewhere)).toBeNull();
    expect(doorName()).toBe(`Review ACME-31 — ${sentence('en', 'manual_work_done')}`);
    expect(screen.getByText(en.approvalGate.manualWork.state.markedDone)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.marking })).toBeNull();
  });

  it('a REFUSED press clears the mark: the held row now says *Decided elsewhere*, and the overlay opens', async () => {
    const { resolve } = pressThenHold();
    expect(screen.queryByText(t.live.decidedElsewhere)).toBeNull();

    await act(async () => {
      resolve({
        ok: false,
        refusal: { tag: 'APPROVAL_GATE_ALREADY_DECIDED', decidedByLabel: 'Sam' },
      });
    });

    // Somebody else's answer won — the held pill is now TRUE, so it is drawn.
    expect(screen.getByText(t.live.decidedElsewhere)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.marking })).toBeNull();
    expect(shallowPush).toHaveBeenCalledWith(
      '/workbench?tab=approvals&approval=ACME-31&approvalKind=manual_work',
    );
  });

  it('a press that THROWS clears the mark the same way', async () => {
    const { reject } = pressThenHold();

    await act(async () => {
      reject(new Error('network'));
    });

    expect(screen.getByText(t.live.decidedElsewhere)).toBeTruthy();
    expect(shallowPush).toHaveBeenCalledTimes(1);
  });

  it('a refused press on a row the list still holds returns it to Mark done', async () => {
    const row = awaiting();
    let resolve!: (value: unknown) => void;
    decideApprovalGateAction.mockReturnValue(new Promise((r) => (resolve = r)));
    render({ record: { section: 'awaiting', row }, routedToReader: true });
    fireEvent.click(screen.getByRole('button', { name: t.markDone }));

    await act(async () => {
      resolve({ ok: false, refusal: { tag: 'APPROVAL_GATE_STALE_SUBJECT' } });
    });

    expect(screen.getByRole('button', { name: t.markDone })).toBeTruthy();
    expect(screen.queryByText(t.live.decidedElsewhere)).toBeNull();
  });
});

describe('the other forms', () => {
  it('a HELD row (left the set while looking) reads the neutral form and *Decided elsewhere*', () => {
    render({ record: { section: 'held', row: awaiting() }, routedToReader: true });
    expect(doorName()).toBe(`Review ACME-31 — ${sentence('en', 'manual_work_held')}`);
    expect(screen.getByText(t.live.decidedElsewhere)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.markDone })).toBeNull();
    expect(screen.queryByRole('link', { name: en.runs.guide.door })).toBeNull();
  });

  it('in the room, a question waiting on SOMEBODY ELSE reads *is waiting on a person* — no verb, no door', () => {
    render({
      record: { section: 'awaiting', row: awaiting(WITH_LIST, 'en', false) },
      person: { label: 'Asked of', value: 'Mara S.' },
    });
    expect(doorName()).toBe(`Review ACME-31 — ${sentence('en', 'manual_work_other')}`);
    expect(screen.getByText(en.approvalGate.state.awaiting)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.markDone })).toBeNull();
    expect(screen.queryByRole('link', { name: en.runs.guide.door })).toBeNull();
  });

  it('a DECIDED record reads *was marked done* with the Marked done pill', () => {
    const record = {
      ...awaiting(),
      state: 'approved',
      decidedAt: new Date().toISOString(),
      decidedByLabel: 'Yue',
      decisionSource: 'ui',
      subjectVersion: null,
      chosenOption: null,
      confirmedRecord: null,
      refusalReason: null,
      refusalVerdict: null,
    } as unknown as ApprovalRecordDecidedRowDto;
    render({ record: { section: 'decided', row: record } });
    expect(doorName()).toBe(`Review ACME-31 — ${sentence('en', 'manual_work_done')}`);
    expect(screen.getByText(en.approvalGate.manualWork.state.markedDone)).toBeTruthy();
    expect(screen.queryByRole('link', { name: en.runs.guide.door })).toBeNull();
  });

  it('a card that stopped being manual (subject gone) reads the neutral form and says Gone', () => {
    render({ record: { section: 'awaiting', row: awaiting(null) }, routedToReader: true });
    expect(doorName()).toBe(`Review ACME-31 — ${sentence('en', 'manual_work_held')}`);
    expect(screen.getByText(t.subjectGonePill)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.markDone })).toBeNull();
  });
});
