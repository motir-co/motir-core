// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// The conversation LOOP (Subtask MOTIR-1730, re-pointed at the PLAN by
// MOTIR-1746): open/resume → append a turn → submit the ACCUMULATED intent →
// stream → read the run's PROPOSALS from its Plan → approve (materialize) or
// discard (decline). The session seam (MOTIR-1728), the job stream and the plans
// API are mocked, so what is under test is the state machine the rail and the
// canvas both read.

const {
  open,
  append,
  submit,
  stream,
  fetchReview,
  approve,
  decline,
  resumeAnchored,
  submitAnchored,
  resubmitAnchored,
  streamAnchored,
  submitAsk,
  rerunAsk,
  settleAsk,
  streamAsk,
  getNamed,
  readPendingSpy,
} = vi.hoisted(() => ({
  open: vi.fn(),
  append: vi.fn(),
  submit: vi.fn(),
  stream: vi.fn(),
  fetchReview: vi.fn(),
  approve: vi.fn(),
  decline: vi.fn(),
  resumeAnchored: vi.fn(),
  submitAnchored: vi.fn(),
  resubmitAnchored: vi.fn(),
  streamAnchored: vi.fn(),
  submitAsk: vi.fn(),
  rerunAsk: vi.fn(),
  settleAsk: vi.fn(),
  streamAsk: vi.fn(),
  getNamed: vi.fn(),
  readPendingSpy: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  // The resume read answers `{ session, earlier }` (MOTIR-6024); these cases
  // mock the SESSION, so the factory wraps it.
  findResumableSession: async (...a: unknown[]) => ({
    session: await (open as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  appendPlanChangeTurn: append,
  submitPlanChange: submit,
  resumeContextualSession: resumeAnchored,
  submitContextualPlan: submitAnchored,
  resubmitContextualPlan: resubmitAnchored,
  submitAskTurn: submitAsk,
  rerunAskTurn: rerunAsk,
  settleAskJob: settleAsk,
  // A NAMED session (`planSession=`, MOTIR-6024) — the MCP-session live case.
  getPlanChangeSession: getNamed,
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return {
    ...actual,
    streamAugmentJob: stream,
    streamContextualPlanJob: streamAnchored,
    streamAskJob: streamAsk,
  };
});

// The PLANS API — the same client the `/plans/[id]` island calls. Reviewing and
// confirming both go through it now; there is no second write path to mock.
vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    fetchPlanReview: fetchReview,
    approvePlanRequest: approve,
    declinePlanRequest: decline,
  };
});

// The proposed-review read, SPIED and otherwise real: the live-review cases
// (MOTIR-6295) count how often the hand-over reaches for it.
vi.mock('@/lib/planning/planReview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReview')>();
  readPendingSpy.mockImplementation(actual.readPendingProposal);
  return { ...actual, readPendingProposal: readPendingSpy };
});

import { usePlanChangeConversation, narrateFrame } from '@/lib/hooks/usePlanChangeConversation';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { PlanRequestError } from '@/lib/planning/planReviewClient';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanWithItemsDto } from '@/lib/dto/plans';

function session(bodies: string[], targetKeys: string[] = []): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys,
    turnCount: bodies.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
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
      createdAt: '2026-07-27T10:00:00.000Z',
    })),
    workItemRefs: {},
  };
}

/** What the run PROPOSED, as its Plan reads back. */
const REVIEW = planReview([
  planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'Recurring' }),
]);

/** What `materialize` returns — the same plan, now `approved`, its `add` bound to
 *  the work item it created. */
const MATERIALIZED: PlanWithItemsDto = {
  id: 'plan-1',
  projectId: 'proj_1',
  status: 'approved',
  title: null,
  summary: null,
  sourceJobId: 'job-1',
  sessionId: null,
  // A rail-driven run is `user`-origin; the auto-plan watcher's is `cadence`
  // (MOTIR-916) — same Plan, same review, same confirm, per this card's
  // invariant that the trigger is irrelevant.
  origin: 'user',
  // WHO ASKED (MOTIR-2986) — a rail-driven run is a request path, so the acting
  // user is the requester.
  createdById: 'u1',
  // WHO WROTE it — null on a plan Motir's own planner produced; only the
  // `create_plan` MCP tool writes the triple.
  authorSource: null,
  authorHarness: null,
  authorModel: null,
  itemCount: 1,
  createdAt: '2026-07-27T09:00:00.000Z',
  plannedAt: '2026-07-27T09:01:00.000Z',
  decidedAt: '2026-07-27T09:05:00.000Z',
  decidedById: 'u1',
  decisionReason: null,
  sharpenedRequirement: null,
  items: [
    {
      id: 'pi_1',
      op: 'add',
      workItemId: 'wi_new',
      proposedFields: { title: 'Recurring' },
      patch: null,
      parentRef: null,
      blockedByRefs: [],
      edgeReasons: {},
      supersedesRefs: [],
      baseRevision: null,
      reason: null,
      createdAt: '2026-07-27T09:01:00.000Z',
    },
  ],
};

/** A stream that immediately reports success, optionally emitting progress frames. */
function okStream(frames: Array<[string, unknown]> = []) {
  return vi.fn(
    async (
      _jobId: string,
      _signal: AbortSignal,
      _onError: (code: string | null) => void,
      _onDone: () => void,
      onFrame?: (event: string, data: unknown) => void,
    ) => {
      for (const [event, data] of frames) onFrame?.(event, data);
    },
  );
}

