// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// The story-level COVERAGE GATE's residual for the conversation state machine
// (MOTIR-1732). MOTIR-1730 shipped the HAPPY-PATH suite
// (`use-plan-change-conversation.test.tsx` — resume, a turn, narration, EMPTY,
// out-of-credits, retry, approve/discard) and this file adds only what that
// suite leaves unexecuted, which is what took the hook under the per-file gate:
//
//   * the APPEND leg failing (the turn never lands, so there is nothing to
//     submit) — distinct from the SUBMIT leg failing, which is covered;
//   * the in-flight REENTRANCY guards (`send`/`retry` while a run is open) —
//     a double-click must not open a second job on one thread;
//   * UNMOUNT mid-flight: the abort is swallowed, and no state write lands on a
//     dead component;
//   * `approve` with nothing selected, a non-typed approve failure, and
//     `dismissError`.

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
  submitAsk,
  rerunAsk,
  settleAsk,
  streamAsk,
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
  submitAsk: vi.fn(),
  rerunAsk: vi.fn(),
  settleAsk: vi.fn(),
  streamAsk: vi.fn(),
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
  // The anchored half (MOTIR-910) is exercised by exactly one case here — the
  // retry that falls back to the ENTRANCE's anchor — and otherwise just has to
  // exist, because the module mock must carry every export the hook imports.
  resumeContextualSession: resumeAnchored,
  submitContextualPlan: submitAnchored,
  resubmitContextualPlan: resubmitAnchored,
  submitAskTurn: submitAsk,
  rerunAskTurn: rerunAsk,
  settleAskJob: settleAsk,
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return {
    ...actual,
    streamAugmentJob: stream,
    // The anchored stream is not under test here; left real, a retry pressed first reached a
    // genuine `fetch` that fails offline, and a lost connection now subscribes again (MOTIR-9186).
    streamContextualPlanJob: async () => {},
    streamAskJob: streamAsk,
  };
});

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    fetchPlanReview: fetchReview,
    approvePlanRequest: approve,
    declinePlanRequest: decline,
  };
});

import {
  usePlanChangeConversation,
  narrateFrame,
  PLAN_GATE_POLL_MS,
} from '@/lib/hooks/usePlanChangeConversation';
import { planGateView } from '@/lib/planning/planGateView';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { PlanRequestError } from '@/lib/planning/planReviewClient';
import { useDecidedGateState } from '@/lib/approvals/decidedGates';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanWithItemsDto } from '@/lib/dto/plans';

function session(bodies: string[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
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

const REVIEW: PlanReviewDto = planReview([
  planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'Recurring' }),
]);

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

function okStream() {
  return vi.fn(async () => {});
}

/** The DOMException the fetch layer raises when a caller aborts. */
function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** A promise plus the handles to settle it from the test — for pinning a call
 *  in flight while another one is attempted. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  fetchReview.mockResolvedValue(REVIEW);
  approve.mockResolvedValue(MATERIALIZED);
  decline.mockResolvedValue({ ...MATERIALIZED, status: 'declined', items: [] });
  // ── the ASK door (MOTIR-1343) — the project thread's only entrance. The
  // default settle REDIRECTS, so these suites keep exercising the same
  // plan-change tail they were written against.
  resumeAnchored.mockResolvedValue({ session: null, planId: null });
  submitAnchored.mockResolvedValue({
    jobId: 'job-anchored-0',
    planId: 'plan-anchored-0',
    sessionId: 's1',
    session: session(['Split this story.']),
  });
  resubmitAnchored.mockResolvedValue({
    jobId: 'job-anchored-1',
    planId: 'plan-anchored-1',
    sessionId: 's1',
    session: session(['Split this story.']),
  });
  submitAsk.mockImplementation(async (body: string) => ({
    jobId: 'ask-1',
    turnId: 't0',
    session: session([body]),
  }));
  rerunAsk.mockImplementation(async () => ({
    jobId: 'ask-2',
    turnId: 't0',
    session: session(['x']),
  }));
  settleAsk.mockResolvedValue({
    outcome: 'redirected',
    jobId: 'job-1',
    planId: 'plan-1',
    session: session(['x']),
  });
  streamAsk.mockImplementation(async () => {});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mounted() {
  const hook = renderHook(() => usePlanChangeConversation());
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

describe('usePlanChangeConversation — the APPEND leg fails', () => {
  it('does NOT submit when the turn could not be recorded', async () => {
    // The distinction that matters: the thread is the intent. If the turn never
    // landed, submitting would send the OLD accumulated intent and silently drop
    // what the user just typed — worse than failing.
    submitAsk.mockRejectedValue(new PlanEditsClientError(500, null));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(streamAsk).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.errorCode).toBe('FAILED');
  });

  it('leaves a PRIOR proposal in review when a later append fails', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    expect(result.current.state.phase).toBe('review');

    submitAsk.mockRejectedValue(new PlanEditsClientError(500, null));
    await act(async () => {
      await result.current.send('Actually, make them smaller.');
    });

    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
  });

  it('releases the in-flight latch so the next send can proceed', async () => {
    // A failed append that left `abortRef` set would wedge the rail: every later
    // send would hit the reentrancy guard and silently do nothing.
    submitAsk.mockRejectedValueOnce(new PlanEditsClientError(500, null));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('first');
    });
    await act(async () => {
      await result.current.send('second');
    });

    expect(submitAsk).toHaveBeenCalledTimes(2);
    expect(result.current.state.phase).toBe('review');
  });
});

