// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type {
  PlanAnswerOfferDto,
  PlanChangeSessionDto,
  PlanChangeTurnDto,
} from '@/lib/dto/planChange';

// THE PLAN OFFER's two answers, as the overlay's state machine follows them (Story
// MOTIR-9219 · MOTIR-9294). The doors decide what a press does; these cases pin what
// the hook does with their answers:
//
//   * one post per press, with the in-flight turn id set while it is out;
//   * the conversation is REFETCHED after both answers — the refetched offer is what
//     flips the row, never the answer's body;
//   * a confirm landing on another conversation swaps the overlay onto it and tells
//     the host, then follows the run it started;
//   * a refusal is recorded on the offer's turn, in the row's own code;
//   * a confirm stops only the run that was in flight when it was pressed, never a
//     turn sent while its door is out (MOTIR-9409).

const { open, readSession, answerOffer, stream, fetchReview, submitAsk } = vi.hoisted(() => ({
  open: vi.fn(),
  submitAsk: vi.fn(),
  readSession: vi.fn(),
  answerOffer: vi.fn(),
  stream: vi.fn(),
  fetchReview: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  findResumableSession: async (...a: unknown[]) => ({
    session: await (open as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  getPlanChangeSession: readSession,
  answerPlanOffer: answerOffer,
  requestRestartConfirm: vi.fn(),
  answerRestart: vi.fn(),
  startCopiedSession: vi.fn(),
  resumeContextualSession: vi.fn(async () => ({ session: null, planId: null })),
  submitContextualPlan: vi.fn(),
  resubmitContextualPlan: vi.fn(),
  submitAskTurn: submitAsk,
  rerunAskTurn: vi.fn(),
  settleAskJob: vi.fn(),
  submitPlanChange: vi.fn(),
  recordPlannerTurn: vi.fn(),
  attachMidRunTurn: vi.fn(),
  peekMailbox: vi.fn(),
  stopPlanChangeRun: vi.fn(),
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return { ...actual, streamAugmentJob: stream };
});

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return { ...actual, fetchPlanReview: fetchReview };
});

import {
  offerRefusalCodeOf,
  usePlanChangeConversation,
} from '@/lib/hooks/usePlanChangeConversation';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';

function offer(extra: Partial<PlanAnswerOfferDto> = {}): PlanAnswerOfferDto {
  return {
    kind: 'plan',
    requestMd: 'Add a CSV export.',
    targetKey: null,
    declinedAt: null,
    declinedById: null,
    confirmedAt: null,
    confirmedById: null,
    confirmedSessionId: null,
    state: 'undecided',
    cannotStart: null,
    ...extra,
  };
}

function turns(o: PlanAnswerOfferDto): PlanChangeTurnDto[] {
  const base = {
    jobId: null,
    question: null,
    confirm: null,
    intent: null,
    intentCorrected: false,
    citations: [],
    createdAt: '2026-10-22T10:00:00.000Z',
  };
  return [
    { ...base, id: 't0', seq: 0, role: 'user', body: 'Export?', isAnswer: false, authorId: 'u1' },
    {
      ...base,
      id: 't1',
      seq: 1,
      role: 'assistant',
      body: 'Nightly.',
      isAnswer: true,
      authorId: null,
      offer: o,
    },
  ];
}

function session(id: string, o: PlanAnswerOfferDto): PlanChangeSessionDto {
  const t = turns(o);
  return {
    id,
    projectId: 'p1',
    targetKeys: [],
    turnCount: t.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-22T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-10-22T09:00:00.000Z',
    updatedAt: '2026-10-22T10:00:00.000Z',
    turns: t,
    workItemRefs: {},
  };
}

const OPEN = session('s1', offer());

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  open.mockResolvedValue(OPEN);
  stream.mockImplementation(async () => {});
  fetchReview.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mounted(onRestarted = vi.fn()) {
  const hook = renderHook(() => usePlanChangeConversation({ onRestarted }));
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return { ...hook, onRestarted };
}

describe('Decline', () => {
  it('posts once, holds the turn in flight, then adopts the refetched session', async () => {
    const pending = deferred<PlanChangeSessionDto>();
    answerOffer.mockReturnValue(pending.promise);
    const declined = session('s1', offer({ state: 'declined', declinedAt: '2026-10-22T10:01Z' }));
    readSession.mockResolvedValue(declined);
    const { result } = await mounted();

    await act(async () => {
      void result.current.declinePlanOffer('t1');
      void result.current.declinePlanOffer('t1');
    });
    expect(answerOffer).toHaveBeenCalledTimes(1);
    expect(answerOffer).toHaveBeenCalledWith('s1', 't1', 'decline');
    expect(result.current.state.offerAnsweringTurnId).toBe('t1');

    // The answer's body is NOT the state: the refetch is.
    await act(async () => pending.resolve(OPEN));
    await waitFor(() => expect(result.current.state.offerAnsweringTurnId).toBeNull());
    expect(readSession).toHaveBeenCalledWith('s1');
    expect(result.current.state.session?.turns[1]?.offer?.state).toBe('declined');
  });
});

describe('Confirm', () => {
  it('on the same conversation: refetches and follows the run it started', async () => {
    answerOffer.mockResolvedValue({ sessionId: 's1', jobId: 'job-7', planId: 'plan-7' });
    readSession.mockResolvedValue(
      session('s1', offer({ state: 'confirmed', confirmedSessionId: 's1' })),
    );
    const { result, onRestarted } = await mounted();

    await act(async () => {
      await result.current.confirmPlanOffer('t1');
    });
    expect(answerOffer).toHaveBeenCalledWith('s1', 't1', 'confirm');
    expect(readSession).toHaveBeenCalledWith('s1');
    await waitFor(() => expect(stream).toHaveBeenCalled());
    expect(stream.mock.calls[0]![0]).toBe('job-7');
    expect(result.current.state.session?.turns[1]?.offer?.state).toBe('confirmed');
    expect(onRestarted).not.toHaveBeenCalled();
  });

  it('landing on ANOTHER conversation swaps the overlay onto it and tells the host', async () => {
    answerOffer.mockResolvedValue({ sessionId: 's2', jobId: 'job-8', planId: 'plan-8' });
    const other = { ...session('s2', offer()), targetKeys: ['ACME-40'], turns: [] };
    readSession.mockResolvedValue(other);
    const { result, onRestarted } = await mounted();

    await act(async () => {
      await result.current.confirmPlanOffer('t1');
    });
    expect(readSession).toHaveBeenCalledWith('s2');
    expect(result.current.state.session?.id).toBe('s2');
    expect(onRestarted).toHaveBeenCalledWith('s2');
    await waitFor(() => expect(stream).toHaveBeenCalled());
    expect(stream.mock.calls[0]![0]).toBe('job-8');
  });

  it('a log_bug offer adopts the landed thread and follows no run (MOTIR-9324)', async () => {
    const landed = session('s1', offer({ kind: 'log_bug', state: 'confirmed' }));
    answerOffer.mockResolvedValue({
      kind: 'log_bug',
      sessionId: 's1',
      landing: { outcome: 'diagnose', workItemKey: 'ACME-41', title: 'x', createdInTriage: false },
      session: landed,
    });
    const { result } = await mounted();

    await act(async () => {
      await result.current.confirmPlanOffer('t1');
    });
    expect(answerOffer).toHaveBeenCalledWith('s1', 't1', 'confirm');
    expect(readSession).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(result.current.state.session?.turns[1]?.offer?.state).toBe('confirmed');
    expect(result.current.state.offerAnsweringTurnId).toBeNull();
  });

  it('a refused bug landing records the door code on the offer', async () => {
    answerOffer.mockRejectedValue(
      new PlanEditsClientError(409, 'DEBUG_TARGET_CHANGED', { code: 'DEBUG_TARGET_CHANGED' }),
    );
    const { result } = await mounted();

    await act(async () => {
      await result.current.confirmPlanOffer('t1');
    });
    expect(result.current.state.offerRefusal).toEqual({
      turnId: 't1',
      code: 'DEBUG_TARGET_CHANGED',
    });
  });

  it('a refused start records its reason on the offer and clears the in-flight id', async () => {
    answerOffer.mockRejectedValue(
      new PlanEditsClientError(409, 'PLAN_OFFER_START_REFUSED', {
        code: 'PLAN_OFFER_START_REFUSED',
        reason: 'target_not_available',
      }),
    );
    const { result } = await mounted();

    await act(async () => {
      await result.current.confirmPlanOffer('t1');
    });
    expect(result.current.state.offerRefusal).toEqual({
      turnId: 't1',
      code: 'target_not_available',
    });
    expect(result.current.state.offerAnsweringTurnId).toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  it('a turn sent while the door is out is not aborted (MOTIR-9409)', async () => {
    const door = deferred<{ sessionId: string; jobId: string; planId: string }>();
    answerOffer.mockReturnValue(door.promise);
    readSession.mockResolvedValue(
      session('s1', offer({ state: 'confirmed', confirmedSessionId: 's1' })),
    );
    const signals: AbortSignal[] = [];
    submitAsk.mockImplementation((_body: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const { result } = await mounted();

    let confirming!: Promise<void>;
    await act(async () => {
      confirming = result.current.confirmPlanOffer('t1');
    });
    await act(async () => {
      void result.current.send('yes, plan it');
    });
    await waitFor(() => expect(signals).toHaveLength(1));

    await act(async () => {
      door.resolve({ sessionId: 's1', jobId: 'job-7', planId: 'plan-7' });
      await confirming;
    });
    await waitFor(() => expect(stream).toHaveBeenCalled());
    expect(signals[0]!.aborted).toBe(false);
  });

  it('a mid-planning confirm still stops the run in flight when it was pressed', async () => {
    answerOffer.mockResolvedValue({ sessionId: 's1', jobId: 'job-7', planId: 'plan-7' });
    readSession.mockResolvedValue(
      session('s1', offer({ state: 'confirmed', confirmedSessionId: 's1' })),
    );
    const signals: AbortSignal[] = [];
    submitAsk.mockImplementation((_body: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const { result } = await mounted();

    await act(async () => {
      void result.current.send('plan the digest');
    });
    await waitFor(() => expect(signals).toHaveLength(1));
    await act(async () => {
      await result.current.confirmPlanOffer('t1');
    });
    expect(signals[0]!.aborted).toBe(true);
    await waitFor(() => expect(stream).toHaveBeenCalled());
  });

  it('does nothing on a read-only or ended conversation', async () => {
    open.mockResolvedValue({ ...OPEN, endedAt: '2026-10-22T11:00:00.000Z', endReason: 'idle' });
    const { result } = await mounted();
    await act(async () => {
      await result.current.confirmPlanOffer('t1');
      await result.current.declinePlanOffer('t1');
    });
    expect(answerOffer).not.toHaveBeenCalled();
  });
});

describe('the refusal code', () => {
  it('reads out of credits, then the refused reason, then the door code', () => {
    expect(offerRefusalCodeOf(new PlanEditsClientError(402, 'MOTIR_AI_OUT_OF_CREDITS'))).toBe(
      'MOTIR_AI_OUT_OF_CREDITS',
    );
    expect(
      offerRefusalCodeOf(
        new PlanEditsClientError(409, 'PLAN_OFFER_START_REFUSED', { reason: 'already_planning' }),
      ),
    ).toBe('already_planning');
    expect(offerRefusalCodeOf(new PlanEditsClientError(409, 'PLAN_OFFER_NOT_OPEN'))).toBe(
      'PLAN_OFFER_NOT_OPEN',
    );
    expect(offerRefusalCodeOf(new Error('boom'))).toBe('FAILED');
  });
});