beforeEach(() => {
  open.mockResolvedValue(session([]));
  append.mockImplementation(async (body: string) => session([body]));
  submit.mockResolvedValue({
    jobId: 'job-1',
    planId: 'plan-1',
    session: session(['Add recurring invoices.']),
  });
  stream.mockImplementation(okStream());
  // ── the ASK door (MOTIR-1343), which is now the project thread's ONLY
  // entrance. The default settle REDIRECTS, because these suites are about the
  // plan-change flow and a redirect hands off to exactly the tail they assert —
  // so "what a plan-change turn does" is unchanged by the new door, which is the
  // property worth holding.
  submitAsk.mockImplementation(async (body: string) => ({
    jobId: 'ask-1',
    turnId: 't0',
    session: session([body]),
  }));
  rerunAsk.mockImplementation(async () => ({
    jobId: 'ask-2',
    turnId: 't0',
    session: session(['Add recurring invoices.']),
  }));
  settleAsk.mockResolvedValue({
    outcome: 'redirected',
    jobId: 'job-1',
    planId: 'plan-1',
    session: session(['Add recurring invoices.']),
  });
  streamAsk.mockImplementation(okStream());
  fetchReview.mockResolvedValue(REVIEW);
  approve.mockResolvedValue(MATERIALIZED);
  decline.mockResolvedValue({ ...MATERIALIZED, status: 'declined', items: [] });
  resumeAnchored.mockResolvedValue({ session: null, planId: null });
  submitAnchored.mockResolvedValue({
    jobId: 'job-anchored-1',
    planId: 'plan-anchored-1',
    sessionId: 's1',
    session: session(['Split this story.']),
  });
  resubmitAnchored.mockResolvedValue({
    jobId: 'job-anchored-2',
    planId: 'plan-anchored-2',
    sessionId: 's1',
    session: session(['Split this story.']),
  });
  streamAnchored.mockImplementation(
    async (
      _anchorId: string,
      _jobId: string,
      _signal: AbortSignal,
      _onError: (code: string | null) => void,
      _onDone: () => void,
      onFrame?: (event: string, data: unknown) => void,
    ) => {
      void onFrame;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mounted(onApproved?: (r: unknown) => void) {
  const hook = renderHook(() =>
    usePlanChangeConversation(onApproved ? { onApproved: onApproved as never } : {}),
  );
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

describe('usePlanChangeConversation — resume', () => {
  it('opens (or RESUMES) the project thread on mount', async () => {
    open.mockResolvedValue(session(['Add recurring invoices.', 'Split it in two.']));
    const { result } = await mounted();

    expect(open).toHaveBeenCalledTimes(1);
    expect(result.current.state.session?.turns).toHaveLength(2);
  });

  it('degrades to a recoverable error when the thread cannot be read', async () => {
    open.mockRejectedValue(new PlanEditsClientError(500, null));
    const { result } = await mounted();

    expect(result.current.state.errorCode).toBe('SESSION_UNAVAILABLE');
  });
});

describe('usePlanChangeConversation — a TARGETED turn (MOTIR-1491)', () => {
  const TARGETS = [
    { id: 'w-812', identifier: 'MOTIR-812', title: 'Billing', kind: 'story' as const },
    { id: 'w-918', identifier: 'MOTIR-918', title: 'Migrate', kind: 'subtask' as const },
  ];

  it('routes the turn to the CONTEXTUAL endpoint — primary as the anchor, the rest as targetKeys', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Expand billing.', TARGETS);
    });

    expect(submitAnchored).toHaveBeenCalledWith(
      'w-812',
      'Expand billing.',
      ['MOTIR-918'],
      expect.anything(),
      // MOTIR-2226: no question is pending, so the turn is not a reply.
      false,
      // The conversation the rail holds (MOTIR-6023).
      's1',
    );
    // One call does open-or-resume + append + submit, so neither project-thread
    // hop fires — a targeted turn must not land in the project conversation.
    expect(append).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('adopts the SCOPED thread that comes back, so the rail shows what it is anchored at', async () => {
    submitAnchored.mockResolvedValue({
      jobId: 'job-ctx',
      planId: 'plan-ctx',
      sessionId: 's-ctx',
      session: session(['Expand billing.'], ['MOTIR-812', 'MOTIR-918']),
    });
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Expand billing.', TARGETS);
    });

    expect(result.current.state.session?.targetKeys).toEqual(['MOTIR-812', 'MOTIR-918']);
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
  });

  it('streams the contextual job through ITS route — the anchor is re-gated on subscribe', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Expand billing.', TARGETS);
    });

    expect(streamAnchored).toHaveBeenCalledWith(
      'w-812',
      'job-anchored-1',
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(stream).not.toHaveBeenCalled();
  });

  it('a retry RESUBMITS to the same anchor set — never re-aimed, never duplicated', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Expand billing.', TARGETS);
    });
    submitAnchored.mockClear();

    await act(async () => {
      await result.current.retry();
    });

    // The accumulated intent goes out again with NO new turn appended (MOTIR-910's
    // resubmit), addressed to the set the failed turn actually landed in.
    expect(resubmitAnchored).toHaveBeenCalledWith('w-812', ['MOTIR-918'], expect.anything(), 's1');
    expect(submitAnchored).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('an EMPTY target set is the ordinary project turn — the picker is additive', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.', []);
    });

    expect(submitAnchored).not.toHaveBeenCalled();
    // The project turn now goes through the ONE DOOR, which appends and submits
    // server-side; the client's own append is gone with the second entrance.
    expect(submitAsk).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
  });
});