describe('usePlanChangeConversation — one run at a time', () => {
  it('ignores a second send while a run is in flight', async () => {
    const pending = deferred<PlanChangeSessionDto>();
    submitAsk.mockReturnValueOnce(pending.promise);
    const { result } = await mounted();

    let first: Promise<void>;
    await act(async () => {
      first = result.current.send('Add recurring invoices.');
      // The double-click: fired before the first append settles.
      await result.current.send('Add recurring invoices.');
    });
    expect(submitAsk).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(session(['Add recurring invoices.']));
      await first!;
    });
    expect(settleAsk).toHaveBeenCalledTimes(1);
  });

  it('ignores a retry while a run is in flight', async () => {
    const pending = deferred<{ jobId: string; planId: string; session: PlanChangeSessionDto }>();
    submitAsk.mockReturnValueOnce(pending.promise);
    const { result } = await mounted();

    let first: Promise<void>;
    await act(async () => {
      first = result.current.send('Add recurring invoices.');
      await result.current.retry();
    });
    expect(submitAsk).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({
        jobId: 'job-1',
        planId: 'plan-1',
        session: session(['Add recurring invoices.']),
      });
      await first!;
    });
  });

  it('ignores a blank or whitespace-only turn', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('   \n  ');
    });
    expect(submitAsk).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('idle');
  });
});

describe('usePlanChangeConversation — an aborted call is not an error', () => {
  it('swallows the mount read’s abort rather than showing a failure', async () => {
    // Unmounting during the resume read aborts it; the user never sees a rail
    // that says "couldn't load" on a surface they already left.
    open.mockRejectedValue(abortError());
    const { result } = renderHook(() => usePlanChangeConversation());

    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.phase).toBe('loading');
  });

  it('shows a recoverable error for a REAL mount-read failure', async () => {
    open.mockRejectedValue(new PlanEditsClientError(500, null));
    const { result } = renderHook(() => usePlanChangeConversation());

    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.errorCode).toBe('SESSION_UNAVAILABLE');
  });

  it('swallows an aborted RUN rather than flagging it as failed', async () => {
    submitAsk.mockRejectedValue(abortError());
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.outOfCredits).toBe(false);
  });

  it('swallows an aborted APPEND rather than flagging it as failed', async () => {
    submitAsk.mockRejectedValue(abortError());
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(result.current.state.errorCode).toBeNull();
    expect(streamAsk).not.toHaveBeenCalled();
  });
});

