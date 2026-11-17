// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// A FOLLOW-UP ON AN ANCHORED THREAD WHOSE PLAN WAITS (Bug MOTIR-11488). Once the
// anchored door has proposed a plan, the next message is NOT a rewrite of it: `send`
// takes the ask door (`submitAskTurn` on the held session), and the settle decides —
// an answer leaves the proposal on the canvas and decidable; a `redirected` settle (the
// planner's revision) streams through the ITEM's relay, as the anchored door's runs do.
// The contextual submit is never called for the follow-up.

const {
  openSession,
  resumeContextual,
  submitContextualPlan,
  submitAsk,
  rerunAsk,
  settleAsk,
  streamAsk,
  streamContextual,
  streamAugment,
  fetchReview,
  approveRequest,
} = vi.hoisted(() => ({
  openSession: vi.fn(),
  resumeContextual: vi.fn(),
  submitContextualPlan: vi.fn(),
  submitAsk: vi.fn(),
  rerunAsk: vi.fn(),
  settleAsk: vi.fn(),
  streamAsk: vi.fn(),
  streamContextual: vi.fn(),
  streamAugment: vi.fn(),
  fetchReview: vi.fn(),
  approveRequest: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  findResumableSession: async (...a: unknown[]) => ({
    session: await (openSession as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  resumeContextualSession: (...a: unknown[]) => resumeContextual(...a),
  recordPlannerTurn: vi.fn(async () => SESSION),
  submitContextualPlan: (...a: unknown[]) => submitContextualPlan(...a),
  resubmitContextualPlan: vi.fn(),
  submitPlanChange: vi.fn(),
  submitAskTurn: (...a: unknown[]) => submitAsk(...a),
  rerunAskTurn: (...a: unknown[]) => rerunAsk(...a),
  settleAskJob: (...a: unknown[]) => settleAsk(...a),
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return {
    ...actual,
    streamAskJob: (...a: unknown[]) => streamAsk(...a),
    streamAugmentJob: (...a: unknown[]) => streamAugment(...a),
    streamContextualPlanJob: (...a: unknown[]) => streamContextual(...a),
  };
});

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    fetchPlanReview: (...a: unknown[]) => fetchReview(...a),
    approvePlanRequest: (...a: unknown[]) => approveRequest(...a),
  };
});

import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';
import { planReview, planReviewItem } from '../helpers/planReview';

const SESSION = {
  id: 's1',
  projectId: 'p1',
  turnCount: 1,
  targetKeys: ['MOTIR-1'],
  lastJobId: null,
  lastSubmittedAt: null,
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  origin: 'conversation',
  createdAt: '2026-08-20T09:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
  turns: [],
  workItemRefs: {},
} as unknown as PlanChangeSessionDto;

const REVIEW = planReview([
  planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'task', title: 'CSV writer' }),
]);

const TARGETS = [
  { id: 'wi-1', identifier: 'MOTIR-1', title: 'A card', kind: 'story' },
] as unknown as Parameters<ReturnType<typeof usePlanChangeConversation>['send']>[1] & object[];