describe('usePlanChangeConversation — a turn', () => {
  it('sends the turn through the ONE DOOR, and a redirect reaches the shipped review', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    // ONE door and no intent on the wire (MOTIR-1343 · ADR §1): the client posts
    // the text and the `isAnswer` affordance flag, and nothing else — the
    // optional seed gate and anchor (MOTIR-7050) are absent, so neither rides.
    expect(submitAsk).toHaveBeenCalledWith(
      'Add recurring invoices.',
      expect.anything(),
      false,
      's1',
      null,
      null,
    );
    expect(append).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    // …and when the door says the turn was a plan change, the run lands in
    // EXACTLY the shipped review — same job, same proposals, same phase.
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
    expect(result.current.state.jobId).toBe('job-1');
    expect(result.current.state.planId).toBe('plan-1');
  });

  it('ignores an empty turn — nothing is appended and nothing is submitted', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('   ');
    });

    expect(submitAsk).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('narrates the run from the job’s REAL progress frames', async () => {
    stream.mockImplementation(okStream([['pass', { proposed: 3 }]]));
    const { result } = await mounted();

    // Freeze the run mid-stream by asserting the frame mapping directly — the
    // narration is derived, not invented.
    expect(narrateFrame('search', {})).toBeNull();
    expect(narrateFrame('planned', { proposed: 2 })).toEqual({ kind: 'proposed', count: 2 });
    // ⚠️ AMENDED (MOTIR-4069): this read `narrateFrame('tokens', {})` — a kind the
    // producer never emits — and asserted null, which pinned the silent
    // `default: return null` that card removes. `token` (the kind motir-ai does
    // emit, per keystroke) is still null, now as a written QUIET decision in
    // `lib/planning/planChangeFrames.ts`; a kind nobody has decided about is
    // LOUD instead (`plan-change-frame-totality.test.ts`).
    expect(narrateFrame('token', {})).toBeNull();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    // Settled → the narration clears; the proposal is the outcome.
    expect(result.current.state.progress).toBeNull();
  });

  it('reports an EMPTY result without losing the thread', async () => {
    fetchReview.mockResolvedValue(planReview([]));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(result.current.state.errorCode).toBe('EMPTY');
    expect(result.current.state.session?.turns).toHaveLength(1);
  });
});

describe('usePlanChangeConversation — failure is recoverable in place', () => {
  it('keeps a PRIOR proposal and the thread when a later run fails', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    stream.mockImplementation(
      async (_jobId: string, _signal: AbortSignal, onError: (code: string | null) => void) =>
        onError('FAILED'),
    );
    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.state.errorCode).toBe('FAILED');
    // The proposal already on the canvas survives — a retry continues the
    // conversation instead of restarting it.
    expect(result.current.state.review).toEqual(REVIEW);
    expect(result.current.state.phase).toBe('review');
  });

  it('flags an out-of-credits refusal as GATED, not as an error', async () => {
    // The refusal now arrives at the ONE DOOR, which is where the `ai:generate`
    // ceiling and the credit gate are spent for a project turn.
    submitAsk.mockRejectedValue(new PlanEditsClientError(402, 'MOTIR_AI_OUT_OF_CREDITS'));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(result.current.state.outOfCredits).toBe(true);
    expect(result.current.state.errorCode).toBeNull();
  });

  it('re-runs the TURN on retry — no second user turn, and no fresh submit', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    append.mockClear();
    submitAsk.mockClear();

    await act(async () => {
      await result.current.retry();
    });

    // A retry re-runs the TURN, naming it — no second `user` turn is appended
    // and no fresh submit is invented (ADR §3: the person said one thing once).
    expect(rerunAsk).toHaveBeenCalledWith('t0', { sessionId: 's1' }, expect.anything());
    expect(submitAsk).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});