describe('usePlanChangeConversation — unmounting mid-flight', () => {
  it('aborts the in-flight run and writes no state after unmount', async () => {
    const pending = deferred<{ jobId: string; planId: string; session: PlanChangeSessionDto }>();
    submitAsk.mockReturnValueOnce(pending.promise);
    const hook = await mounted();

    let run: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('Add recurring invoices.');
    });

    const phaseAtUnmount = hook.result.current.state.phase;
    hook.unmount();

    // Settling AFTER unmount must be inert: no stream, no result fetch, and no
    // React "update on an unmounted component" write.
    await act(async () => {
      pending.resolve({
        jobId: 'job-1',
        planId: 'plan-1',
        session: session(['Add recurring invoices.']),
      });
      await run!;
    });

    expect(stream).not.toHaveBeenCalled();
    expect(fetchReview).not.toHaveBeenCalled();
    expect(hook.result.current.state.phase).toBe(phaseAtUnmount);
  });

  it('drops the resume payload that arrives after unmount', async () => {
    const pending = deferred<PlanChangeSessionDto>();
    open.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => usePlanChangeConversation());

    hook.unmount();
    await act(async () => {
      pending.resolve(session(['a turn']));
      await pending.promise;
    });

    // Never left `loading`: the write was skipped, not applied to a dead tree.
    expect(hook.result.current.state.phase).toBe('loading');
    expect(hook.result.current.state.session).toBeNull();
  });

  it('drops an append failure that arrives after unmount', async () => {
    const pending = deferred<PlanChangeSessionDto>();
    submitAsk.mockReturnValueOnce(pending.promise);
    const hook = await mounted();

    let run: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('Add recurring invoices.');
    });
    hook.unmount();

    await act(async () => {
      pending.reject(new PlanEditsClientError(500, null));
      await run!;
    });

    expect(hook.result.current.state.errorCode).toBeNull();
    expect(streamAsk).not.toHaveBeenCalled();
  });

  it('drops a settled plan read that arrives after unmount', async () => {
    const pending = deferred<PlanReviewDto>();
    fetchReview.mockReturnValueOnce(pending.promise);
    const hook = await mounted();

    let run: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('Add recurring invoices.');
    });
    hook.unmount();

    await act(async () => {
      pending.resolve(REVIEW);
      await run!;
    });

    expect(hook.result.current.state.review).toBeNull();
  });

  it('drops a stream failure and its progress frames after unmount', async () => {
    let emit: ((event: string, data: unknown) => void) | undefined;
    let fail: ((code: string | null) => void) | undefined;
    const pending = deferred<void>();
    streamAsk.mockImplementationOnce(
      async (
        _jobId: string,
        _signal: AbortSignal,
        onError: (code: string | null) => void,
        _onDone: () => void,
        onFrame?: (event: string, data: unknown) => void,
      ) => {
        emit = onFrame;
        fail = onError;
        await pending.promise;
      },
    );
    const hook = await mounted();

    let run: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('Add recurring invoices.');
    });
    hook.unmount();

    await act(async () => {
      emit?.('drill', {});
      fail?.('FAILED');
      pending.resolve();
      await run!;
    });

    expect(hook.result.current.state.errorCode).toBeNull();
    expect(hook.result.current.state.progress).toEqual({ kind: 'reading' });
  });

  it('drops an approve result that arrives after unmount', async () => {
    const pending = deferred<{ created: string[]; updated: string[]; unchanged: string[] }>();
    const hook = await mounted();
    await act(async () => {
      await hook.result.current.send('Add recurring invoices.');
    });

    approve.mockReturnValueOnce(pending.promise);
    let approving: Promise<void>;
    await act(async () => {
      approving = hook.result.current.approve();
    });
    hook.unmount();

    await act(async () => {
      pending.resolve({ created: ['PAY-30'], updated: [], unchanged: [] });
      await approving!;
    });

    expect(hook.result.current.state.approved).toBeNull();
  });

  it('drops an approve FAILURE that arrives after unmount', async () => {
    const pending = deferred<never>();
    const hook = await mounted();
    await act(async () => {
      await hook.result.current.send('Add recurring invoices.');
    });

    approve.mockReturnValueOnce(pending.promise);
    let approving: Promise<void>;
    await act(async () => {
      approving = hook.result.current.approve();
    });
    hook.unmount();

    await act(async () => {
      pending.reject(new PlanEditsClientError(500, null));
      await approving!;
    });

    expect(hook.result.current.state.errorCode).toBeNull();
    expect(hook.result.current.state.phase).toBe('deciding');
  });

  it('drops an append SUCCESS that arrives after unmount', async () => {
    const pending = deferred<PlanChangeSessionDto>();
    submitAsk.mockReturnValueOnce(pending.promise);
    const hook = await mounted();

    let run: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('Add recurring invoices.');
    });
    hook.unmount();

    await act(async () => {
      pending.resolve(session(['Add recurring invoices.']));
      await run!;
    });

    // The turn IS on the server; the dead rail just does not re-render for it,
    // and the run stops there rather than submitting into the void.
    expect(hook.result.current.state.session?.turns).toEqual([]);
    expect(streamAsk).not.toHaveBeenCalled();
  });

  it('drops a submit failure that arrives after unmount', async () => {
    const pending = deferred<never>();
    submitAsk.mockReturnValueOnce(pending.promise);
    const hook = await mounted();

    let run: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('Add recurring invoices.');
    });
    hook.unmount();

    await act(async () => {
      pending.reject(new PlanEditsClientError(500, null));
      await run!;
    });

    expect(hook.result.current.state.errorCode).toBeNull();
  });
});

describe('usePlanChangeConversation — a failed SUBMIT keeps the prior proposal', () => {
  it('stays in review when the submit leg fails after an earlier success', async () => {
    // The counterpart to the shipped STREAM-failure case: the run can also die
    // before the job exists. Either way the canvas must not lose the proposal
    // the user is still looking at.
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    expect(result.current.state.phase).toBe('review');

    rerunAsk.mockRejectedValueOnce(new PlanEditsClientError(500, null));
    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
    expect(result.current.state.errorCode).toBe('FAILED');
  });

  it('keeps a prior proposal when a retry is refused for credits', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    rerunAsk.mockRejectedValueOnce(new PlanEditsClientError(402, 'MOTIR_AI_OUT_OF_CREDITS'));
    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.state.outOfCredits).toBe(true);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.review).toEqual(REVIEW);
  });

  it('completes a run whose stream signals done', async () => {
    // The shipped suite's stub never calls `onDone`; the real SSE does on a
    // clean close, and the hook must fall through to reading the run's plan.
    stream.mockImplementationOnce(
      async (
        _jobId: string,
        _signal: AbortSignal,
        _onError: (code: string | null) => void,
        onDone: () => void,
      ) => {
        onDone();
      },
    );
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(fetchReview).toHaveBeenCalledWith('plan-1', expect.anything());
    expect(result.current.state.phase).toBe('review');
  });
});

