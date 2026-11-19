// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';

// AN ASK TURN'S QUICK REPLY (MOTIR-11797). A message typed in the conversation runs as
// an `ask_project` job, and that job now sends the same `conversation_ack` PART 1 of a
// plan run sends. The hook keeps it by job: the rail draws it as the turn's first
// assistant bubble while the turn is read, takes it down when the answer settles, carries
// it into the plan a redirect hands off to (which sends none of its own), and replays it
// for a viewer who reopens the thread while the turn is still being answered.

const { open, submitAsk, settleAsk, streamAsk, stream, fetchReview } = vi.hoisted(() => ({
  open: vi.fn(),
  submitAsk: vi.fn(),
  settleAsk: vi.fn(),
  streamAsk: vi.fn(),
  stream: vi.fn(),
  fetchReview: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  findResumableSession: async (...a: unknown[]) => ({
    session: await (open as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  appendPlanChangeTurn: vi.fn(),
  submitPlanChange: vi.fn(),
  recordPlannerTurn: vi.fn(),
  resumeContextualSession: vi.fn(),
  submitContextualPlan: vi.fn(),
  resubmitContextualPlan: vi.fn(),
  submitAskTurn: submitAsk,
  rerunAskTurn: vi.fn(),
  settleAskJob: settleAsk,
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return {
    ...actual,
    streamAskJob: streamAsk,
    streamAugmentJob: stream,
    streamContextualPlanJob: vi.fn(),
  };
});

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return { ...actual, fetchPlanReview: fetchReview, fetchPlanReviewSince: fetchReview };
});

import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';
import { askAckFor, reopenedAskAckFor } from '@/lib/planning/planRunPhase';

type Frame = (event: string, data: unknown) => void;
type Done = () => void;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function turn(over: Partial<PlanChangeTurnDto>): PlanChangeTurnDto {
  return {
    id: `t-${over.role ?? 'user'}-${over.jobId ?? 'none'}`,
    seq: 0,
    role: 'user',
    body: 'can the export do CSV?',
    jobId: null,
    question: null,
    isAnswer: false,
    intent: 'ask',
    intentCorrected: false,
    citations: [],
    authorId: 'u1',
    createdAt: '2026-11-19T10:00:00.000Z',
    ...over,
  } as PlanChangeTurnDto;
}

function session(turns: PlanChangeTurnDto[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-11-19T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-11-19T09:00:00.000Z',
    updatedAt: '2026-11-19T10:00:00.000Z',
    turns,
    workItemRefs: {},
  };
}

const ACK = 'You want the export to offer CSV. I’ll look at the project first.';
const ANSWERED = session([
  turn({ jobId: 'ask-1' }),
  turn({ role: 'assistant', jobId: 'ask-1', body: 'It lives in ABC-12.', authorId: null }),
]);

beforeEach(() => {
  open.mockResolvedValue(session([]));
  submitAsk.mockImplementation(async (body: string) => ({
    jobId: 'ask-1',
    turnId: 't0',
    session: session([turn({ body })]),
  }));
  settleAsk.mockResolvedValue({ outcome: 'answered', session: ANSWERED });
  streamAsk.mockImplementation(async () => {});
  stream.mockImplementation(async () => {});
  fetchReview.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** An ask stream held open after it delivered the quick reply. */
function heldAskStream() {
  const held = deferred<void>();
  streamAsk.mockImplementationOnce(
    async (_job: string, _s: AbortSignal, _e: unknown, _d: Done, onFrame: Frame) => {
      onFrame('conversation_ack', { text: `  ${ACK} ` });
      await held.promise;
    },
  );
  return held;
}

describe('a LIVE ask turn', () => {
  it('draws the quick reply while the turn is read, and takes it down when the answer lands', async () => {
    const held = heldAskStream();
    const hook = renderHook(() => usePlanChangeConversation({}));
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));

    let sent!: Promise<void>;
    act(() => {
      sent = hook.result.current.send('can the export do CSV?');
    });
    await waitFor(() => expect(askAckFor(hook.result.current.state)).toBe(ACK));
    expect(hook.result.current.state.conversationAck).toEqual({ jobId: 'ask-1', text: ACK });

    await act(async () => {
      held.resolve();
      await sent;
    });
    expect(hook.result.current.state.phase).toBe('idle');
    expect(askAckFor(hook.result.current.state)).toBeNull();
    // The answered turn is on the thread, so nothing is replayed for it either.
    expect(reopenedAskAckFor(hook.result.current.state, 'ask-1')).toBeNull();
    expect(streamAsk).toHaveBeenCalledTimes(1);
  });

  it('ignores a reply frame with no usable text', async () => {
    streamAsk.mockImplementationOnce(
      async (_job: string, _s: AbortSignal, _e: unknown, _d: Done, onFrame: Frame) => {
        onFrame('conversation_ack', { text: '   ' });
      },
    );
    const hook = renderHook(() => usePlanChangeConversation({}));
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    await act(async () => {
      await hook.result.current.send('can the export do CSV?');
    });
    expect(hook.result.current.state.conversationAck ?? null).toBeNull();
  });

  it('carries the reply into the plan the turn hands off to — one message, one reply', async () => {
    heldAskStream().resolve();
    settleAsk.mockResolvedValueOnce({
      outcome: 'redirected',
      jobId: 'job-plan-1',
      planId: 'plan-1',
      session: ANSWERED,
    });
    const hook = renderHook(() => usePlanChangeConversation({}));
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    await act(async () => {
      await hook.result.current.send('add a CSV export');
    });
    expect(hook.result.current.state.conversationAck).toEqual({ jobId: 'job-plan-1', text: ACK });
  });
});

describe('a REOPENED thread whose last turn is still being answered', () => {
  const OPEN_ASK = session([turn({ jobId: 'ask-9' })]);

  it('replays the ask job for its quick reply, and takes it down when the job ends', async () => {
    open.mockResolvedValue(OPEN_ASK);
    const held = deferred<void>();
    let done!: Done;
    streamAsk.mockImplementationOnce(
      async (_job: string, _s: AbortSignal, _e: unknown, onDone: Done, onFrame: Frame) => {
        done = onDone;
        onFrame('retrieval', { tool: 'get_item' });
        onFrame('conversation_ack', { text: ACK });
        await held.promise;
      },
    );
    const hook = renderHook(() => usePlanChangeConversation({}));

    await waitFor(() => expect(reopenedAskAckFor(hook.result.current.state, 'ask-9')).toBe(ACK));
    expect(streamAsk).toHaveBeenCalledWith(
      'ask-9',
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );

    act(() => done());
    expect(hook.result.current.state.conversationAck ?? null).toBeNull();
    held.resolve();
  });

  it('replays nothing for an answered, ended or plan-change thread', async () => {
    for (const s of [
      ANSWERED,
      { ...OPEN_ASK, endedAt: '2026-11-19T11:00:00.000Z' },
      session([turn({ jobId: 'ask-9', intent: 'plan_change' })]),
    ]) {
      open.mockResolvedValueOnce(s);
      const hook = renderHook(() => usePlanChangeConversation({}));
      await waitFor(() => expect(hook.result.current.state.session).not.toBeNull());
      hook.unmount();
    }
    expect(streamAsk).not.toHaveBeenCalled();
  });

  it('aborts the replay when the viewer leaves', async () => {
    open.mockResolvedValue(OPEN_ASK);
    let signal!: AbortSignal;
    streamAsk.mockImplementationOnce(async (_job: string, s: AbortSignal) => {
      signal = s;
      await new Promise(() => {});
    });
    const hook = renderHook(() => usePlanChangeConversation({}));
    await waitFor(() => expect(streamAsk).toHaveBeenCalled());
    hook.unmount();
    expect(signal.aborted).toBe(true);
  });
});