describe('usePlanChangeConversation — the stream is not the run (MOTIR-7985)', () => {
  // A stream that delivers `frames` and then simply ENDS, the way a connection
  // closing under a run does: no `error`, no `done` the rail can tell apart.
  function streamOf(frames: Array<[string, unknown]>) {
    return async (
      _jobId: string,
      _signal: AbortSignal,
      _onError: (code: string | null) => void,
      onDone: () => void,
      onFrame?: (event: string, data: unknown) => void,
    ) => {
      for (const [event, data] of frames) onFrame?.(event, data);
      onDone();
    };
  }
  const status = (s: string): [string, unknown] => ['status', { jobId: 'job-1', status: s }];
  const searched = (seq: number): [string, unknown] => [
    'pass',
    { jobId: 'job-1', seq, proposed: seq },
  ];

  it('subscribes AGAIN when the stream ends while the job still runs, narrating each frame once', async () => {
    stream
      .mockImplementationOnce(streamOf([status('running'), searched(1)]))
      .mockImplementationOnce(
        streamOf([status('running'), searched(1), searched(2), status('succeeded')]),
      );
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(stream).toHaveBeenCalledTimes(2);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.phase).toBe('review');
    // seq 1 arrived twice across the two subscriptions; the rail tells it once.
    expect(result.current.state.acts.filter((a) => a.kind === 'proposed')).toHaveLength(2);
  });

  // A stream whose read THROWS under a run (MOTIR-9186): it delivers `frames`, then
  // reports the lost connection through `onLost` the way `consumeStream` does.
  function lostAfter(frames: Array<[string, unknown]>) {
    return async (
      _jobId: string,
      _signal: AbortSignal,
      _onError: (code: string | null) => void,
      _onDone: () => void,
      onFrame?: (event: string, data: unknown) => void,
      onLost?: () => void,
    ) => {
      for (const [event, data] of frames) onFrame?.(event, data);
      onLost?.();
    };
  }

  it('a LOST connection under a running job subscribes again, with no failure line (MOTIR-9186)', async () => {
    stream
      .mockImplementationOnce(lostAfter([status('running'), searched(1)]))
      .mockImplementationOnce(
        streamOf([status('running'), searched(1), searched(2), status('succeeded')]),
      );
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(stream).toHaveBeenCalledTimes(2);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.acts.filter((a) => a.kind === 'proposed')).toHaveLength(2);
  });

  it('a connection lost BEFORE any status frame still subscribes again (MOTIR-9186)', async () => {
    stream
      .mockImplementationOnce(lostAfter([]))
      .mockImplementationOnce(streamOf([status('running'), status('succeeded')]));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(stream).toHaveBeenCalledTimes(2);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.phase).toBe('review');
  });

  it('a job that FAILED while the connection was down shows the failure (MOTIR-9186)', async () => {
    fetchReview.mockResolvedValue(planReview([]));
    stream
      .mockImplementationOnce(lostAfter([status('running'), searched(1)]))
      .mockImplementationOnce(streamOf([status('running'), status('failed')]));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(stream).toHaveBeenCalledTimes(2);
    expect(result.current.state.errorCode).toBe('FAILED');
  });

  it('the ANCHORED stream follows a lost connection the same way (MOTIR-9186)', async () => {
    streamAnchored
      .mockImplementationOnce(
        async (
          _anchor: string,
          _job: string,
          _signal: AbortSignal,
          _onError: unknown,
          _onDone: unknown,
          onFrame?: (event: string, data: unknown) => void,
          onLost?: () => void,
        ) => {
          onFrame?.('status', { jobId: 'job-1', status: 'running' });
          onLost?.();
        },
      )
      .mockImplementationOnce(
        async (
          _anchor: string,
          _job: string,
          _signal: AbortSignal,
          _onError: unknown,
          onDone: () => void,
          onFrame?: (event: string, data: unknown) => void,
        ) => {
          onFrame?.('status', { jobId: 'job-1', status: 'succeeded' });
          onDone();
        },
      );
    const { result } = await mountedAnchored();

    await act(async () => {
      await result.current.send('Split this story.');
    });

    expect(streamAnchored).toHaveBeenCalledTimes(2);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.phase).toBe('review');
  });

  it('a job that FAILED shows the failure, never "nothing came back"', async () => {
    fetchReview.mockResolvedValue(planReview([]));
    stream.mockImplementation(streamOf([status('running'), searched(1), status('failed')]));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(stream).toHaveBeenCalledTimes(1);
    expect(result.current.state.errorCode).toBe('FAILED');
  });

  it('a job that FAILS on a follow-up keeps the earlier review in hand', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    expect(result.current.state.phase).toBe('review');

    stream.mockImplementationOnce(streamOf([status('running'), status('failed')]));
    await act(async () => {
      await result.current.send('Split it in two.');
    });

    expect(result.current.state.errorCode).toBe('FAILED');
    expect(result.current.state.phase).toBe('review');
  });

  it('a job CANCELED under the rail reads as stopped, not as EMPTY', async () => {
    fetchReview.mockResolvedValue(planReview([]));
    stream.mockImplementation(streamOf([status('running'), status('canceled')]));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.stopped).toBe(true);
  });

  it('EMPTY is a job that SUCCEEDED with nothing proposed and nothing asked', async () => {
    fetchReview.mockResolvedValue(planReview([]));
    stream.mockImplementation(streamOf([status('running'), status('succeeded')]));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(stream).toHaveBeenCalledTimes(1);
    expect(result.current.state.errorCode).toBe('EMPTY');
  });

  it('a job CANCELED after it proposed keeps the review, marked stopped', async () => {
    stream.mockImplementation(streamOf([status('running'), searched(1), status('canceled')]));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.stopped).toBe(true);
    expect(result.current.state.errorCode).toBeNull();
  });

  it('frames with no readable status or seq are narrated, not deduped', async () => {
    stream.mockImplementation(
      streamOf([
        ['status', null],
        ['status', { jobId: 'job-1' }],
        ['pass', { jobId: 'job-1', proposed: 1 }],
        ['pass', { jobId: 'job-1', proposed: 2 }],
      ]),
    );
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    // No status ever arrived, so the end is the run's end: subscribed once.
    expect(stream).toHaveBeenCalledTimes(1);
    expect(result.current.state.acts.filter((a) => a.kind === 'proposed')).toHaveLength(2);
  });

  it('an unmount during the wait before re-subscribing ends the loop', async () => {
    stream.mockImplementation(streamOf([status('running')]));
    const hook = await mounted();

    let sending!: Promise<void>;
    act(() => {
      sending = hook.result.current.send('Add recurring invoices.');
    });
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    hook.unmount();
    await act(async () => {
      await sending;
    });

    expect(stream).toHaveBeenCalledTimes(1);
  });
});