describe('usePlanChangeConversation — approve edges', () => {
  it('does nothing when there is no proposal to approve', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.approve();
    });
    expect(approve).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('idle');
  });

  it('reports an untyped approve failure as APPROVE_ERROR and stays in review', async () => {
    approve.mockRejectedValue(new Error('network down'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('APPROVE_ERROR');
    expect(result.current.state.phase).toBe('review');
    // Nothing was consumed — the proposal is still there to retry.
    expect(result.current.state.review).toEqual(REVIEW);
  });

  it('falls back to APPROVE_ERROR for a typed error with no code', async () => {
    approve.mockRejectedValue(new PlanRequestError(500, null));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('APPROVE_ERROR');
  });

  it('never puts a raw server code on screen — an unrecognized one reads as the generic failure', async () => {
    approve.mockRejectedValue(new PlanRequestError(400, 'PLAN_GRAMMAR_VIOLATION'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    await act(async () => {
      await result.current.approve();
    });

    // The two codes a reviewer can act on (`immutable` / `decided`) are named;
    // everything else falls to the recoverable line rather than leaking a code.
    expect(result.current.state.errorCode).toBe('APPROVE_ERROR');
  });

  it('reports a plan that vanished as already DECIDED, not as a failure to retry', async () => {
    approve.mockRejectedValue(new PlanRequestError(404, 'PLAN_NOT_FOUND'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('decided');
  });

  it('approves with NO onApproved callback wired', async () => {
    // The optional-callback arm: the hook is usable without the page-state
    // fan-out (a read-only host), and must not throw calling an absent callback.
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.approved).toEqual({
      created: ['wi_new'],
      updated: [],
      removed: [],
    });
    expect(result.current.state.phase).toBe('idle');
  });
});

describe('usePlanChangeConversation — an ASKED plan is decided through its gate (MOTIR-6037 · MOTIR-6038)', () => {
  // The plan's question as the review read returns it: `awaiting`, with the stamp the
  // press must hand back. Each case takes its own gate id — the decided-gates store is
  // page-global, and a shared id would let one case's announcement answer another's.
  function asked(gateId: string, stamp = `stamp-${gateId}`): PlanReviewDto {
    return {
      ...REVIEW,
      gate: { id: gateId, state: 'awaiting', stamp, held: null, canDecide: true },
    };
  }

  async function withProposal(review: PlanReviewDto) {
    fetchReview.mockResolvedValue(review);
    const hook = await mounted();
    await act(async () => {
      await hook.result.current.send('Add recurring invoices.');
    });
    expect(hook.result.current.state.review).toEqual(review);
    return hook;
  }

  function decidedState(gateId: string) {
    return renderHook(() => useDecidedGateState(gateId)).result.current;
  }

  it('APPROVE hands back the stamp the reader was shown, and settles the To-approve row', async () => {
    const { result } = await withProposal(asked('gate-approve'));
    await act(async () => {
      await result.current.approve();
    });

    expect(approve).toHaveBeenCalledWith('plan-1', 'stamp-gate-approve');
    expect(decidedState('gate-approve')).toBe('approved');
  });

  it('DECLINE with a reason carries the stamp AND the note, and settles the row as declined', async () => {
    const { result } = await withProposal(asked('gate-decline'));
    await act(async () => {
      await result.current.discard('Not this quarter.');
    });

    expect(decline).toHaveBeenCalledWith('plan-1', 'stamp-gate-decline', 'Not this quarter.');
    expect(result.current.state.decided).toBe('declined');
    expect(decidedState('gate-decline')).toBe('declined');
  });

  it('a plan whose gate is NOT awaiting announces nothing — it was never asked here', async () => {
    const review: PlanReviewDto = {
      ...REVIEW,
      gate: { id: 'gate-quiet', state: 'approved', stamp: null, held: null, canDecide: true },
    };
    const { result } = await withProposal(review);
    await act(async () => {
      await result.current.discard();
    });

    expect(decline).toHaveBeenCalledWith('plan-1', null);
    expect(decidedState('gate-quiet')).toBeNull();
  });

  it('a STALE approve re-reads the review, so the next press carries the new stamp', async () => {
    const { result } = await withProposal(asked('gate-stale', 'stamp-old'));
    const fresh = asked('gate-stale', 'stamp-new');
    fetchReview.mockResolvedValue(fresh);
    approve.mockRejectedValueOnce(new PlanRequestError(409, 'APPROVAL_GATE_STALE_SUBJECT'));

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('stale');
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(fresh);

    await act(async () => {
      await result.current.approve();
    });
    expect(approve).toHaveBeenLastCalledWith('plan-1', 'stamp-new');
  });

  it('a STALE decline re-reads the review too', async () => {
    const { result } = await withProposal(asked('gate-stale-decline', 'stamp-old'));
    const fresh = asked('gate-stale-decline', 'stamp-new');
    fetchReview.mockResolvedValue(fresh);
    decline.mockRejectedValueOnce(new PlanRequestError(409, 'APPROVAL_GATE_STALE_SUBJECT'));

    await act(async () => {
      await result.current.discard();
    });

    expect(result.current.state.errorCode).toBe('stale');
    expect(result.current.state.review).toEqual(fresh);
    expect(decidedState('gate-stale-decline')).toBeNull();
  });

  it('a failed re-read after a stale refusal keeps the review in hand', async () => {
    const review = asked('gate-stale-reread-fails', 'stamp-old');
    const { result } = await withProposal(review);
    fetchReview.mockRejectedValueOnce(new Error('network down'));
    approve.mockRejectedValueOnce(new PlanRequestError(409, 'APPROVAL_GATE_STALE_SUBJECT'));

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('stale');
    expect(result.current.state.review).toEqual(review);
  });

  it('a re-read that lands after unmount writes nothing', async () => {
    const { result, unmount } = await withProposal(asked('gate-stale-unmount', 'stamp-old'));
    const reread = deferred<PlanReviewDto>();
    fetchReview.mockReturnValueOnce(reread.promise);
    approve.mockRejectedValueOnce(new PlanRequestError(409, 'APPROVAL_GATE_STALE_SUBJECT'));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.approve();
    });
    await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(2));
    unmount();
    reread.resolve(asked('gate-stale-unmount', 'stamp-new'));
    await pending;

    expect(result.current.state.review?.gate?.stamp).toBe('stamp-old');
  });

  it('a HELD refusal (a revision in flight) does NOT re-read — the proposals have not moved', async () => {
    const { result } = await withProposal(asked('gate-held'));
    approve.mockRejectedValueOnce(new PlanRequestError(409, 'PLAN_REVISION_IN_FLIGHT'));

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('held');
    expect(fetchReview).toHaveBeenCalledTimes(1);
  });
});

