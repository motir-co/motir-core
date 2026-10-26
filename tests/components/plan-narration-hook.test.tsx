// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// THE NARRATION IN THE HOOK (Story MOTIR-8060 · MOTIR-8064): `state.narration` is
// the stored read the hook already makes — replaced whole on every review read,
// a decided plan's one poll read included — and the earlier pages the panel asks
// for are kept beside it by `seq`, untouched by a later poll, dropped when the
// plan changes. The transport is mocked; the hook's state is what is under test.

const { getNamed, fetchReview, fetchPage } = vi.hoisted(() => ({
  getNamed: vi.fn(),
  fetchReview: vi.fn(),
  fetchPage: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  findResumableSession: vi.fn(),
  getPlanChangeSession: getNamed,
  resumeContextualSession: vi.fn(),
  submitContextualPlan: vi.fn(),
  submitAskTurn: vi.fn(),
  settleAskJob: vi.fn(),
}));

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return { ...actual, fetchPlanReview: fetchReview, fetchPlanNarrationPage: fetchPage };
});

import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';
import { planReview, planReviewItem } from '../helpers/planReview';
import { narrationEntry, narrationRead, narrationSession } from '../helpers/planNarration';

function namedSession(pendingPlanId: string): PlanChangeSessionDto {
  return {
    id: 's9',
    projectId: 'p1',
    targetKeys: [],
    turnCount: 0,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-09T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-10-09T09:00:00.000Z',
    updatedAt: '2026-10-09T10:00:00.000Z',
    turns: [],
    workItemRefs: {},
    pendingPlanId,
  };
}

const LAY = narrationSession('s-lay', 'lay', 'Session handling');

beforeEach(() => {
  for (const fn of [getNamed, fetchReview, fetchPage]) fn.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usePlanChangeConversation — state.narration', () => {
  it('a reopened DECIDED plan still carries its narration, nothing live', async () => {
    const read = narrationRead([LAY], [narrationEntry(1, 's-lay', 'Laid out.')]);
    getNamed.mockResolvedValue(namedSession('plan_1'));
    fetchReview.mockResolvedValue(
      planReview([planReviewItem()], { status: 'approved', narration: read }),
    );
    const { result } = renderHook(() => usePlanChangeConversation({ sessionId: 's9' }));
    await waitFor(() => expect(result.current.state.narration).toEqual(read));
    expect(result.current.state.narrationKept).toMatchObject({ planId: 'plan_1', live: [] });
  });

  it('a pending proposal’s read carries it too', async () => {
    const read = narrationRead([LAY], [narrationEntry(1, 's-lay', 'Proposed.')]);
    getNamed.mockResolvedValue(namedSession('plan_1'));
    fetchReview.mockResolvedValue(planReview([planReviewItem()], { narration: read }));
    const { result } = renderHook(() => usePlanChangeConversation({ sessionId: 's9' }));
    await waitFor(() => expect(result.current.state.review).not.toBeNull());
    await waitFor(() => expect(result.current.state.narration).toEqual(read));
  });

  it('a generating plan: live sessions from its in-flight steps; earlier pages survive the next poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const step = {
      sessionKey: 's-lay',
      kind: 'lay' as const,
      targetRef: 'r',
      startedAt: 'x',
      providerWait: null,
    };
    const first = narrationRead([LAY], [narrationEntry(3, 's-lay', 'three')]);
    const later = narrationRead(
      [LAY],
      [narrationEntry(4, 's-lay', 'four'), narrationEntry(5, 's-lay', 'five')],
    );
    getNamed.mockResolvedValue(namedSession('plan_1'));
    fetchReview.mockResolvedValue(
      planReview([], { status: 'generating', inFlightSteps: [step], narration: first }),
    );
    const { result } = renderHook(() => usePlanChangeConversation({ sessionId: 's9' }));
    await waitFor(() => expect(result.current.state.narration).toEqual(first));
    expect(result.current.state.narrationKept?.live).toEqual(['s-lay']);

    fetchPage.mockResolvedValue({
      entries: [narrationEntry(1, 's-lay', 'one'), narrationEntry(2, 's-lay', 'two')],
      earlierCount: 0,
    });
    await act(async () => {
      await result.current.showEarlierNarration();
    });
    expect(fetchPage).toHaveBeenCalledWith('plan_1', 3);
    expect(result.current.state.narrationKept?.earlier.map((e) => e.seq)).toEqual([1, 2, 3]);

    // The next poll moves the window past seq 3: nothing kept is lost.
    fetchReview.mockResolvedValue(
      planReview([], { status: 'generating', inFlightSteps: [step], narration: later }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });
    await waitFor(() => expect(result.current.state.narration).toEqual(later));
    expect(result.current.state.narrationKept?.earlier.map((e) => e.seq)).toEqual([1, 2, 3]);

    // Nothing earlier than seq 1: a further press asks for nothing.
    fetchPage.mockClear();
    await act(async () => {
      await result.current.showEarlierNarration();
    });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('a failed earlier page leaves the panel as it was', async () => {
    const read = narrationRead([LAY], [narrationEntry(5, 's-lay', 'five')]);
    getNamed.mockResolvedValue(namedSession('plan_1'));
    fetchReview.mockResolvedValue(planReview([planReviewItem()], { narration: read }));
    const { result } = renderHook(() => usePlanChangeConversation({ sessionId: 's9' }));
    await waitFor(() => expect(result.current.state.narration).toEqual(read));
    fetchPage.mockRejectedValue(new Error('500'));
    await act(async () => {
      await result.current.showEarlierNarration();
    });
    expect(result.current.state.narrationKept).toMatchObject({
      earlier: [],
      loadingEarlier: false,
    });
  });
});