describe('usePlanChangeConversation — approve / discard', () => {
  it('persists through the shipped approve route and KEEPS the conversation open', async () => {
    const onApproved = vi.fn();
    const { result } = await mounted(onApproved);
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.approve();
    });

    // The PLAN is what gets confirmed — the same operation `/plans/[id]` performs.
    expect(approve).toHaveBeenCalledWith('plan-1', null);
    // ⚠️ AMENDED by MOTIR-3162 (bug MOTIR-3154). This asserted `review` was
    // NULLED. `PlanningWorkspaceHost` derives its entire diff index from that
    // field, so nulling it erased the overlay in the same tick the decision
    // landed — the canvas stopped saying which cards you had just accepted. The
    // review is the RECORD of the decision; `decided` is what marks it.
    expect(result.current.state.review).toEqual(REVIEW);
    expect(result.current.state.decided).toBe('accepted');
    expect(result.current.state.approved).toEqual({
      created: ['wi_new'],
      updated: [],
      removed: [],
    });
    // Decided → nothing is left addressable, so a second click cannot re-approve.
    expect(result.current.state.planId).toBeNull();
    // The thread survives the commit — that is what makes it a conversation.
    expect(result.current.state.session?.turns).toHaveLength(1);
    // The caller is told, so it can refresh the server surfaces AND the island.
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  // ── The overlay must key by what the adds BECAME (bug MOTIR-3206) ─────────
  //
  // The review in hand was read while the plan was `planned`, so its `add` is
  // keyed by the PlanItem id and carries no identifier. Keeping it past the
  // decision (MOTIR-3162) then drew every accepted card twice: the committed
  // node the level read returns, plus the keyless ghost the stale review still
  // describes. Only the server knows the materialized ids, so the decision has
  // to re-read the plan.
  it('RE-READS the decided plan so the overlay carries the materialized keys', async () => {
    const DECIDED = planReview([
      planReviewItem({
        planItemId: 'pi_1',
        // Keyed by the work item it became, with its real identifier — what
        // `getPlanReview` returns once `materialize` has stamped it.
        nodeId: 'wi_new',
        identifier: 'PAY-90',
        kind: 'story',
        title: 'Recurring',
        status: 'todo',
      }),
    ]);
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    fetchReview.mockResolvedValueOnce(DECIDED);

    await act(async () => {
      await result.current.approve();
    });

    expect(fetchReview).toHaveBeenLastCalledWith('plan-1');
    expect(result.current.state.review).toEqual(DECIDED);
    expect(result.current.state.decided).toBe('accepted');
  });

  it('keeps the PREVIOUS review when the re-read fails — the approve still stands', async () => {
    // Best-effort by design: the write has already succeeded, so a failed read
    // must not lose the overlay or report the decision as failed. The picture
    // degrades to the one that shipped before, and nothing is retried or undone.
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    fetchReview.mockRejectedValueOnce(new Error('network'));

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.review).toEqual(REVIEW);
    expect(result.current.state.decided).toBe('accepted');
    expect(result.current.state.errorCode).toBeNull();
  });

  it('a NEW turn supersedes a decided overlay — it never bleeds into the next run', async () => {
    // The review is kept THROUGH the decision so the canvas can draw it; a new
    // run is the moment it stops describing anything.
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    await act(async () => {
      await result.current.discard();
    });
    expect(result.current.state.decided).toBe('declined');

    await act(async () => {
      await result.current.send('Now add refunds.');
    });

    expect(result.current.state.decided).toBeNull();
    // …and it is the NEW run's proposals on the canvas, not the discarded ones.
    expect(result.current.state.phase).toBe('review');
  });

  it('WRITES NOTHING while the proposal is merely on screen', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    // The gate is the whole point: reviewing reads the Plan and stops there. No
    // approve, no decline — so neither the tree nor the Plan's status moves until
    // the user clicks.
    expect(result.current.state.phase).toBe('review');
    expect(approve).not.toHaveBeenCalled();
    expect(decline).not.toHaveBeenCalled();
  });

  it('surfaces an immutable rejection and leaves the proposal in review', async () => {
    approve.mockRejectedValue(new PlanRequestError(409, 'PLAN_TARGET_IMMUTABLE'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('immutable');
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
    // Still PENDING — a failed decision is not a decision, so the canvas must
    // not draw a decided treatment over a proposal the server still awaits.
    expect(result.current.state.decided).toBeNull();
  });

  it('DISCARD declines the PLAN, touches no work item, and leaves the thread intact', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.discard();
    });

    // Declining DECIDES the plan (`planned → declined`) instead of abandoning it
    // at `planned` forever — and it is the only write a discard makes.
    expect(decline).toHaveBeenCalledWith('plan-1', null);
    expect(approve).not.toHaveBeenCalled();
    // ⚠️ AMENDED by MOTIR-3162. This is the case where NOTHING survived: a
    // discarded plan left the workspace with no trace, the conversation that
    // produced the tree still on screen beside the space where the tree had
    // been. The proposals stay, marked declined.
    expect(result.current.state.review).toEqual(REVIEW);
    expect(result.current.state.decided).toBe('declined');
    expect(result.current.state.planId).toBeNull();
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.session?.turns).toHaveLength(1);
  });

  it('keeps the proposal decidable when the DISCARD itself fails', async () => {
    decline.mockRejectedValue(new PlanRequestError(500, null));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.discard();
    });

    // Clearing the canvas here would tell the user it was dropped while the
    // server still has it awaiting a decision.
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
    expect(result.current.state.planId).toBe('plan-1');
    expect(result.current.state.errorCode).toBe('discard');
  });

  it('says a plan someone ALREADY decided is decided, and never writes twice', async () => {
    approve.mockRejectedValue(new PlanRequestError(409, 'PLAN_NOT_IN_EXPECTED_STATUS'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('decided');
    expect(result.current.state.phase).toBe('review');
  });

  it('does not approve when there is no Plan to address', async () => {
    // The defensive read: a stub / older response carried only a jobId, so there
    // is nothing to confirm — the gate must no-op rather than POST to `undefined`.
    // Since MOTIR-1343 the hand-off response is where that shape arrives, so the
    // stub is the redirect's, not the submit's.
    settleAsk.mockResolvedValue({
      outcome: 'redirected',
      jobId: 'job-1',
      session: session(['Add recurring invoices.']),
    });
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.approve();
    });

    expect(approve).not.toHaveBeenCalled();
  });
});

// ─── ANCHORED at a work item — the MOTIR-910 entrance's conversation ──────────
//
// Same state machine, different thread: when the workspace was summoned from a
// work item, every hop rides the item-scoped MOTIR-909 endpoints. What these
// lock is that the routing actually switches — the project thread must never be
// touched from an item's door, and vice versa.

async function mountedAnchored(anchorId = 'wi_123', settled: 'idle' | 'review' = 'idle') {
  const hook = renderHook(() => usePlanChangeConversation({ anchorId }));
  await waitFor(() => expect(hook.result.current.state.phase).toBe(settled));
  return hook;
}

