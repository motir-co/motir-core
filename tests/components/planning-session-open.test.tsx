// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, screen, waitFor } from '@testing-library/react';
import type { EarlierSessionDto, PlanChangeSessionDto } from '@/lib/dto/planChange';

// MOTIR-6024 — the planning overlay RESUMES a recent session or STARTS FRESH
// (story MOTIR-6011; `agent-authored-plans.md` AMENDMENT 17 §1, §3; design
// `design/ai-chat/planning-workspace--resume.mock.html`, §19.8):
//   · opening creates nothing — the resume read is the only call;
//   · nothing resumable ⇒ an empty rail and, when the scope has one, the
//     earlier conversation for the notice; the FIRST send starts the session;
//   · `planSession=<id>` reopens that exact conversation, read-only for a
//     member without `ai:plan`.
// The transport is mocked; the hook's state machine and the rail's rendering
// are what is under test.

const {
  resume,
  getNamed,
  resumeAnchored,
  submitAnchored,
  submitAsk,
  settleAsk,
  streamAsk,
  streamAnchored,
  fetchReview,
} = vi.hoisted(() => ({
  resume: vi.fn(),
  getNamed: vi.fn(),
  resumeAnchored: vi.fn(),
  submitAnchored: vi.fn(),
  submitAsk: vi.fn(),
  settleAsk: vi.fn(),
  streamAsk: vi.fn(),
  streamAnchored: vi.fn(),
  fetchReview: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  findResumableSession: resume,
  getPlanChangeSession: getNamed,
  resumeContextualSession: resumeAnchored,
  submitContextualPlan: submitAnchored,
  submitAskTurn: submitAsk,
  settleAskJob: settleAsk,
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return { ...actual, streamAskJob: streamAsk, streamContextualPlanJob: streamAnchored };
});

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return { ...actual, fetchPlanReview: fetchReview };
});

import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import {
  OVERLAY_PARAM_NAMES,
  parsePlanningLaunch,
  parsePlanningOverlay,
  withPlanningOverlay,
} from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { planReview, planReviewItem } from '../helpers/planReview';
import { narrationEntry, narrationRead, narrationSession } from '../helpers/planNarration';

function session(
  bodies: string[],
  extra: Partial<PlanChangeSessionDto> = {},
): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: bodies.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-09-20T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-09-20T09:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    turns: bodies.map((body, seq) => ({
      id: `t${seq}`,
      seq,
      role: 'user' as const,
      body,
      jobId: null,
      question: null,
      isAnswer: false,
      intent: null,
      intentCorrected: false,
      citations: [],
      authorId: 'u1',
      createdAt: '2026-09-20T10:00:00.000Z',
    })),
    workItemRefs: {},
    ...extra,
  };
}

const EARLIER: EarlierSessionDto = {
  id: 's0',
  targetKeys: ['MOTIR-812'],
  lastActivityAt: '2026-09-19T10:00:00.000Z',
  startedBy: { id: 'u1', name: 'Mara Lind' },
  mine: true,
};

/** A stream that settles straight away. */
async function* settled() {
  yield { type: 'job.completed', status: 'succeeded' } as never;
}

