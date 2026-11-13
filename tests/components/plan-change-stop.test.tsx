// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanChangeDiffIndex } from '@/lib/planning/planChangeDiff';
import type { PlanningLaunch } from '@/lib/planning/launcher';

// THE STOP (Story MOTIR-4054 · MOTIR-4068) — the control, the interval after the
// click, and the state the run lands in.
//
// What this file is FOR, stated once because it is the whole card: **a stop is a
// DECISION, not a failure.** If stopping reads as throwing work away, people wait
// runs out instead of ending them and the control ships unused — a product
// failure with no error to trace. So the assertions below are mostly about what
// the stopped state does NOT do, which is the only way to check that claim.
//
// The tokens are `design/ai-chat/plan-change-run-live.mock.html` sheet 4's, and
// its "asserted by absence" table is what the third describe block below is.

const EMPTY_INDEX = {
  isEmpty: true,
  counts: { added: 0, changed: 0, removed: 0 },
} as unknown as PlanChangeDiffIndex;

const REVIEWABLE_INDEX = {
  isEmpty: false,
  counts: { added: 3, changed: 1, removed: 0 },
} as unknown as PlanChangeDiffIndex;

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: {
    id: 's1',
    projectId: 'p1',
    turnCount: 1,
    targetKeys: [],
    lastJobId: 'job-1',
    lastSubmittedAt: '2026-09-03T09:00:00.000Z',
    turns: [
      {
        id: 't1',
        seq: 0,
        role: 'user',
        body: 'Add a stop control to the planning run.',
        createdAt: '2026-09-03T09:00:00.000Z',
        jobId: null,
        question: null,
        isAnswer: false,
        intent: 'plan_change',
        intentCorrected: false,
        citations: [],
        authorName: 'Yue',
      },
    ],
    refs: {},
  } as unknown as PlanChangeConversationState['session'],
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

function renderRail(
  state: Partial<PlanChangeConversationState>,
  { onStop, index = EMPTY_INDEX }: { onStop?: () => void; index?: PlanChangeDiffIndex } = {},
) {
  return renderWithIntl(
    <PlanChangeRail
      launch={{ mode: 'project' } as PlanningLaunch}
      projectName="Motir"
      state={{ ...BASE, ...state }}
      index={index}
      targets={[]}
      onAddTarget={() => {}}
      onRemoveTarget={() => {}}
      onSend={() => {}}
      onRetry={() => {}}
      onCorrectTurn={() => {}}
      onApprove={() => {}}
      onDiscard={() => {}}
      {...(onStop ? { onStop } : {})}
    />,
  );
}

let onStop: (() => void) & ReturnType<typeof vi.fn>;

beforeEach(() => {
  cleanup();
  onStop = vi.fn() as (() => void) & ReturnType<typeof vi.fn>;
});