describe('usePlanChangeConversation — anchored at a work item (MOTIR-910)', () => {
  it('resumes the ITEM’s thread on mount, never the project one', async () => {
    resumeAnchored.mockResolvedValue({ session: session(['Split this story.']), planId: null });
    const { result } = await mountedAnchored();

    expect(resumeAnchored).toHaveBeenCalledWith('wi_123', [], expect.anything());
    expect(open).not.toHaveBeenCalled();
    expect(result.current.state.session?.turns).toHaveLength(1);
  });

  it('treats an item that was never planned as an EMPTY thread, not an error', async () => {
    resumeAnchored.mockResolvedValue({ session: null, planId: null });
    const { result } = await mountedAnchored();

    expect(result.current.state.session).toBeNull();
    expect(result.current.state.errorCode).toBeNull();
  });

  it('re-establishes the pending planId on mount, so a reopened workspace can still confirm (MOTIR-1745)', async () => {
    resumeAnchored.mockResolvedValue({
      session: session(['Split this story.']),
      planId: 'plan_pending',
    });
    const { result } = await mountedAnchored('wi_123', 'review');

    expect(result.current.state.planId).toBe('plan_pending');
    // …and it comes back REVIEWABLE: the undecided proposal is read from its Plan
    // and put back on the canvas, so closing the workspace mid-review is not the
    // same as discarding (MOTIR-1746).
    expect(fetchReview).toHaveBeenCalledWith('plan_pending', expect.anything());
    expect(result.current.state.review).toEqual(REVIEW);
  });

  it('comes back with NOTHING pending when the thread’s plan was already decided', async () => {
    resumeAnchored.mockResolvedValue({
      session: session(['Split this story.']),
      planId: 'plan_decided',
    });
    fetchReview.mockResolvedValue(planReview([], { status: 'approved' }));
    const { result } = await mountedAnchored();

    // A decided plan is history, not a review — no gate, and no error either.
    expect(result.current.state.review).toBeNull();
    expect(result.current.state.errorCode).toBeNull();
  });

  it('stays usable when the pending plan cannot be READ — that is not a broken session', async () => {
    resumeAnchored.mockResolvedValue({
      session: session(['Split this story.']),
      planId: 'plan_pending',
    });
    fetchReview.mockRejectedValue(new PlanRequestError(500, null));
    const { result } = await mountedAnchored();

    expect(result.current.state.session?.turns).toHaveLength(1);
    expect(result.current.state.errorCode).toBeNull();
  });

  it('adopts the SUBMIT’s planId, and drops it once the proposal is settled', async () => {
    submitAnchored.mockResolvedValue({
      jobId: 'job-anchored-1',
      planId: 'plan_fresh',
      sessionId: 's1',
      session: session(['Split this story.']),
    });
    const { result } = await mountedAnchored();

    await act(async () => {
      await result.current.send('Split this story.');
    });
    expect(result.current.state.planId).toBe('plan_fresh');

    // Discarding DECIDES that plan, so the handle goes with the job id rather
    // than lingering as a stale confirm target.
    await act(async () => {
      await result.current.discard();
    });
    expect(decline).toHaveBeenCalledWith('plan_fresh', null);
    expect(result.current.state.planId).toBeNull();
    expect(result.current.state.jobId).toBeNull();
  });

  it('degrades to no planId when the response carries only a jobId', async () => {
    // The defensive read the optional browser-facing type exists for: a stub or
    // an older deployment answers without it, and the rail simply has nothing to
    // confirm — it does not crash and does not invent an id.
    submitAnchored.mockResolvedValue({
      jobId: 'job-anchored-1',
      sessionId: 's1',
      session: session(['Split this story.']),
    });
    const { result } = await mountedAnchored();

    await act(async () => {
      await result.current.send('Split this story.');
    });
    expect(result.current.state.jobId).toBe('job-anchored-1');
    expect(result.current.state.planId).toBeNull();
  });

  it('sends the turn through the anchored endpoint — ONE call that appends AND submits', async () => {
    const { result } = await mountedAnchored();

    await act(async () => {
      await result.current.send('Split this story.');
    });

    expect(submitAnchored).toHaveBeenCalledWith(
      'wi_123',
      'Split this story.',
      [],
      expect.anything(),
      false,
      // A never-planned item holds no session yet — the first turn starts one.
      null,
    );
    // The project thread's two-call shape is never used here.
    expect(append).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.jobId).toBe('job-anchored-1');
  });

  it('streams through the item’s own relay, which re-gates the anchor on subscribe', async () => {
    const { result } = await mountedAnchored();

    await act(async () => {
      await result.current.send('Split this story.');
    });

    expect(streamAnchored).toHaveBeenCalledTimes(1);
    expect(streamAnchored.mock.calls[0]![0]).toBe('wi_123');
    expect(streamAnchored.mock.calls[0]![1]).toBe('job-anchored-1');
    expect(stream).not.toHaveBeenCalled();
  });

  it('retries by RE-SENDING the accumulated intent — no duplicated turn', async () => {
    const { result } = await mountedAnchored();
    await act(async () => {
      await result.current.send('Split this story.');
    });
    submitAnchored.mockClear();

    await act(async () => {
      await result.current.retry();
    });

    expect(resubmitAnchored).toHaveBeenCalledWith('wi_123', [], expect.anything(), 's1');
    expect(submitAnchored).not.toHaveBeenCalled();
    expect(result.current.state.jobId).toBe('job-anchored-2');
  });

  it('approves through the SAME shipped route — the anchor changes the thread, not the gate', async () => {
    const { result } = await mountedAnchored();
    await act(async () => {
      await result.current.send('Split this story.');
    });
    await act(async () => {
      await result.current.approve();
    });

    expect(approve).toHaveBeenCalledWith('plan-anchored-1', null);
    // ⚠️ AMENDED by MOTIR-3162: the review SURVIVES the decision on this path
    // too — the anchor changes the thread, not what the canvas keeps.
    expect(result.current.state.review).not.toBeNull();
    expect(result.current.state.decided).toBe('accepted');
  });
});