describe('usePlanChangeConversation — dismissError', () => {
  it('clears both the error and the gated flag without touching the thread', async () => {
    submitAsk.mockRejectedValue(new PlanEditsClientError(402, 'MOTIR_AI_OUT_OF_CREDITS'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    expect(result.current.state.outOfCredits).toBe(true);

    act(() => {
      result.current.dismissError();
    });

    expect(result.current.state.outOfCredits).toBe(false);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.session).not.toBeNull();
  });
});

describe('narrateFrame — the frames the augment job really emits', () => {
  it('⚠️ AMENDED (MOTIR-4069, MOTIR-8158) — an unknown event warns but draws nothing, and `token` is a decision', () => {
    // This read `expect(narrateFrame('token', …)).toBeNull()` under the title
    // "ignores an unknown event". It was not a bug that got fixed — it PINNED
    // the `default: return null` that MOTIR-4069 removes, and it was correct
    // while that default was the design.
    //
    // Two things changed underneath it, and they are different:
    //
    //  · `token` is not unknown. It is one of the 51 kinds `motir-ai` emits, and
    //    it is now an explicit QUIET disposition with a written reason
    //    (bookkeeping — it says nothing a reader of the run would act on). Still
    //    null, but decided rather than fallen through.
    //  · a genuinely UNKNOWN kind no longer returns null at all. That is the
    //    whole card: the defect was never the missing arm, it was the silent
    //    floor beneath it, which made every frame added upstream invisible with
    //    no signature. `plan-change-frame-totality.test.ts` is where that is
    //    asserted properly, on the ABSENCE of the silent path.
    expect(narrateFrame('token', { text: 'hi' })).toBeNull();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // MOTIR-8158: an unlisted kind draws nothing (it warns a developer instead).
    expect(narrateFrame('genuinely_unknown_frame', {})).toBeNull();
    warn.mockRestore();

    expect(narrateFrame('search', undefined)).toBeNull();
  });

  it('draws nothing for the lookup frames the engine emits before it plans', () => {
    expect(narrateFrame('search', {})).toBeNull();
    expect(narrateFrame('drill', {})).toBeNull();
  });

  it('defaults a non-numeric proposed count to zero rather than NaN', () => {
    expect(narrateFrame('planned', { proposed: 'lots' })).toEqual({ kind: 'proposed', count: 0 });
    expect(narrateFrame('level_complete', {})).toEqual({ kind: 'proposed', count: 0 });
    expect(narrateFrame('pass', { proposed: 4 })).toEqual({ kind: 'proposed', count: 4 });
  });

  it('narrates both validation frames as validating', () => {
    expect(narrateFrame('validated', {})).toEqual({ kind: 'validating' });
    expect(narrateFrame('validation_skipped', {})).toEqual({ kind: 'validating' });
  });
});

// ── The arms MOTIR-1343 added weight to (MOTIR-1822) ─────────────────────────
//
// None of these are new behaviour. They are paths the file always had, which the
// ask door made MATTER: it roughly doubled the hook's branch count, so the same
// handful of unexercised arms went from rounding error to a broken coverage
// floor. Each one below is a real thing the hook does and nothing asserted.

describe('usePlanChangeConversation — the quiet arms', () => {
  it('⚠️ AMENDED (MOTIR-4069) — a frame it has no narration for is NOT drawn, and warns', async () => {
    // This read "ignores a job frame it has no narration for", and its comment
    // said `narrateFrame` "returns null for anything outside the known set". That
    // was an accurate description of the code and the exact behaviour MOTIR-4069
    // removes: an unaccounted frame reached this rail and vanished, with no
    // signature, for the whole life of `retrieval`.
    //
    // What is UNCHANGED and still worth asserting is the run itself: an odd frame
    // must not derail the settle. It reaches `review` either way — which is why
    // this test survives the amendment rather than being deleted.
    stream.mockImplementationOnce(
      async (
        _jobId: string,
        _signal: AbortSignal,
        _onError: (code: string | null) => void,
        _onDone: () => void,
        onFrame?: (event: string, data: unknown) => void,
      ) => {
        onFrame?.('some_future_frame', { x: 1 });
      },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(result.current.state.phase).toBe('review');
    // MOTIR-8158: the frame draws nothing, and it warned a developer.
    expect(result.current.state.acts.some((a) => (a.kind as string) === 'unknown')).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('DISCARD with nothing to decline still clears the thread’s decision state', async () => {
    // The defensive read again: a stubbed or older response carried no `planId`,
    // so there is no plan to decline — the gate must record the decision without
    // POSTing to `undefined`.
    const { result } = await mounted();

    await act(async () => {
      await result.current.discard();
    });

    expect(decline).not.toHaveBeenCalled();
    expect(result.current.state.decided).toBe('declined');
  });

  it('an ANCHORED retry before any run falls back to the entrance’s anchor', async () => {
    // `lastAnchorRef` is empty until a run lands, so a retry pressed first has to
    // reach for the anchor the workspace was opened at — otherwise it would
    // silently re-aim an item thread at the project.
    const hook = renderHook(() => usePlanChangeConversation({ anchorId: 'wi_123' }));
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));

    await act(async () => {
      await hook.result.current.retry();
    });

    expect(resubmitAnchored).toHaveBeenCalledWith('wi_123', [], expect.anything(), null);
  });

  it('a plan-run stream failure while a proposal is pending returns to REVIEW', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    expect(result.current.state.phase).toBe('review');

    // The SECOND run fails at the plan-edit stream — the leg the redirect hands
    // off to — and the proposal already on the canvas has to survive it.
    stream.mockImplementationOnce(
      async (_jobId: string, _signal: AbortSignal, onError: (code: string | null) => void) => {
        onError('FAILED');
      },
    );
    await act(async () => {
      await result.current.send('and drop the other one');
    });

    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
    expect(result.current.state.errorCode).toBe('FAILED');
  });

  it('an out-of-credits refusal mid-plan-run is GATED, and keeps the proposal', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    stream.mockImplementationOnce(
      async (_jobId: string, _signal: AbortSignal, onError: (code: string | null) => void) => {
        onError('MOTIR_AI_OUT_OF_CREDITS');
      },
    );
    await act(async () => {
      await result.current.send('and drop the other one');
    });

    expect(result.current.state.outOfCredits).toBe(true);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.review).toEqual(REVIEW);
  });

  it('drops a DISCARD that lands after unmount', async () => {
    const pending = deferred<never>();
    const hook = await mounted();
    await act(async () => {
      await hook.result.current.send('Add recurring invoices.');
    });

    decline.mockReturnValueOnce(pending.promise as never);
    let discarding!: Promise<void>;
    await act(async () => {
      discarding = hook.result.current.discard();
    });
    hook.unmount();

    await act(async () => {
      (pending.resolve as unknown as (v: unknown) => void)({});
      await discarding;
    });

    expect(hook.result.current.state.decided).toBeNull();
  });

  it('drops a discard FAILURE that lands after unmount', async () => {
    const hook = await mounted();
    await act(async () => {
      await hook.result.current.send('Add recurring invoices.');
    });

    let reject!: (e: unknown) => void;
    decline.mockReturnValueOnce(
      new Promise((_r, rj) => {
        reject = rj;
      }) as never,
    );
    let discarding!: Promise<void>;
    await act(async () => {
      discarding = hook.result.current.discard();
    });
    hook.unmount();

    await act(async () => {
      reject(new Error('nope'));
      await discarding;
    });

    // Nothing was written — not even the error the surface would have shown.
    expect(hook.result.current.state.errorCode).toBeNull();
  });

  it('drops the post-approve review READ that lands after unmount', async () => {
    // The approve itself already succeeded; what is dropped is the overlay
    // refresh that follows it, which has nowhere to land.
    const pending = deferred<unknown>();
    const hook = await mounted();
    await act(async () => {
      await hook.result.current.send('Add recurring invoices.');
    });

    fetchReview.mockReturnValueOnce(pending.promise as never);
    let approving!: Promise<void>;
    await act(async () => {
      approving = hook.result.current.approve();
    });
    hook.unmount();

    await act(async () => {
      pending.resolve(REVIEW);
      await approving;
    });

    expect(hook.result.current.state.decided).toBeNull();
  });

  it('an ANCHORED submit that fails is recoverable in place', async () => {
    // `run`'s own catch — the plan-change path's, which the project thread no
    // longer reaches now that it goes through the ask door. The anchored
    // entrance still does, so this is where that arm lives.
    submitAnchored.mockRejectedValue(new PlanEditsClientError(500, null));
    const hook = renderHook(() => usePlanChangeConversation({ anchorId: 'wi_123' }));
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));

    await act(async () => {
      await hook.result.current.send('Split this story.');
    });

    expect(hook.result.current.state.errorCode).toBe('FAILED');
    expect(hook.result.current.state.phase).toBe('idle');
  });

  it('an ANCHORED submit refused for credits is GATED, not an error', async () => {
    submitAnchored.mockRejectedValue(new PlanEditsClientError(402, 'MOTIR_AI_OUT_OF_CREDITS'));
    const hook = renderHook(() => usePlanChangeConversation({ anchorId: 'wi_123' }));
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));

    await act(async () => {
      await hook.result.current.send('Split this story.');
    });

    expect(hook.result.current.state.outOfCredits).toBe(true);
    expect(hook.result.current.state.errorCode).toBeNull();
  });

  it('an ANCHORED submit that ABORTS writes nothing at all', async () => {
    submitAnchored.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const hook = renderHook(() => usePlanChangeConversation({ anchorId: 'wi_123' }));
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));

    await act(async () => {
      await hook.result.current.send('Split this story.');
    });

    expect(hook.result.current.state.errorCode).toBeNull();
    expect(hook.result.current.state.outOfCredits).toBe(false);
  });

  it('a new turn after a DECISION clears the decided overlay', async () => {
    // The overlay describes what was just decided; a new run is the moment it
    // stops describing anything (MOTIR-3162's rule, from the other side).
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    await act(async () => {
      await result.current.approve();
    });
    expect(result.current.state.decided).toBe('accepted');

    await act(async () => {
      await result.current.send('now split it');
    });

    expect(result.current.state.decided).toBeNull();
  });
});