beforeEach(() => {
  openSession.mockResolvedValue(null);
  resumeContextual.mockResolvedValue(null);
  submitContextualPlan.mockResolvedValue({ jobId: 'job-1', planId: 'plan-1', session: SESSION });
  streamContextual.mockResolvedValue(undefined);
  streamAugment.mockResolvedValue(undefined);
  streamAsk.mockResolvedValue(undefined);
  fetchReview.mockResolvedValue(REVIEW);
  submitAsk.mockResolvedValue({ jobId: 'ask-1', turnId: 't1', session: SESSION });
  settleAsk.mockResolvedValue({ outcome: 'answered', session: SESSION });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Mount on an anchored item and let its first send propose a plan that waits. */
async function withWaitingPlan() {
  const hook = renderHook(() => usePlanChangeConversation({ anchorId: 'wi-1' }));
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  await act(async () => {
    await hook.result.current.send('Fix the export', TARGETS);
  });
  await waitFor(() => expect(hook.result.current.state.phase).toBe('review'));
  expect(hook.result.current.state.review?.status).toBe('planned');
  expect(submitContextualPlan).toHaveBeenCalledTimes(1);
  submitContextualPlan.mockClear();
  return hook;
}

describe('a follow-up while the anchored plan waits', () => {
  it('goes to the ask door on the held session, and an ANSWER leaves the plan decidable', async () => {
    const { result } = await withWaitingPlan();

    await act(async () => {
      await result.current.send('why a new card?', TARGETS);
    });

    expect(submitContextualPlan).not.toHaveBeenCalled();
    expect(submitAsk).toHaveBeenCalledTimes(1);
    expect(submitAsk.mock.calls[0]![0]).toBe('why a new card?');
    expect(submitAsk.mock.calls[0]![2]).toBe(false);
    expect(submitAsk.mock.calls[0]![3]).toBe('s1');
    expect(settleAsk).toHaveBeenCalledWith('ask-1', expect.anything(), 's1');
    await waitFor(() => expect(result.current.state.phase).toBe('review'));
    expect(result.current.state.review?.id).toBe(REVIEW.id);
    expect(streamContextual).toHaveBeenCalledTimes(1);
  });

  it('an ANSWER keeps the plan in hand, so Approve after it posts to that plan', async () => {
    const { result } = await withWaitingPlan();
    const planId = result.current.state.planId;
    expect(planId).toBeTruthy();

    await act(async () => {
      await result.current.send('also plan a billing epic', TARGETS);
    });
    await waitFor(() => expect(result.current.state.phase).toBe('review'));
    expect(result.current.state.planId).toBe(planId);

    approveRequest.mockRejectedValueOnce(new Error('stop here'));
    await act(async () => {
      await result.current.approve();
    });
    expect(approveRequest).toHaveBeenCalledTimes(1);
    expect(approveRequest.mock.calls[0]![0]).toBe(planId);
  });

  it("streams the planner's REVISION through the item's relay when the settle redirects", async () => {
    const { result } = await withWaitingPlan();
    settleAsk.mockResolvedValueOnce({
      outcome: 'redirected',
      jobId: 'job-rev',
      planId: REVIEW.id,
      session: SESSION,
    });

    await act(async () => {
      await result.current.send('drop the csv thing', TARGETS);
    });

    expect(submitContextualPlan).not.toHaveBeenCalled();
    expect(streamContextual).toHaveBeenCalledTimes(2);
    expect(streamContextual.mock.calls[1]![0]).toBe('wi-1');
    expect(streamContextual.mock.calls[1]![1]).toBe('job-rev');
    expect(streamAugment).not.toHaveBeenCalled();
  });

  it('a failed ask retries the same turn through the ask door, not the contextual submit', async () => {
    const { result } = await withWaitingPlan();
    streamAsk.mockImplementationOnce(async (_job: string, _s: AbortSignal, onError) => {
      (onError as (code: string | null) => void)('BOOM');
    });

    await act(async () => {
      await result.current.send('why a new card?', TARGETS);
    });
    await waitFor(() => expect(result.current.state.errorCode).toBe('BOOM'));
    rerunAsk.mockResolvedValueOnce({ jobId: 'ask-2', turnId: 't1', session: SESSION });

    await act(async () => {
      await result.current.retry();
    });

    expect(rerunAsk).toHaveBeenCalledTimes(1);
    expect(rerunAsk.mock.calls[0]![0]).toBe('t1');
    expect(submitContextualPlan).not.toHaveBeenCalled();
  });

  it('a send with NO waiting plan keeps the anchored contextual submit', async () => {
    fetchReview.mockResolvedValue(null);
    const hook = renderHook(() => usePlanChangeConversation({ anchorId: 'wi-1' }));
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));

    await act(async () => {
      await hook.result.current.send('Fix the export', TARGETS);
    });
    await act(async () => {
      await hook.result.current.send('and the PDF', TARGETS);
    });

    expect(submitContextualPlan).toHaveBeenCalledTimes(2);
    expect(submitAsk).not.toHaveBeenCalled();
  });
});