describe('usePlanChangeConversation — an ASKED plan (Story MOTIR-6012 · MOTIR-6037)', () => {
  const GATED = planReview(
    [planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'Recurring' })],
    {
      gate: {
        id: 'gate-6037',
        state: 'awaiting',
        stamp: 'stamp-6037',
        held: null,
        canDecide: true,
        routedToName: null,
      },
    },
  );

  it('a decline carries its OPTIONAL reason, and the stamp the reader was shown', async () => {
    fetchReview.mockResolvedValue(GATED);
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.discard('Not this quarter');
    });

    expect(decline).toHaveBeenCalledWith('plan-1', 'stamp-6037', 'Not this quarter');
    expect(result.current.state.decided).toBe('declined');
  });

  it('the decision SETTLES the To-approve row underneath, through the decided-gates store', async () => {
    const { useDecidedGateState } = await import('@/lib/approvals/decidedGates');
    // The store lives for the page, so each case decides a gate of its own.
    fetchReview.mockResolvedValue({ ...GATED, gate: { ...GATED.gate!, id: 'gate-6037-a' } });
    const { result } = await mounted();
    const row = renderHook(() => useDecidedGateState('gate-6037-a'));
    expect(row.result.current).toBeNull();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    await act(async () => {
      await result.current.approve();
    });

    expect(row.result.current).toBe('approved');
  });

  it('a declined asked plan settles its row as declined', async () => {
    const { useDecidedGateState } = await import('@/lib/approvals/decidedGates');
    const declined = { ...GATED, gate: { ...GATED.gate!, id: 'gate-6037-d' } };
    fetchReview.mockResolvedValue(declined);
    const { result } = await mounted();
    const row = renderHook(() => useDecidedGateState('gate-6037-d'));

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    await act(async () => {
      await result.current.discard();
    });

    expect(row.result.current).toBe('declined');
  });

  it('an UNASKED plan announces nothing — there is no row to settle', async () => {
    const { useDecidedGateState } = await import('@/lib/approvals/decidedGates');
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    await act(async () => {
      await result.current.approve();
    });
    const row = renderHook(() => useDecidedGateState('gate-never'));
    expect(row.result.current).toBeNull();
  });
});

// ─── THE LIVE REVIEW (MOTIR-6295) ─────────────────────────────────────────────
//
// The plan being WRITTEN is watched through the shared generating-plan poll, for
// both planners: a hosted run's plan from the moment its turn is submitted, and a
// named (MCP-authored) session's pending plan from mount. When the poll observes
// the plan LEAVE `generating`, the proposed-review path takes over — once.
describe('usePlanChangeConversation — the live review (MOTIR-6295)', () => {
  const WRITING = planReview([planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1' })], {
    id: 'plan-1',
    status: 'generating',
    plannedAt: null,
  });

  /** Let settled promises land and effects run, without moving the clock. */
  async function flush() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a HOSTED turn: live while generating, then hands over to `review` exactly once', async () => {
    const { result } = await mounted();
    vi.useFakeTimers();

    // The run's stream stays open until the test ends it.
    let endStream!: () => void;
    stream.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          endStream = resolve;
        }),
    );
    fetchReview.mockResolvedValue(WRITING);
    readPendingSpy.mockClear();

    let sent!: Promise<void>;
    act(() => {
      sent = result.current.send('Add recurring invoices.');
    });
    await flush();
    await flush();

    // Submitted, still streaming — and the plan being written is on screen.
    expect(result.current.state.phase).toBe('streaming');
    expect(result.current.state.liveReview).toEqual(WRITING);
    expect(result.current.state.liveVersion).toBeGreaterThan(0);
    expect(result.current.state.liveFailing).toBe(false);
    expect(result.current.state.review).toBeNull();
    expect(readPendingSpy).not.toHaveBeenCalled();

    // Each tick replaces the live snapshot.
    const grown = { ...WRITING, items: [...WRITING.items, planReviewItem({ planItemId: 'pi_2' })] };
    fetchReview.mockResolvedValue(grown);
    const before = result.current.state.liveVersion;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(result.current.state.liveReview?.items).toHaveLength(2);
    expect(result.current.state.liveVersion).toBe(before + 1);

    // The plan LEAVES `generating` → the proposed-review path takes over.
    fetchReview.mockResolvedValue(REVIEW);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    await flush();
    expect(result.current.state.liveReview).toBeNull();
    expect(result.current.state.review).toEqual(REVIEW);
    expect(readPendingSpy).toHaveBeenCalledTimes(1);

    // The run's own settle reuses that read rather than making a second one.
    await act(async () => {
      endStream();
      await sent;
    });
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
    expect(readPendingSpy).toHaveBeenCalledTimes(1);

    // And the poll has stopped.
    const reads = fetchReview.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchReview).toHaveBeenCalledTimes(reads);
  });

  it('an MCP-authored NAMED session: live at mount, with no turn sent', async () => {
    vi.useFakeTimers();
    getNamed.mockResolvedValue({
      ...session(['Plan the billing epic.']),
      id: 's-mcp',
      startedBy: { id: 'u2', name: 'Agent' },
      startedByViewer: false,
      viewerCanPlan: true,
      pendingPlanId: 'plan-1',
    });
    fetchReview.mockResolvedValue(WRITING);

    const { result } = renderHook(() => usePlanChangeConversation({ sessionId: 's-mcp' }));
    await flush();
    await flush();

    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.liveReview).toEqual(WRITING);
    expect(result.current.state.review).toBeNull();
    expect(submitAsk).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();

    // The agent finishes: the one hand-over puts the proposal in review.
    readPendingSpy.mockClear();
    fetchReview.mockResolvedValue(REVIEW);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    await flush();
    expect(result.current.state.liveReview).toBeNull();
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
    expect(readPendingSpy).toHaveBeenCalledTimes(1);
  });

  it('a plan DISCARDED while it was written keeps its last snapshot as `discardedReview` (MOTIR-6300)', async () => {
    vi.useFakeTimers();
    getNamed.mockResolvedValue({
      ...session(['Plan the billing epic.']),
      id: 's-mcp',
      viewerCanPlan: true,
      pendingPlanId: 'plan-1',
    });
    fetchReview.mockResolvedValue(WRITING);
    const { result } = renderHook(() => usePlanChangeConversation({ sessionId: 's-mcp' }));
    await flush();
    await flush();
    expect(result.current.state.liveReview).toEqual(WRITING);
    expect(result.current.state.discardedReview).toBeNull();

    // The agent closes the plan holding nothing: `generating → declined`, discarded.
    readPendingSpy.mockClear();
    const ended = {
      ...WRITING,
      items: [],
      status: 'declined' as const,
      decisionReason: 'discarded' as const,
    };
    fetchReview.mockResolvedValue(ended);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    await flush();
    // ONE update: the live snapshot leaves as the ended one arrives — and nothing
    // is handed over, because nothing was proposed.
    expect(result.current.state.liveReview).toBeNull();
    expect(result.current.state.discardedReview).toEqual(ended);
    expect(result.current.state.review).toBeNull();
    expect(readPendingSpy).not.toHaveBeenCalled();
  });

  it('a named session whose pending plan is already PROPOSED opens in review, with no live poll', async () => {
    vi.useFakeTimers();
    getNamed.mockResolvedValue({
      ...session(['q']),
      id: 's-done',
      viewerCanPlan: true,
      pendingPlanId: 'plan-1',
    });
    fetchReview.mockResolvedValue(REVIEW);

    const { result } = renderHook(() => usePlanChangeConversation({ sessionId: 's-done' }));
    await flush();
    await flush();

    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.liveReview).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchReview).toHaveBeenCalledTimes(1);
  });
});