describe('usePlanChangeConversation — THE ACT RAIL is a record (MOTIR-4069)', () => {
  it('opens with the act that started the run, adds the hand-off, then every frame IN ORDER, and never de-duplicates', async () => {
    // Two identical frames in a row are two rows; a rail that folded them into
    // "2 proposals" would have turned a record into a summary
    // (`design/ai-chat/plan-change-run-live.mock.html` sheet 3). (Lookups are
    // quiet since MOTIR-8158, so the identical frames here are `pass`es.)
    stream.mockImplementationOnce(
      async (
        _jobId: string,
        _signal: AbortSignal,
        _onError: (code: string | null) => void,
        _onDone: () => void,
        onFrame?: (event: string, data: unknown) => void,
      ) => {
        onFrame?.('retrieval', { tool: 'get_item', family: 'plan_tree' });
        onFrame?.('pass', { proposed: 1 });
        onFrame?.('pass', { proposed: 1 });
        onFrame?.('token', { text: 'ignored' });
        onFrame?.('note', { act: 'author', ref: 'MOTIR-1', text: 'billing already owns this' });
        onFrame?.('planned', { proposed: 2 });
      },
    );
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    // The ONE DOOR sends as an ask — whose opening act is `reading` — the ask
    // settles `redirected`, and the plan run narrates from there. So the record
    // is: the read, the hand-off, the frames. `token` is a QUIET decision and
    // leaves no row.
    expect(result.current.state.acts).toEqual([
      { kind: 'reading' },
      { kind: 'redirected' },
      { kind: 'proposed', count: 1 },
      { kind: 'proposed', count: 1 },
      { kind: 'note', text: 'billing already owns this' },
      { kind: 'proposed', count: 2 },
    ]);
    // Settled: the live line clears, the record does NOT — it is what the review
    // block underneath it is a decision about.
    expect(result.current.state.progress).toBeNull();
    expect(result.current.state.phase).toBe('review');
  });

  it('a NEW run starts its record from its own opening act', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    const first = result.current.state.acts.length;
    expect(first).toBeGreaterThan(0);

    await act(async () => {
      await result.current.send('And late fees.');
    });
    // Not `first + n`: the rail is per-RUN.
    expect(result.current.state.acts[0]).toEqual({ kind: 'reading' });
    expect(result.current.state.acts.length).toBeLessThanOrEqual(first);
  });
});