beforeEach(() => {
  for (const fn of [
    resume,
    getNamed,
    resumeAnchored,
    submitAnchored,
    submitAsk,
    settleAsk,
    streamAsk,
    streamAnchored,
    fetchReview,
  ]) {
    fn.mockReset();
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('opening the overlay — the hook', () => {
  it('RESUMES the caller’s recent conversation, turns included — and the resume read is the only call', async () => {
    resume.mockResolvedValue({ session: session(['split billing']), earlier: null });
    const { result } = renderHook(() => usePlanChangeConversation());

    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.session?.turns.map((t) => t.body)).toEqual(['split billing']);
    expect(result.current.state.earlier).toBeNull();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(submitAsk).not.toHaveBeenCalled();
  });

  it('opens EMPTY past the window, carrying the earlier conversation — and creates nothing until a send', async () => {
    resume.mockResolvedValue({ session: null, earlier: EARLIER });
    const { result, unmount } = renderHook(() => usePlanChangeConversation());

    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.session).toBeNull();
    expect(result.current.state.earlier).toEqual(EARLIER);
    // Opening and closing without a message writes nothing: no start, no turn.
    unmount();
    expect(submitAsk).not.toHaveBeenCalled();
    expect(getNamed).not.toHaveBeenCalled();
  });

  it('the FIRST send starts the session (no id) and adopts it; the next send names it', async () => {
    resume.mockResolvedValue({ session: null, earlier: null });
    const started = session(['add payments']);
    submitAsk.mockResolvedValue({ jobId: 'ask-1', turnId: 't0', session: started });
    streamAsk.mockImplementation(settled);
    settleAsk.mockResolvedValue({ outcome: 'silent', session: started });
    const { result } = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));

    await act(async () => {
      await result.current.send('add payments');
    });
    // The trailing `null, null` are the optional seed gate and anchor (MOTIR-7050)
    // — absent here, and `submitAskTurn` leaves both off the wire. The last two are
    // the answer option and the composer's Grill me switch (MOTIR-11801), off here.
    expect(submitAsk).toHaveBeenLastCalledWith(
      'add payments',
      expect.anything(),
      false,
      null,
      null,
      null,
      null,
      false,
    );
    await waitFor(() => expect(result.current.state.session?.id).toBe('s1'));

    await act(async () => {
      await result.current.send('smaller');
    });
    expect(submitAsk).toHaveBeenLastCalledWith(
      'smaller',
      expect.anything(),
      false,
      's1',
      null,
      null,
      null,
      false,
    );
  });

  it('an ANCHORED open past the window carries the earlier conversation too', async () => {
    resumeAnchored.mockResolvedValue({ session: null, planId: null, earlier: EARLIER });
    const { result } = renderHook(() => usePlanChangeConversation({ anchorId: 'wi_812' }));

    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.earlier).toEqual(EARLIER);
    expect(resume).not.toHaveBeenCalled();
  });

  it('`planSession` REOPENS that conversation by id — whatever its age — with who started it', async () => {
    getNamed.mockResolvedValue(
      session(['old question'], {
        id: 's9',
        startedBy: { id: 'u2', name: 'Jon Ruiz' },
        startedByViewer: false,
        viewerCanPlan: true,
        pendingPlanId: null,
        lastActivityAt: '2026-08-01T10:00:00.000Z',
      }),
    );
    const { result } = renderHook(() => usePlanChangeConversation({ sessionId: 's9' }));

    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(getNamed).toHaveBeenCalledWith('s9', expect.anything());
    expect(resume).not.toHaveBeenCalled();
    expect(result.current.state.session?.id).toBe('s9');
    expect(result.current.state.reopened).toEqual({
      startedBy: { id: 'u2', name: 'Jon Ruiz' },
      mine: false,
      lastActivityAt: '2026-08-01T10:00:00.000Z',
    });
    expect(result.current.state.readOnly).toBe(false);
  });

  it('reopens READ-ONLY for a member without `ai:plan`, and brings back its pending plan', async () => {
    getNamed.mockResolvedValue(
      session(['q'], {
        id: 's9',
        startedBy: null,
        startedByViewer: false,
        viewerCanPlan: false,
        pendingPlanId: 'plan_7',
      }),
    );
    fetchReview.mockResolvedValue(null);
    const { result } = renderHook(() => usePlanChangeConversation({ sessionId: 's9' }));

    await waitFor(() => expect(result.current.state.readOnly).toBe(true));
    expect(result.current.state.planId).toBe('plan_7');
  });

  // MOTIR-6289 — the surface draws the roadmap canvas whenever `review` is null, so a
  // named session that still has its pending plan to read must NOT read as opened
  // (`idle`) in between: that interval is what flashed the roadmap before the plan.
  it('a named session with a PENDING plan stays `loading` until that plan is read, then opens on it', async () => {
    getNamed.mockResolvedValue(
      session(['q'], { id: 's9', viewerCanPlan: true, pendingPlanId: 'plan_7' }),
    );
    let releaseReview!: (review: unknown) => void;
    fetchReview.mockReturnValue(new Promise((resolve) => (releaseReview = resolve)));
    const { result } = renderHook(() => usePlanChangeConversation({ sessionId: 's9' }));

    await waitFor(() => expect(fetchReview).toHaveBeenCalledWith('plan_7', expect.anything()));
    // The session is in hand; the plan is not — and nothing says "opened" yet.
    expect(result.current.state.session?.id).toBe('s9');
    expect(result.current.state.planId).toBe('plan_7');
    expect(result.current.state.phase).toBe('loading');
    expect(result.current.state.review).toBeNull();

    const pending = planReview([planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1' })]);
    await act(async () => releaseReview(pending));
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toBe(pending);
  });

  it('a named session whose plan is NOT pending, or cannot be read, still settles `idle`', async () => {
    getNamed.mockResolvedValue(session(['q'], { id: 's9', pendingPlanId: 'plan_7' }));
    // Decided since the row was drawn: the read answers, and it is not a proposal.
    fetchReview.mockResolvedValue(
      planReview([planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1' })], {
        status: 'approved',
      }),
    );
    const decided = renderHook(() => usePlanChangeConversation({ sessionId: 's9' }));
    await waitFor(() => expect(decided.result.current.state.phase).toBe('idle'));
    expect(decided.result.current.state.review).toBeNull();
    decided.unmount();

    fetchReview.mockReset().mockRejectedValue(new Error('500'));
    const failed = renderHook(() => usePlanChangeConversation({ sessionId: 's9' }));
    await waitFor(() => expect(failed.result.current.state.phase).toBe('idle'));
    expect(failed.result.current.state.review).toBeNull();
    expect(failed.result.current.state.errorCode).toBeNull();
  });

  it('an open torn down while the pending plan is read writes nothing — abort, late answer, late failure', async () => {
    getNamed.mockResolvedValue(session(['q'], { id: 's9', pendingPlanId: 'plan_7' }));

    // The unmount's abort reaches the read: that answer belongs to nobody.
    fetchReview.mockImplementation(
      (_id: string, signal: AbortSignal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        ),
    );
    const aborted = renderHook(() => usePlanChangeConversation({ sessionId: 's9' }));
    await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(1));
    aborted.unmount();
    expect(aborted.result.current.state.phase).toBe('loading');

    // An answer, or a failure, that lands after the surface closed is dropped.
    for (const settle of ['resolve', 'reject'] as const) {
      let release!: { resolve: (v: unknown) => void; reject: (e: unknown) => void };
      fetchReview
        .mockReset()
        .mockReturnValue(new Promise((resolve, reject) => (release = { resolve, reject })));
      const late = renderHook(() => usePlanChangeConversation({ sessionId: 's9' }));
      await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(1));
      late.unmount();
      await act(async () => {
        if (settle === 'resolve') release.resolve(planReview([planReviewItem()]));
        else release.reject(new Error('500'));
      });
      expect(late.result.current.state.phase).toBe('loading');
      expect(late.result.current.state.review).toBeNull();
    }
  });

  it('an id that resolves to nothing lands on the shipped SESSION_UNAVAILABLE path', async () => {
    getNamed.mockRejectedValue(new Error('404'));
    const { result } = renderHook(() => usePlanChangeConversation({ sessionId: 'gone' }));

    await waitFor(() => expect(result.current.state.errorCode).toBe('SESSION_UNAVAILABLE'));
  });
});

