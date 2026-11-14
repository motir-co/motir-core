// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/items/ACME-40',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// PLAN SOMETHING NEW in the rail (Story MOTIR-7631 · MOTIR-7650), drawn to
// MOTIR-7647's `planning-workspace--plan-something-new.mock.html`. The rail is
// presentational, so each panel is asserted by handing it the server's thread.
//
// MOTIR-11261 (design MOTIR-11260, `planning-workspace--plan-something-new--modal.mock.html`):
// the control asks in a confirm DIALOG, and writes nothing to the thread. The confirm
// TURN below is the record a session kept from before — still drawn and answerable.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });

function turn(
  seq: number,
  role: PlanChangeTurnDto['role'] = 'user',
  extra: Partial<PlanChangeTurnDto> = {},
): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role,
    body: role === 'user' ? 'Split the export work.' : 'Done.',
    jobId: role === 'assistant' ? 'job-1' : null,
    question: null,
    confirm: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-10-06T10:00:00.000Z',
    ...extra,
  };
}

const CONFIRM = turn(2, 'assistant', {
  jobId: null,
  confirm: 'new_session',
  // The STORED body — the rail must not render it; it reads the catalogue.
  body: 'stored body that should never show',
});

function session(
  turns: PlanChangeTurnDto[],
  extra: Partial<PlanChangeSessionDto> = {},
): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: ['ACME-40'],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-06T10:00:00.000Z',
    origin: 'conversation',
    startedByViewer: true,
    createdAt: '2026-10-06T09:00:00.000Z',
    updatedAt: '2026-10-06T10:00:00.000Z',
    turns,
    workItemRefs: {},
    ...extra,
  };
}

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: session([turn(0), turn(1, 'assistant')]),
  progress: null,
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: null,
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
  earlier: null,
  reopened: null,
  readOnly: false,
  acts: [],
};

const onConfirmRestart = vi.fn<() => Promise<boolean>>();
const onAnswerRestart = vi.fn();

function renderRail(
  state: Partial<PlanChangeConversationState> = {},
  opts: { withRestart?: boolean; messages?: Record<string, unknown> } = {},
) {
  const merged = { ...BASE, ...state };
  return renderWithIntl(
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      onStop={vi.fn()}
      {...(opts.withRestart === false ? {} : { onConfirmRestart, onAnswerRestart })}
    />,
    opts.messages ? { messages: opts.messages, locale: 'zh' } : {},
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the control (panel 1)', () => {
  it('sits in the rail head of an open session and opens the dialog, writing nothing', () => {
    renderRail();
    const control = screen.getByTestId('planning-restart-control');
    expect(control.textContent).toContain('Plan something new');
    expect(control.getAttribute('aria-haspopup')).toBe('dialog');
    expect((control as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('planning-restart-dialog')).toBeNull();
    fireEvent.click(control);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(onConfirmRestart).not.toHaveBeenCalled();
    expect(onAnswerRestart).not.toHaveBeenCalled();
    expect(screen.queryByTestId('planning-restart-confirm-turn')).toBeNull();
  });

  it('reads the zh catalogue', () => {
    renderRail({}, { messages: zhMessages });
    expect(screen.getByTestId('planning-restart-control').textContent).toContain('规划新内容');
  });
});

describe('where the control is absent or disabled (panel 5)', () => {
  it.each([
    ['no session yet', { session: null }],
    ['a read-only reopen', { readOnly: true }],
    ["somebody else's session", { session: session([turn(0)], { startedByViewer: false }) }],
    ['a guide conversation', { session: session([turn(0)], { origin: 'guide' }) }],
    [
      'an ended session',
      {
        session: session([turn(0)], {
          endedAt: '2026-10-06T11:00:00.000Z',
          endReason: 'restarted',
        }),
      },
    ],
  ] as const)('is absent on %s', (_name, state) => {
    renderRail(state as Partial<PlanChangeConversationState>);
    expect(screen.queryByTestId('planning-restart-control')).toBeNull();
  });

  it('is absent when the host offers no restart', () => {
    renderRail({}, { withRestart: false });
    expect(screen.queryByTestId('planning-restart-control')).toBeNull();
  });

  it('is disabled while a run streams, and names why', () => {
    renderRail({ phase: 'streaming', jobId: 'job-2' });
    const control = screen.getByTestId('planning-restart-control');
    expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('Available when this run finishes')).toBeTruthy();
  });
});