describe('usePlanChangeConversation — a revision lease taken ELSEWHERE reaches the verbs (MOTIR-6151)', () => {
  // The lease is driven from OUTSIDE this surface: nothing the hook does takes it —
  // the review READ is the only thing that changes, exactly as when a second tab,
  // another member or an agent over MCP revises the plan. Every assertion is on the
  // ONE derivation the canvas bar and the rail's review block both render
  // (`planGateView`), so "held" here is what disables both verbs there.
  function gated(gateId: string, heldBy: string | null | undefined): PlanReviewDto {
    return {
      ...REVIEW,
      gate: {
        id: gateId,
        state: 'awaiting',
        stamp: `stamp-${gateId}`,
        held:
          heldBy === undefined
            ? null
            : { reason: 'revision_in_flight', heldBy, expiresAt: '2026-09-25T12:00:00.000Z' },
        canDecide: true,
      },
    };
  }

  const view = (review: PlanReviewDto | null) => planGateView({ review, rewriting: false });

  async function deciding(review: PlanReviewDto) {
    fetchReview.mockResolvedValue(review);
    const hook = await mounted();
    await act(async () => {
      await hook.result.current.send('Add recurring invoices.');
    });
    expect(hook.result.current.state.phase).toBe('review');
    return hook;
  }

  const focus = () =>
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a lease taken elsewhere HOLDS both verbs on focus, and its release frees them again', async () => {
    const { result } = await deciding(gated('gate-focus', undefined));
    expect(view(result.current.state.review).kind).toBe('decide');

    fetchReview.mockResolvedValue(gated('gate-focus', 'Claude Code'));
    focus();
    await waitFor(() =>
      expect(view(result.current.state.review)).toEqual({ kind: 'held', heldBy: 'Claude Code' }),
    );

    fetchReview.mockResolvedValue(gated('gate-focus', undefined));
    focus();
    await waitFor(() => expect(view(result.current.state.review).kind).toBe('decide'));
  });

  it('with no focus at all, the POLL catches the lease within its bound, and the release too', async () => {
    // The clock also advances with real time, so the mount's own `waitFor` still settles;
    // the poll is then stepped explicitly, one bound at a time.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = await deciding(gated('gate-poll', undefined));
    const before = fetchReview.mock.calls.length;

    fetchReview.mockResolvedValue(gated('gate-poll', null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAN_GATE_POLL_MS);
    });
    expect(fetchReview.mock.calls.length).toBeGreaterThan(before);
    expect(view(result.current.state.review)).toEqual({ kind: 'held', heldBy: null });

    fetchReview.mockResolvedValue(gated('gate-poll', undefined));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAN_GATE_POLL_MS);
    });
    expect(view(result.current.state.review).kind).toBe('decide');
  });

  it('a HIDDEN tab skips its ticks — the read waits for the reader to come back', async () => {
    await deciding(gated('gate-hidden', undefined));
    const before = fetchReview.mock.calls.length;
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      focus();
      expect(fetchReview.mock.calls.length).toBe(before);
    } finally {
      visibility.mockRestore();
    }
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(fetchReview.mock.calls.length).toBe(before + 1));
  });

  it('a plan nobody was asked about is not watched — no gate, no read', async () => {
    await deciding(REVIEW);
    const before = fetchReview.mock.calls.length;
    focus();
    expect(fetchReview.mock.calls.length).toBe(before);
  });

  it('a DECIDED plan is not watched, and a read in flight at the decision never lands over it', async () => {
    const { result } = await deciding(gated('gate-decided', undefined));
    const late = deferred<PlanReviewDto>();
    fetchReview.mockReturnValueOnce(late.promise);
    focus();
    await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(2));

    fetchReview.mockResolvedValue(MATERIALIZED_REVIEW);
    await act(async () => {
      await result.current.approve();
    });
    expect(result.current.state.decided).toBe('accepted');
    const decided = result.current.state.review;

    late.resolve(gated('gate-decided', 'Claude Code'));
    await act(async () => {
      await late.promise;
    });
    expect(result.current.state.review).toBe(decided);

    const after = fetchReview.mock.calls.length;
    focus();
    expect(fetchReview.mock.calls.length).toBe(after);
  });

  it('stops watching on unmount', async () => {
    const { unmount } = await deciding(gated('gate-unmount', undefined));
    unmount();
    const before = fetchReview.mock.calls.length;
    focus();
    expect(fetchReview.mock.calls.length).toBe(before);
  });
});

const MATERIALIZED_REVIEW: PlanReviewDto = { ...REVIEW, status: 'approved' };