// ─── The rail ──────────────────────────────────────────────────────────────

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: null,
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
  acts: [],
  earlier: null,
  reopened: null,
  readOnly: false,
};

function renderRail(state: Partial<PlanChangeConversationState>) {
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
    />,
  );
}

describe('the rail — which conversation this is', () => {
  it('a FRESH start points to your earlier conversation about an anchor, on the Plans page', () => {
    renderRail({ earlier: EARLIER });
    const notice = screen.getByTestId('planning-earlier-session');
    expect(notice.textContent).toBe(
      'Your earlier conversation about MOTIR-812 is on the Plans page.',
    );
    expect(notice.querySelector('a')?.getAttribute('href')).toBe('/plans?session=s0');
  });

  it('names the anchor set as "{first} and {count} more", the project when project-wide, and someone else’s by name', () => {
    renderRail({ earlier: { ...EARLIER, targetKeys: ['MOTIR-812', 'MOTIR-9', 'MOTIR-4'] } });
    expect(screen.getByTestId('planning-earlier-session').textContent).toBe(
      'Your earlier conversation about MOTIR-812 and 2 more is on the Plans page.',
    );
    cleanup();

    renderRail({ earlier: { ...EARLIER, targetKeys: [] } });
    expect(screen.getByTestId('planning-earlier-session').textContent).toBe(
      'Your earlier conversation about PayFlow is on the Plans page.',
    );
    cleanup();

    renderRail({ earlier: { ...EARLIER, mine: false, startedBy: { id: 'u2', name: 'Jon Ruiz' } } });
    expect(screen.getByTestId('planning-earlier-session').textContent).toBe(
      'An earlier conversation about MOTIR-812, started by Jon Ruiz, is on the Plans page.',
    );
  });

  it('the notice goes once this conversation exists', () => {
    renderRail({ earlier: EARLIER, session: session(['new']) });
    expect(screen.queryByTestId('planning-earlier-session')).toBeNull();
  });

  it('a REOPENED conversation says where it came from — yours, or someone else’s', () => {
    renderRail({
      session: session(['q']),
      reopened: {
        startedBy: { id: 'u1', name: 'Mara' },
        mine: true,
        lastActivityAt: new Date().toISOString(),
      },
    });
    expect(screen.getByTestId('planning-reopened-session').textContent).toMatch(
      /^Reopened from the Plans page · started by you · last active /,
    );
    cleanup();

    renderRail({
      session: session(['q']),
      reopened: {
        startedBy: { id: 'u2', name: 'Jon Ruiz' },
        mine: false,
        lastActivityAt: new Date().toISOString(),
      },
    });
    expect(screen.getByTestId('planning-reopened-session').textContent).toMatch(
      /^Reopened from the Plans page · started by Jon Ruiz · last active /,
    );
  });

  it('READ-ONLY replaces the composer with the reason', () => {
    renderRail({
      session: session(['q']),
      reopened: { startedBy: null, mine: false, lastActivityAt: new Date().toISOString() },
      readOnly: true,
    });
    expect(screen.getByTestId('planning-read-only').textContent).toBe(
      'You can read this conversation. Continuing it needs permission to plan with Motir AI.',
    );
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('READ-ONLY still shows the planner’s narration, with its collapse-all control (MOTIR-8064)', () => {
    const lay = narrationSession('s-lay', 'lay', 'Session handling');
    renderRail({
      session: session(['q']),
      reopened: { startedBy: null, mine: false, lastActivityAt: new Date().toISOString() },
      readOnly: true,
      narration: narrationRead([lay], [narrationEntry(1, 's-lay', 'Laying out the work.')]),
      narrationKept: { planId: 'plan_1', live: [], earlier: [], loadingEarlier: false },
    });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('plan-narration-message').textContent).toBe('Laying out the work.');
    expect(screen.getByTestId('plan-narration-head-line').textContent).toContain(
      'Laying out Session handling',
    );
    expect(screen.getByTestId('plan-narration-toggle-all')).toBeTruthy();
  });
});

describe('the ADDRESS carries `planSession`', () => {
  it('round-trips for a work-item and a project launch, and is ignored elsewhere', () => {
    expect(OVERLAY_PARAM_NAMES.session).toBe('planSession');
    const href = withPlanningOverlay('/plans?planState=none', {
      kind: 'work-item',
      itemKey: 'MOTIR-812',
      sessionId: 's9',
    });
    expect(href).toContain('planSession=s9');
    expect(href).toContain('planState=none');
    expect(parsePlanningOverlay(new URLSearchParams(href.split('?')[1]))?.sessionId).toBe('s9');

    const project = withPlanningOverlay('/plans', { kind: 'project', sessionId: 's8' });
    expect(parsePlanningOverlay(new URLSearchParams(project.split('?')[1]))?.sessionId).toBe('s8');

    expect(
      parsePlanningOverlay(new URLSearchParams('plan=roadmap&planFrom=roadmap&planSession=s1'))
        ?.sessionId,
    ).toBeUndefined();
  });
});