describe('the ENTRANCE — where the stop is, and when', () => {
  it('offers Stop while the run is streaming, in the PINNED footer', () => {
    const { container } = renderRail(
      { phase: 'streaming', progress: { kind: 'reading' } },
      { onStop },
    );

    const bar = screen.getByTestId('plan-change-running-bar');
    expect(within(bar).getByRole('button', { name: 'Stop' })).toBeTruthy();

    // ⚠️ THE PLACEMENT IS THE CRITERION, not decoration. The transcript is the
    // only region that scrolls (`overflow-y-auto`); the composer form is pinned.
    // A Stop inside the transcript passes every other assertion in this file and
    // breaks the one claim the design makes — that the control is reachable at
    // the moment it is wanted, which is when the run is visibly going wrong.
    const scroller = container.querySelector('[role="log"]');
    expect(scroller).toBeTruthy();
    expect(scroller!.contains(bar)).toBe(false);
    expect(bar.closest('form')).toBeTruthy();
  });

  it('offers NO bar when the run is not streaming', () => {
    for (const phase of ['idle', 'review', 'loading', 'deciding'] as const) {
      const { unmount } = renderRail({ phase }, { onStop });
      expect(screen.queryByTestId('plan-change-running-bar')).toBeNull();
      unmount();
    }
  });

  it('offers no bar when the host supplies no `onStop` — the shipped composer, unchanged', () => {
    renderRail({ phase: 'streaming', progress: { kind: 'reading' } });
    expect(screen.queryByTestId('plan-change-running-bar')).toBeNull();
  });

  it('the bar repeats the live narration, so the run is legible from the pinned region', () => {
    renderRail({ phase: 'streaming', progress: { kind: 'proposed', count: 3 } }, { onStop });
    // The reader may be scrolled anywhere in a forty-line run; the current act
    // has to be on screen either way (the design's measured finding: nine act
    // lines fit at the 1366x768 floor).
    expect(screen.getByTestId('plan-change-running-bar').textContent).toContain(
      '3 items proposed so far',
    );
  });

  it('raises the stop once per click', () => {
    renderRail({ phase: 'streaming', progress: { kind: 'reading' } }, { onStop });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('STOPPING — the interval is honest', () => {
  it('says STOPPING, not stopped, and disables the control', () => {
    renderRail(
      { phase: 'streaming', progress: { kind: 'proposed', count: 3 }, stopping: true },
      { onStop },
    );

    const bar = screen.getByTestId('plan-change-running-bar');
    // The click is not the stop: motir-ai acts on the flag when its inbox next
    // reads it — seconds, no longer a phase boundary away (MOTIR-11191). A surface
    // that claims the run is over while it is still narrating is worse than a slow
    // stop, so the bar keeps its spinner and says what is actually happening — and
    // no longer promises to finish the work item it is on, because it does not.
    expect(bar.textContent).toContain('Stopping — work items already written are kept.');
    expect(bar.textContent).not.toContain('finishing this work item');
    expect(bar.textContent).not.toContain('You stopped this run');
    // The spinner is DECORATIVE here (`aria-hidden`), which is correct: the bar's
    // copy carries the state in words, so a screen reader is told what is
    // happening rather than that something is spinning. Asserted structurally
    // for that reason — a role query would (rightly) not find it.
    expect(bar.querySelector('.animate-spin')).toBeTruthy();

    const button = within(bar).getByRole('button', { name: 'Stopping…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not render the terminal marker while stopping', () => {
    renderRail({ phase: 'streaming', stopping: true }, { onStop });
    expect(screen.queryByTestId('plan-change-stopped')).toBeNull();
  });

  it('a second click cannot raise a second stop', () => {
    renderRail({ phase: 'streaming', stopping: true }, { onStop });
    fireEvent.click(screen.getByRole('button', { name: 'Stopping…' }));
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe('STOPPED — a decision, and asserted BY ABSENCE', () => {
  it('renders the marker in the shipped system-marker vocabulary', () => {
    renderRail({ phase: 'idle', stopped: true }, { onStop });
    const marker = screen.getByTestId('plan-change-stopped');
    expect(marker.textContent).toBe('You stopped this run.');
    // The same treatment every other marker on this surface uses — centred,
    // `text-xs`, `--el-text-secondary`. Not a bubble and not a banner.
    expect(marker.className).toContain('text-center');
    expect(marker.className).toContain('text-(--el-text-secondary)');
  });

  it('⚠️ borrows NO error affordance — the card’s load-bearing claim', () => {
    const { container } = renderRail({ phase: 'idle', stopped: true }, { onStop });
    const html = container.innerHTML;

    // Each of these is something the STOPPED state may not use, and each is
    // listed in `design/ai-chat/plan-change-run-live.mock.html` sheet 4 with the
    // reason. Asserting their ABSENCE is the only way to check the claim: a
    // stopped run that renders politely while wearing failure clothing is
    // exactly the defect the criterion exists to catch.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(html).not.toContain('--el-tint-rose');
    expect(html).not.toContain('--el-danger');
    expect(html).not.toContain('--el-destructive');
    expect(html).not.toContain('--el-warning');
    expect(html).not.toContain('lucide-triangle-alert');
    expect(html).not.toContain('lucide-circle-x');
    // …and no Retry, which would frame a deliberate act as something to undo.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('the run’s bar is GONE once it has actually stopped', () => {
    renderRail({ phase: 'idle', stopped: true }, { onStop });
    expect(screen.queryByTestId('plan-change-running-bar')).toBeNull();
  });

  it('⚠️ THE PLAN SURVIVES — Approve and Discard are both reachable from here', () => {
    renderRail(
      {
        phase: 'review',
        stopped: true,
        review: { planId: 'plan-1' } as unknown as PlanChangeConversationState['review'],
      },
      { onStop, index: REVIEWABLE_INDEX },
    );

    // The shipped review block, LIVE, under the stopped marker. This is the
    // strongest available way to say a stopped run's proposals are worth what
    // they were worth a second earlier: it is literally the same block a
    // completed run shows, reused rather than restyled.
    const review = screen.getByTestId('plan-change-review');
    expect(within(review).getByRole('button', { name: /approve/i })).toBeTruthy();
    expect(within(review).getByRole('button', { name: /discard/i })).toBeTruthy();
    expect(review.textContent).toContain('Nothing saved yet');
    expect(screen.getByTestId('plan-change-stopped')).toBeTruthy();
  });

  it('records no failure — a stopped run carries no error line', () => {
    renderRail(
      {
        phase: 'review',
        stopped: true,
        errorCode: null,
        review: { planId: 'plan-1' } as unknown as PlanChangeConversationState['review'],
      },
      { onStop, index: REVIEWABLE_INDEX },
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('THE COMPOSER STAYS LIVE while the run works (MOTIR-4274)', () => {
  it('⚠️ leaves the @ trigger and the input ENABLED while streaming', () => {
    const { container } = renderRail(
      { phase: 'streaming', progress: { kind: 'reading' } },
      { onStop },
    );

    // Asserted on the emitted `disabled` ATTRIBUTES, not on an opacity class,
    // because that is what the shipped component actually sets — `busy` used to
    // put a real `disabled` on all three, so a user could not type at all while
    // a run worked. Making the composer live is a behaviour change, not styling.
    const form = container.querySelector('form')!;
    expect(form.querySelector('textarea')?.hasAttribute('disabled')).toBe(false);
    expect(
      form.querySelector('[data-testid="planning-target-trigger"]')?.hasAttribute('disabled'),
    ).toBe(false);
    // ⚠️ SEND IS NOT ASSERTED HERE, and that is a distinction rather than a gap.
    // It carries `disabled={disabled || draft.trim().length === 0}`, so with an
    // empty draft it is disabled for a reason that has nothing to do with a run —
    // asserting it enabled would be asserting that an empty message can be sent.
    // What this card changed is the FIRST half of that expression, and the input
    // and the trigger above are where that half is observable. The next test
    // covers the pair end to end.
    expect(form.querySelector('button[type="submit"]')).toBeTruthy();
  });

  it('…and Send becomes available as soon as there is something to send', () => {
    const { container } = renderRail(
      { phase: 'streaming', progress: { kind: 'reading' } },
      { onStop },
    );
    // A `<textarea>` since MOTIR-6238 — the composer's field, queried through
    // the form because this suite drives the rail rather than the composer.
    const input = container.querySelector('form textarea') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Also drop the narration card.' } });

    // The end-to-end proof the composer is live mid-run: a user can TYPE and then
    // PRESS, which is exactly the pair the old lock made impossible.
    expect(
      (container.querySelector('form button[type="submit"]') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('still locks the composer while a DECISION is in flight', () => {
    // An approve or a discard is a write against the plan; a turn sent
    // mid-decision would race it. `loading` too — there is no thread yet.
    for (const phase of ['deciding', 'loading'] as const) {
      const { container, unmount } = renderRail({ phase }, { onStop });
      const input = container.querySelector('form textarea');
      expect(input?.hasAttribute('disabled'), phase).toBe(true);
      unmount();
    }
  });
});

describe('A QUEUED turn, and the same turn once the run has READ it (MOTIR-4274)', () => {
  const queued = (read: boolean) => ({
    phase: 'streaming' as const,
    progress: { kind: 'reading' as const },
    queued: [{ id: 'm1', text: 'Also drop the narration card.', read }],
  });

  it('renders the queued turn with the QUEUED label, the clock and the marker', () => {
    renderRail(queued(false), { onStop });

    expect(screen.getByText('Also drop the narration card.')).toBeTruthy();
    const marker = screen.getByTestId('plan-change-queued');
    expect(marker.textContent).toContain('Queued');
    expect(marker.textContent).toContain('finishes the work item it is writing');
  });

  it('⚠️ the READ state changes THREE things, and none of them is colour', () => {
    const { container: pending } = renderRail(queued(false), { onStop });
    const pendingHtml = pending.innerHTML;
    const { container: read } = renderRail(queued(true), { onStop });
    const readHtml = read.innerHTML;

    // 1. the label slot
    expect(pendingHtml).toContain('queued');
    expect(readHtml).toContain('read');
    // 2. the clock glyph
    expect(pendingHtml).toContain('lucide-clock');
    expect(readHtml).not.toContain('lucide-clock');
    // 3. the marker line
    expect(screen.getByTestId('plan-change-queued-read').textContent).toContain(
      'Read at the boundary',
    );
  });

  it('⚠️ does NOT re-tint the bubble — warning is spoken for by the ASKING state', () => {
    // Two warm pending-ish states one scroll apart are less legible than one, so
    // the pending fact is carried by a word, a glyph and a marker instead. The
    // queued bubble is the ordinary user bubble.
    const { container } = renderRail(queued(false), { onStop });
    const bubble = screen.getByText('Also drop the narration card.').closest('div')!;
    expect(bubble.className).toContain('--el-chat-bubble-user');
    expect(container.innerHTML).not.toContain('--el-warning-surface');
  });

  it('shows nothing when nothing is queued — the ordinary run', () => {
    renderRail({ phase: 'streaming', progress: { kind: 'reading' } }, { onStop });
    expect(screen.queryByTestId('plan-change-queued')).toBeNull();
    expect(screen.queryByTestId('plan-change-queued-read')).toBeNull();
  });
});