const WAITING = planReview([
  planReviewItem({
    planItemId: 'pi_1',
    nodeId: 'pi_1',
    kind: 'story',
    title: 'Recurring invoices',
  }),
]);

function openDialog() {
  fireEvent.click(screen.getByTestId('planning-restart-control'));
  return screen.getByRole('alertdialog');
}

describe('the dialog (MOTIR-11261)', () => {
  it('asks the question, lands focus on Keep planning, and names no plan when there is none', () => {
    renderRail();
    const dialog = openDialog();
    expect(dialog.textContent).toContain('Start something new?');
    expect(dialog.textContent).toContain(
      'This closes the current planning session and gives its work items back.',
    );
    expect(screen.queryByTestId('planning-restart-dialog-plan')).toBeNull();
    expect(document.activeElement).toBe(within(dialog).getByTestId('planning-restart-keep'));
  });

  it('names a plan being written (panel 3)', () => {
    renderRail({ liveReview: WAITING });
    openDialog();
    const line = screen.getByTestId('planning-restart-dialog-plan');
    expect(line.getAttribute('data-plan')).toBe('writing');
    expect(line.textContent).toContain('Motir AI is writing a plan in this session.');
  });

  it('names a plan waiting for review (panel 3b), and not a decided one', () => {
    renderRail({ review: WAITING });
    openDialog();
    expect(screen.getByTestId('planning-restart-dialog-plan').getAttribute('data-plan')).toBe(
      'waiting',
    );
    cleanup();
    renderRail({ review: WAITING, decided: 'accepted' });
    openDialog();
    expect(screen.queryByTestId('planning-restart-dialog-plan')).toBeNull();
  });

  it('Keep planning closes it, posts nothing, and returns focus to the control', async () => {
    renderRail();
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByTestId('planning-restart-keep'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onConfirmRestart).not.toHaveBeenCalled();
    expect(onAnswerRestart).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId('planning-restart-control'));
  });

  it('Escape is Keep planning too', async () => {
    renderRail();
    const dialog = openDialog();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onConfirmRestart).not.toHaveBeenCalled();
  });

  it('Start something new confirms; the dialog stays while it is in flight, then closes', async () => {
    let resolve!: (ok: boolean) => void;
    onConfirmRestart.mockReturnValueOnce(new Promise<boolean>((r) => (resolve = r)));
    renderRail();
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByTestId('planning-restart-confirm'));
    expect(onConfirmRestart).toHaveBeenCalledTimes(1);
    expect(
      (within(dialog).getByTestId('planning-restart-keep') as HTMLButtonElement).disabled,
    ).toBe(true);
    // Escape is ignored while the restart is in flight, and a second press does nothing.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(within(dialog).getByTestId('planning-restart-confirm'));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(onConfirmRestart).toHaveBeenCalledTimes(1);
    await act(async () => resolve(true));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onAnswerRestart).not.toHaveBeenCalled();
    // Focus goes to the composer, not back to the control.
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
  });

  it('a failed restart keeps the dialog with its error line and Try again (panel 7)', async () => {
    onConfirmRestart.mockResolvedValueOnce(false);
    renderRail();
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByTestId('planning-restart-confirm'));
    const error = await screen.findByTestId('planning-restart-dialog-error');
    expect(error.textContent).toContain('Something new could not be started.');
    const retry = within(dialog).getByTestId('planning-restart-confirm');
    expect(retry.textContent).toContain('Try again');

    // A thrown restart reads the same way; a successful retry closes the dialog.
    onConfirmRestart.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(retry);
    await waitFor(() => expect(onConfirmRestart).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('planning-restart-dialog-error')).toBeTruthy();
    onConfirmRestart.mockResolvedValueOnce(true);
    fireEvent.click(within(dialog).getByTestId('planning-restart-confirm'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('reopening after a failure starts clean', async () => {
    onConfirmRestart.mockResolvedValueOnce(false);
    renderRail();
    let dialog = openDialog();
    fireEvent.click(within(dialog).getByTestId('planning-restart-confirm'));
    await screen.findByTestId('planning-restart-dialog-error');
    fireEvent.click(within(dialog).getByTestId('planning-restart-keep'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    dialog = openDialog();
    expect(screen.queryByTestId('planning-restart-dialog-error')).toBeNull();
    expect(within(dialog).getByTestId('planning-restart-confirm').textContent).toContain(
      'Start something new',
    );
  });

  it('opens over a legacy confirm turn, and Keep planning leaves that turn as it is', async () => {
    renderRail({ session: session([turn(0), CONFIRM]) });
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByTestId('planning-restart-keep'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const confirmTurn = screen.getByTestId('planning-restart-confirm-turn');
    expect(within(confirmTurn).getByTestId('planning-restart-confirm')).toBeTruthy();
    expect(onAnswerRestart).not.toHaveBeenCalled();
  });

  it('reads the zh catalogue', () => {
    renderRail({ review: WAITING }, { messages: zhMessages });
    const dialog = openDialog();
    expect(dialog.textContent).toContain('开始新的规划？');
    expect(dialog.textContent).toContain('等待审阅的计划会保留');
    expect(within(dialog).getByTestId('planning-restart-keep').textContent).toContain('继续规划');
  });
});

describe('a legacy confirm turn (panel 2, before MOTIR-11261)', () => {
  it('renders the catalogue question with Confirm and Keep planning while it is the latest turn', () => {
    renderRail({ session: session([turn(0), turn(1, 'assistant'), CONFIRM]) });
    const confirmTurn = screen.getByTestId('planning-restart-confirm-turn');
    expect(confirmTurn.textContent).toContain(
      'Start something new? This closes the current planning session and gives its work items back.',
    );
    expect(confirmTurn.textContent).not.toContain('stored body');

    fireEvent.click(within(confirmTurn).getByTestId('planning-restart-confirm'));
    expect(onAnswerRestart).toHaveBeenCalledWith('confirm');
    fireEvent.click(within(confirmTurn).getByTestId('planning-restart-keep'));
    expect(onAnswerRestart).toHaveBeenCalledWith('keep');
  });

  it('holds its answers still while one is in flight', () => {
    renderRail({ session: session([turn(0), CONFIRM]), restarting: true });
    expect((screen.getByTestId('planning-restart-confirm') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('planning-restart-keep') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('planning-restart-control') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('a later turn leaves it as a record without its buttons', () => {
    renderRail({ session: session([turn(0), CONFIRM, turn(3)]) });
    expect(screen.getByTestId('planning-restart-confirm-turn')).toBeTruthy();
    expect(screen.queryByTestId('planning-restart-confirm')).toBeNull();
  });

  it('a read-only reader sees the confirm with no answers', () => {
    renderRail({ session: session([turn(0), CONFIRM]), readOnly: true });
    expect(screen.queryByTestId('planning-restart-confirm')).toBeNull();
  });
});

describe('after Keep planning (panel 3)', () => {
  it('the system turn after the confirm reads Kept planning; other markers keep their line', () => {
    renderRail({
      session: session([
        turn(0, 'system', { body: 'intent' }),
        turn(1),
        CONFIRM,
        turn(3, 'system', { body: 'Kept planning.' }),
      ]),
    });
    expect(screen.getByTestId('planning-restart-kept').textContent).toContain('Kept planning');
    expect(screen.getByTestId('plan-change-marker')).toBeTruthy();
    expect(screen.queryByTestId('planning-restart-confirm')).toBeNull();
    // The control is still there for a later change of mind.
    expect(screen.getByTestId('planning-restart-control')).toBeTruthy();
  });
});

describe('the swap (panel 4)', () => {
  it('draws the earlier-session line on the new session, and Open it reopens the ended one', () => {
    renderRail({ session: session([], { id: 's2' }), restartedFrom: 's1' });
    const line = screen.getByTestId('planning-restart-earlier');
    expect(line.textContent).toContain('Your earlier session is closed');
    const link = within(line).getByRole('link', { name: 'Open it' });
    expect(link.getAttribute('href')).toContain('planSession=s1');
    fireEvent.click(link);
    expect(shallowPush).toHaveBeenCalledWith(expect.stringContaining('planSession=s1'));
    expect(
      screen.getByText('Your earlier session is closed. A new session is open.').className,
    ).toContain('sr-only');
  });

  it('draws no earlier-session line without a restart', () => {
    renderRail();
    expect(screen.queryByTestId('planning-restart-earlier')).toBeNull();
  });
});