// ─── THE LIVE REVIEW's edges (MOTIR-6301, the live-drawing gate's top-up) ─────
//
// The arms of the live review the cases above do not reach, each a way the
// hand-over or the poll can end other than the happy one. Without them the hook
// sits under the 90% branch floor `vitest.config.ts` gates it at.
describe('usePlanChangeConversation — the live review, its other endings (MOTIR-6301)', () => {
  const WRITING = planReview([planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1' })], {
    id: 'plan-1',
    status: 'generating',
    plannedAt: null,
  });

  async function flush() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  async function watchingNamedSession() {
    vi.useFakeTimers();
    getNamed.mockResolvedValue({
      ...session(['Plan the billing epic.']),
      id: 's-mcp',
      viewerCanPlan: true,
      pendingPlanId: 'plan-1',
    });
    fetchReview.mockResolvedValue(WRITING);
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's-mcp' }));
    await flush();
    await flush();
    expect(hook.result.current.state.liveReview).toEqual(WRITING);
    // The mount's own read (null for a generating plan) is not the hand-over's.
    readPendingSpy.mockClear();
    return hook;
  }

  // The file-level mock wraps the REAL read; each case here overrides it once, so
  // the real one is put back after it.
  let realRead: ReturnType<typeof readPendingSpy.getMockImplementation>;
  beforeEach(() => {
    realRead = readPendingSpy.getMockImplementation();
    readPendingSpy.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    readPendingSpy.mockReset();
    if (realRead) readPendingSpy.mockImplementation(realRead);
  });

  it('a hand-over whose proposal read FAILS still ends the live review, and proposes nothing', async () => {
    const { result } = await watchingNamedSession();
    readPendingSpy.mockRejectedValue(new Error('offline'));
    fetchReview.mockResolvedValue(REVIEW);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    await flush();
    expect(readPendingSpy).toHaveBeenCalledTimes(1);
    expect(result.current.state.liveReview).toBeNull();
    expect(result.current.state.review).toBeNull();
    expect(result.current.state.phase).toBe('idle');
  });

  it('a hand-over that finds nothing reviewable ends the live review with no review', async () => {
    const { result } = await watchingNamedSession();
    readPendingSpy.mockResolvedValue(null);
    fetchReview.mockResolvedValue(REVIEW);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    await flush();
    expect(result.current.state.liveReview).toBeNull();
    expect(result.current.state.review).toBeNull();
    expect(result.current.state.phase).toBe('idle');
  });

  it('a hand-over that lands after the surface closed writes nothing', async () => {
    const { result, unmount } = await watchingNamedSession();
    let land!: (r: unknown) => void;
    readPendingSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    fetchReview.mockResolvedValue(REVIEW);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(readPendingSpy).toHaveBeenCalledTimes(1);
    const last = result.current.state;
    unmount();
    await act(async () => {
      land(REVIEW);
      await vi.advanceTimersByTimeAsync(0);
    });
    // The unmounted hook kept the state it had; nothing was applied after close.
    expect(result.current.state).toBe(last);
    expect(last.liveReview).toEqual(WRITING);
  });

  it('three failed reads say FAILING and keep the last snapshot; a good read clears it', async () => {
    const { result } = await watchingNamedSession();
    fetchReview.mockRejectedValue(new TypeError('Failed to fetch'));
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
    }
    expect(result.current.state.liveFailing).toBe(true);
    expect(result.current.state.liveReview).toEqual(WRITING);

    fetchReview.mockResolvedValue(WRITING);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(result.current.state.liveFailing).toBe(false);
  });

  it('a turn redirected AT THE DOOR with no plan id starts no live poll', async () => {
    const { result } = await mounted();
    submitAsk.mockResolvedValueOnce({
      outcome: 'redirected',
      jobId: 'job-door',
      session: session(['yes']),
    });
    fetchReview.mockClear();
    await act(async () => {
      await result.current.send('yes');
    });
    expect(result.current.state.liveReview).toBeNull();
    expect(fetchReview).not.toHaveBeenCalled();
  });
});
