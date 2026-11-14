// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { skipCheckGroupKey } from '@/components/planning/PlanNarration';
import type { NarrationGroup } from '@/components/planning/planNarration';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import en from '@/messages/en.json';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { PlanNarrationReadDto, PlanStepKindDto } from '@/lib/dto/plans';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import { narrationEntry, narrationRead, narrationSession } from '../helpers/planNarration';

// SKIP THE FINAL CHECK — the control under the live final-check head and its
// confirm (Story MOTIR-11262 · MOTIR-11266), built to `design/ai-chat/design-notes.md`
// § "⭐ The final check" §2, §3 and §5 and `planning-workspace--skip-final-check.mock.html`.
// Driven through the shipped `PlanChangeRail`, which is where the control rides.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
const SK = en.planningWorkspace.skipFinalCheck;
const NARR = en.planningWorkspace.conversation.narration;

const SESSION: PlanChangeSessionDto = {
  id: 's1',
  projectId: 'p1',
  targetKeys: [],
  turnCount: 0,
  lastJobId: null,
  lastSubmittedAt: null,
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  origin: 'conversation',
  createdAt: '2026-07-27T09:00:00.000Z',
  updatedAt: '2026-07-27T10:00:00.000Z',
  turns: [],
  workItemRefs: {},
};

const BASE: PlanChangeConversationState = {
  phase: 'streaming',
  session: SESSION,
  progress: null,
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: 'job-1',
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

const LAY = narrationSession('s-lay', 'lay', 'Session handling');
const CHECK = narrationSession('s-check', 'check', null);
const CHECK_CARD = narrationSession('s-check-card', 'check', 'Move token refresh');
const REPAIR = narrationSession('s-repair', 'repair', null);

const READ = narrationRead(
  [LAY, CHECK, CHECK_CARD, REPAIR],
  [
    narrationEntry(1, 's-lay', 'Laying out the work.'),
    narrationEntry(2, 's-check', 'Reading the plan in build order.'),
  ],
);

function stateWith(live: string[], extra: Partial<PlanChangeConversationState> = {}) {
  const narration: PlanNarrationReadDto = READ;
  return {
    ...BASE,
    narration,
    narrationKept: { planId: 'plan_1', live, earlier: [], loadingEarlier: false },
    ...extra,
  } as PlanChangeConversationState;
}

function renderRail(
  state: PlanChangeConversationState,
  onSkipFinalCheck?: () => Promise<'skipped' | 'not_running'>,
) {
  const rail = (s: PlanChangeConversationState) => (
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={s}
      index={indexPlanReview(s.review)}
      targets={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      onStop={vi.fn()}
      {...(onSkipFinalCheck ? { onSkipFinalCheck } : {})}
    />
  );
  const view = renderWithIntl(rail(state), { locale: 'en', messages: en });
  return {
    ...view,
    update: (next: PlanChangeConversationState) =>
      view.rerender(rail(next) as unknown as React.ReactElement),
  };
}

const control = () => screen.queryByTestId('plan-narration-skip-check-control');
const groupOf = (key: string) =>
  screen
    .getAllByTestId('plan-narration-group')
    .find((g) => g.getAttribute('data-session-key') === key) as HTMLElement;

afterEach(cleanup);

describe('where the control shows', () => {
  it('under the LIVE final-check head, between the head and its notes', () => {
    renderRail(stateWith(['s-check']), vi.fn());
    const row = within(groupOf('s-check')).getByTestId('plan-narration-skip-check');
    expect(control()?.textContent).toContain(NARR.skipCheck);
    expect(row.nextElementSibling?.getAttribute('data-testid')).toBe('plan-narration-messages');
    expect(screen.getAllByTestId('plan-narration-skip-check')).toHaveLength(1);
  });

  it.each<[string, string[]]>([
    ['before the check (a lay is live)', ['s-lay']],
    ['while the fix after it runs', ['s-check', 's-repair']],
    ['once nothing is live', []],
  ])('not %s', (_n, live) => {
    renderRail(stateWith(live), vi.fn());
    expect(control()).toBeNull();
  });

  it('not to a viewer without `ai:plan` (no skip handler), nor on a finished run', () => {
    renderRail(stateWith(['s-check']));
    expect(control()).toBeNull();
    cleanup();
    renderRail(stateWith(['s-check'], { phase: 'idle' }), vi.fn());
    expect(control()).toBeNull();
  });
});

describe('the confirm', () => {
  it('opens on Keep checking, and Keep checking changes nothing', async () => {
    const skip = vi.fn();
    renderRail(stateWith(['s-check']), skip);
    fireEvent.click(control()!);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(SK.title)).toBeTruthy();
    expect(within(dialog).getByText(SK.body)).toBeTruthy();
    expect(screen.getByTestId('planning-skip-check-dialog-consequence')?.textContent).toContain(
      SK.consequence,
    );
    // The consequence line is part of the description.
    const lineId = screen.getByTestId('planning-skip-check-dialog-consequence').id;
    expect(dialog.getAttribute('aria-describedby')).toContain(lineId);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('planning-skip-check-keep')),
    );

    fireEvent.click(screen.getByTestId('planning-skip-check-keep'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(skip).not.toHaveBeenCalled();
    expect(control()).not.toBeNull();
  });

  it('Escape closes it and changes nothing', async () => {
    const skip = vi.fn();
    renderRail(stateWith(['s-check']), skip);
    fireEvent.click(control()!);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(skip).not.toHaveBeenCalled();
  });

  it('Confirm sends one skip, shows it in flight, then the pending row until the check ends', async () => {
    let resolve!: (v: 'skipped') => void;
    const skip = vi.fn(() => new Promise<'skipped'>((r) => (resolve = r)));
    const view = renderRail(stateWith(['s-check']), skip);
    fireEvent.click(control()!);
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByTestId('planning-skip-check-confirm'));
    fireEvent.click(screen.getByTestId('planning-skip-check-confirm'));
    expect(skip).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('planning-skip-check-dialog')?.getAttribute('aria-busy')).toBe(
      'true',
    );
    expect((screen.getByTestId('planning-skip-check-keep') as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Escape is ignored while the request is out.
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    await act(async () => resolve('skipped'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const pending = screen.getByTestId('plan-narration-skip-check-pending');
    expect(pending?.textContent).toContain(NARR.skippingCheck);
    expect(pending?.getAttribute('role')).toBe('status');
    expect(control()).toBeNull();

    // The check's head is no longer live: the row is gone, and a later check
    // starts with the control again.
    view.update(stateWith([]));
    expect(screen.queryByTestId('plan-narration-skip-check')).toBeNull();
    view.update(stateWith(['s-check-card']));
    expect(control()).not.toBeNull();
  });

  it('a failure keeps the dialog with the error line and Try again sends again', async () => {
    const skip = vi
      .fn<() => Promise<'skipped' | 'not_running'>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce('skipped');
    renderRail(stateWith(['s-check']), skip);
    fireEvent.click(control()!);
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByTestId('planning-skip-check-confirm'));
    const error = await screen.findByTestId('planning-skip-check-dialog-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain(SK.error);
    expect(screen.getByTestId('planning-skip-check-confirm')?.textContent).toContain(SK.retry);

    fireEvent.click(screen.getByTestId('planning-skip-check-confirm'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(skip).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('plan-narration-skip-check-pending')).toBeTruthy();
  });

  it('a check that had already finished says so, with one Close that changes nothing', async () => {
    const skip = vi.fn(async () => 'not_running' as const);
    renderRail(stateWith(['s-check']), skip);
    fireEvent.click(control()!);
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByTestId('planning-skip-check-confirm'));
    const finished = await screen.findByTestId('planning-skip-check-dialog-finished');
    expect(finished?.textContent).toContain(SK.finished);
    expect(finished?.getAttribute('role')).toBe('status');
    expect(screen.queryByTestId('planning-skip-check-dialog-consequence')).toBeNull();
    expect(screen.queryByTestId('planning-skip-check-keep')).toBeNull();
    fireEvent.click(screen.getByTestId('planning-skip-check-close'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByTestId('plan-narration-skip-check-pending')).toBeNull();
  });
});

describe('skipCheckGroupKey', () => {
  const g = (sessionKey: string, kind: PlanStepKindDto | null, live: boolean): NarrationGroup => ({
    sessionKey,
    session: kind ? narrationSession(sessionKey, kind) : null,
    messages: [],
    live,
  });

  it('is the first live check group, and null while a fix is live or no check is', () => {
    expect(skipCheckGroupKey([g('a', 'check', false), g('b', 'check', true)])).toBe('b');
    expect(skipCheckGroupKey([g('a', 'check', true), g('r', 'repair', true)])).toBeNull();
    expect(skipCheckGroupKey([g('h', null, true), g('l', 'lay', true)])).toBeNull();
    expect(skipCheckGroupKey([])).toBeNull();
  });
});
