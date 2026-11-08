// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import { planReview } from '../helpers/planReview';
import { conversationAckFor, planRunPhase } from '@/lib/planning/planRunPhase';

// THE CONVERSATION PHASE ENDS AT `target_settled` (MOTIR-8203). A plan job carries
// its plan id from the submit, but PART 1 — settling the target, the entry and the
// requirement, and perhaps asking a question — runs inside that same job. So the hook
// records which job has settled, from the frame itself, and `planRunPhase` answers
// `conversation` until it arrives. A REOPENED overlay settles from the replay of the
// run's frames, so it agrees with a live viewer.

const {
  open,
  getSession,
  submit,
  stream,
  fetchReview,
  record,
  submitAsk,
  settleAsk,
  streamAsk,
  streamAnchored,
  jobOver,
} = vi.hoisted(() => ({
  open: vi.fn(),
  getSession: vi.fn(),
  submit: vi.fn(),
  stream: vi.fn(),
  fetchReview: vi.fn(),
  record: vi.fn(),
  submitAsk: vi.fn(),
  settleAsk: vi.fn(),
  streamAsk: vi.fn(),
  streamAnchored: vi.fn(),
  jobOver: vi.fn(),
}));

// The job-status read the adoption asks first (MOTIR-10453). Unreadable (`null`) unless
// a case says otherwise, which adopts as before the read existed.
vi.mock('@/lib/planning/jobStatusClient', () => ({ isJobOver: jobOver }));

vi.mock('@/lib/planning/planChangeClient', () => ({
  findResumableSession: async (...a: unknown[]) => ({
    session: await (open as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  getPlanChangeSession: getSession,
  appendPlanChangeTurn: vi.fn(),
  submitPlanChange: submit,
  recordPlannerTurn: record,
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
    streamAugmentJob: stream,
    streamAskJob: streamAsk,
    streamContextualPlanJob: streamAnchored,
  };
});

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    fetchPlanReview: fetchReview,
    fetchPlanReviewSince: fetchReview,
  };
});

import {
  settledFirstTargetKey,
  usePlanChangeConversation,
} from '@/lib/hooks/usePlanChangeConversation';

type Frame = (event: string, data: unknown) => void;

function turn(
  role: PlanChangeTurnDto['role'],
  body: string,
  extra: Partial<PlanChangeTurnDto> = {},
) {
  return {
    id: `t-${role}-${body}`,
    seq: 1,
    role,
    body,
    jobId: role === 'user' ? null : 'job-1',
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-10-11T10:00:00.000Z',
    ...extra,
  } satisfies PlanChangeTurnDto;
}

function session(over: Partial<PlanChangeSessionDto> = {}): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: 0,
    lastJobId: 'job-1',
    lastSubmittedAt: '2026-10-11T10:00:00.000Z',
    lastActivityAt: '2026-10-11T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-10-11T09:00:00.000Z',
    updatedAt: '2026-10-11T10:00:00.000Z',
    turns: [],
    workItemRefs: {},
    ...over,
  };
}

/** A stream the test drives frame by frame, and ends when it says so. */
function heldStream() {
  let emit: Frame = () => {};
  let end: () => void = () => {};
  const impl = vi.fn(
    (_job: string, _signal: AbortSignal, _onError: unknown, _onDone: unknown, onFrame: Frame) =>
      new Promise<void>((resolve) => {
        emit = onFrame;
        end = resolve;
      }),
  );
  return {
    impl,
    emit: (event: string, data: unknown = {}) => act(() => emit(event, data)),
    end: () => act(async () => end()),
  };
}

beforeEach(() => {
  jobOver.mockReset().mockResolvedValue(null);
  open.mockResolvedValue(session());
  record.mockResolvedValue(session());
  fetchReview.mockResolvedValue(null);
  submitAsk.mockImplementation(async (body: string) => ({
    jobId: 'ask-1',
    turnId: 't0',
    session: session({ turns: [turn('user', body)] }),
  }));
  // The ask READS the turn as a plan change and hands off to plan job `job-1`,
  // whose plan exists from the submit.
  settleAsk.mockResolvedValue({
    outcome: 'redirected',
    jobId: 'job-1',
    planId: 'plan-1',
    session: session({ turns: [turn('user', 'add payments')] }),
  });
  streamAsk.mockImplementation(async () => {});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('a LIVE plan run', () => {
  it('is in its conversation phase until `target_settled`, then planning', async () => {
    const run = heldStream();
    stream.mockImplementation(run.impl);
    const hook = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));

    let sent!: Promise<void>;
    act(() => {
      sent = hook.result.current.send('add payments');
    });
    await waitFor(() => expect(run.impl).toHaveBeenCalled());
    expect(hook.result.current.state.planId).toBe('plan-1');
    expect(planRunPhase(hook.result.current.state)).toBe('conversation');

    // PART 1 is still talking: no settlement yet.
    run.emit('conversation', { seq: 1 });
    run.emit('target_read', { seq: 2 });
    expect(planRunPhase(hook.result.current.state)).toBe('conversation');

    run.emit('target_settled', { seq: 3, key: 'ACME-1', entry: 'lay' });
    expect(hook.result.current.state.settledJobId).toBe('job-1');
    expect(planRunPhase(hook.result.current.state)).toBe('planning');
    // The settled card is what a project-launched surface follows (MOTIR-10739).
    expect(hook.result.current.state.settledTargetKey).toBe('ACME-1');

    await run.end();
    await act(async () => sent);
    expect(planRunPhase(hook.result.current.state)).toBeNull();
  });

  it('keeps the job’s `conversation_ack` while it converses, and drops it at `target_settled` (MOTIR-10738)', async () => {
    const run = heldStream();
    stream.mockImplementation(run.impl);
    const hook = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));

    let sent!: Promise<void>;
    act(() => {
      sent = hook.result.current.send('add payments');
    });
    await waitFor(() => expect(run.impl).toHaveBeenCalled());
    expect(conversationAckFor(hook.result.current.state)).toBeNull();

    // A frame with no usable text is ignored.
    run.emit('conversation_ack', { seq: 1, text: '   ' });
    expect(hook.result.current.state.conversationAck).toBeNull();

    run.emit('conversation_ack', { seq: 2, text: '  You want payments. I’ll look first.  ' });
    expect(hook.result.current.state.conversationAck).toEqual({
      jobId: 'job-1',
      text: 'You want payments. I’ll look first.',
    });
    expect(conversationAckFor(hook.result.current.state)).toBe(
      'You want payments. I’ll look first.',
    );

    run.emit('target_settled', { seq: 3 });
    expect(conversationAckFor(hook.result.current.state)).toBeNull();

    await run.end();
    await act(async () => sent);
  });

  it('keeps the FIRST settled target when a run settles several, and none for a new card (MOTIR-10739)', async () => {
    const run = heldStream();
    stream.mockImplementation(run.impl);
    const hook = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    expect(hook.result.current.state.settledTargetKey).toBeNull();

    let sent!: Promise<void>;
    act(() => {
      sent = hook.result.current.send('add payments');
    });
    await waitFor(() => expect(run.impl).toHaveBeenCalled());

    // A run that starts a NEW card settles no key: there is nowhere to follow.
    run.emit('target_settled', { seq: 1, key: null, index: 0, of: 1 });
    expect(hook.result.current.state.settledJobId).toBe('job-1');
    expect(hook.result.current.state.settledTargetKey).toBeNull();

    // Each further target settles just before its walk; only index 0 is followed.
    run.emit('target_settled', { seq: 2, key: 'ACME-4', index: 0, of: 2 });
    run.emit('target_settled', { seq: 3, key: 'ACME-9', index: 1, of: 2 });
    expect(hook.result.current.state.settledTargetKey).toBe('ACME-4');

    await run.end();
    await act(async () => sent);
    // Kept after the run: the canvas has already been asked to move there once.
    expect(hook.result.current.state.settledTargetKey).toBe('ACME-4');
  });

  it('a job that comes back with a QUESTION never reaches the planning phase', async () => {
    const run = heldStream();
    stream.mockImplementation(run.impl);
    record.mockResolvedValue(
      session({
        turns: [
          turn('user', 'add payments'),
          turn('assistant', 'Which?', { question: 'Incoming or outgoing?' }),
        ],
      }),
    );
    const hook = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));

    let sent!: Promise<void>;
    act(() => {
      sent = hook.result.current.send('add payments');
    });
    await waitFor(() => expect(run.impl).toHaveBeenCalled());
    run.emit('conversation', { seq: 1 });
    expect(planRunPhase(hook.result.current.state)).toBe('conversation');

    await run.end();
    await act(async () => sent);
    expect(hook.result.current.state.settledJobId).toBeNull();
    expect(planRunPhase(hook.result.current.state)).toBeNull();
  });
});

describe('settledFirstTargetKey — the card a `target_settled` frame hands the surface (MOTIR-10739)', () => {
  it('reads the key of a one-target frame and of index 0, and nothing else', () => {
    expect(settledFirstTargetKey({ key: 'ACME-1' })).toBe('ACME-1');
    expect(settledFirstTargetKey({ key: 'ACME-1', index: 0, of: 3 })).toBe('ACME-1');
    expect(settledFirstTargetKey({ key: 'ACME-2', index: 1, of: 3 })).toBeNull();
    expect(settledFirstTargetKey({ key: null, index: 0 })).toBeNull();
    expect(settledFirstTargetKey({ key: '  ' })).toBeNull();
    expect(settledFirstTargetKey({})).toBeNull();
    expect(settledFirstTargetKey(null)).toBeNull();
  });

  it('answers null for a revise run’s settled PROPOSAL — no work item carries its ref', () => {
    // motir-ai's revise handler names a proposal target `planItem:<ref>` with
    // `proposal: true`; an anchor read for it could only be refused.
    expect(
      settledFirstTargetKey({ key: 'planItem:pi_7', proposal: true, index: 0, of: 1 }),
    ).toBeNull();
    expect(settledFirstTargetKey({ key: 'planItem:pi_7', index: 0 })).toBeNull();
    expect(settledFirstTargetKey({ key: 'ACME-3', proposal: true })).toBeNull();
  });
});

describe('a REOPENED overlay mid-run', () => {
  const generating = planReview([], {
    id: 'plan-1',
    status: 'generating',
    authorSource: 'native',
    plannedAt: null,
  });

  beforeEach(() => {
    getSession.mockResolvedValue(session({ pendingPlanId: 'plan-1', lastJobId: 'job-1' }));
    fetchReview.mockResolvedValue(generating);
  });

  // A READ-ONLY viewer only watches the run (bug MOTIR-10428): a viewer who may plan
  // ADOPTS it instead, and the adopted stream settles it (the next case).
  it('a read-only viewer settles from the replay of the run’s frames, and closes the replay once it has it', async () => {
    getSession.mockResolvedValue(
      session({ pendingPlanId: 'plan-1', lastJobId: 'job-1', viewerCanPlan: false }),
    );
    const replay = heldStream();
    stream.mockImplementation(replay.impl);
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));

    await waitFor(() => expect(hook.result.current.state.liveReview?.status).toBe('generating'));
    expect(planRunPhase(hook.result.current.state)).toBe('conversation');
    await waitFor(() => expect(replay.impl).toHaveBeenCalled());
    expect(replay.impl.mock.calls[0]![0]).toBe('job-1');

    replay.emit('conversation', { seq: 1 });
    expect(planRunPhase(hook.result.current.state)).toBe('conversation');
    replay.emit('target_settled', { seq: 2, key: 'ACME-7', index: 0, of: 1 });
    expect(hook.result.current.state.settledJobId).toBe('job-1');
    expect(planRunPhase(hook.result.current.state)).toBe('planning');
    // The replay settles the target the surface follows too (MOTIR-10739).
    expect(hook.result.current.state.settledTargetKey).toBe('ACME-7');
    // The replay is read for that one frame and no further.
    const signal = replay.impl.mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect(replay.impl).toHaveBeenCalledTimes(1);
  });

  it('a read-only viewer reads the run’s `conversation_ack` from the same replay (MOTIR-10738)', async () => {
    getSession.mockResolvedValue(
      session({ pendingPlanId: 'plan-1', lastJobId: 'job-1', viewerCanPlan: false }),
    );
    const replay = heldStream();
    stream.mockImplementation(replay.impl);
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));

    await waitFor(() => expect(replay.impl).toHaveBeenCalled());
    replay.emit('conversation_ack', { seq: 1, text: 42 });
    expect(hook.result.current.state.conversationAck).toBeNull();
    replay.emit('conversation_ack', { seq: 2, text: 'You want payments.' });
    expect(conversationAckFor(hook.result.current.state)).toBe('You want payments.');
    // The ack does not close the replay: it is still waiting for the settle.
    const signal = replay.impl.mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    replay.emit('target_settled', { seq: 3 });
    expect(signal.aborted).toBe(true);
    expect(conversationAckFor(hook.result.current.state)).toBeNull();
  });

  it('a viewer who may plan ADOPTS the run, and the adopted stream settles its phase', async () => {
    const adopted = heldStream();
    stream.mockImplementation(adopted.impl);
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));

    await waitFor(() => expect(hook.result.current.state.phase).toBe('streaming'));
    expect(hook.result.current.state.jobId).toBe('job-1');
    expect(hook.result.current.state.planId).toBe('plan-1');
    // ONE subscription: the adoption's — no replay beside it.
    expect(adopted.impl).toHaveBeenCalledTimes(1);
    expect(adopted.impl.mock.calls[0]![0]).toBe('job-1');
    // The plan on screen is kept, and nothing claims this screen sent a turn.
    expect(hook.result.current.state.liveReview?.status).toBe('generating');
    expect(hook.result.current.state.acts).toEqual([]);
    expect(planRunPhase(hook.result.current.state)).toBe('conversation');

    adopted.emit('target_settled', { seq: 1 });
    expect(planRunPhase(hook.result.current.state)).toBe('planning');
    adopted.emit('status', { status: 'succeeded' });
    await adopted.end();
    await waitFor(() => expect(hook.result.current.state.phase).not.toBe('streaming'));
    expect(adopted.impl).toHaveBeenCalledTimes(1);
  });

  // THE JOB IT ADOPTED WAS ALREADY OVER (the nightly on 2083799). A session can read as
  // writing its plan with no job running: a job that ended with nothing proposed leaves
  // its empty plan `generating` until the abandoned-plan sweep closes it.
  it('a run that ASKED is over: its question is not adopted, so the answer stays an answer', async () => {
    getSession.mockResolvedValue(
      session({
        pendingPlanId: 'plan-1',
        lastJobId: 'job-1',
        turns: [
          turn('user', 'Split this story.'),
          turn('assistant', 'One thing first.', { question: 'Own subtask?' }),
        ],
      }),
    );
    const replay = heldStream();
    stream.mockImplementation(replay.impl);
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));

    await waitFor(() => expect(hook.result.current.state.liveReview?.status).toBe('generating'));
    await act(async () => {});
    expect(hook.result.current.state.phase).toBe('idle');
    expect(hook.result.current.state.jobId).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });

  it('a run whose planner turn is already on the thread is over, so it is not adopted', async () => {
    getSession.mockResolvedValue(
      session({
        pendingPlanId: 'plan-1',
        lastJobId: 'job-1',
        turns: [
          turn('user', 'plan this'),
          turn('assistant', 'Planning that now.', { jobId: 'job-1' }),
        ],
      }),
    );
    const replay = heldStream();
    stream.mockImplementation(replay.impl);
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));

    await waitFor(() => expect(hook.result.current.state.liveReview?.status).toBe('generating'));
    await act(async () => {});
    expect(hook.result.current.state.phase).toBe('idle');
    expect(hook.result.current.state.jobId).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });

  it('a job its status read says has ENDED is not adopted: the screen replays it instead', async () => {
    jobOver.mockResolvedValue(true);
    const replay = heldStream();
    stream.mockImplementation(replay.impl);
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));

    await waitFor(() => expect(jobOver).toHaveBeenCalledWith('job-1', expect.anything()));
    // Not adopted: no run, so a turn sent now takes the ordinary door.
    await waitFor(() => expect(replay.impl).toHaveBeenCalled());
    expect(hook.result.current.state.phase).toBe('idle');
    expect(hook.result.current.state.jobId).toBeNull();
    // The replay is the read-only one: it reads `target_settled` and settles nothing.
    replay.emit('target_settled', { seq: 1 });
    expect(hook.result.current.state.settledJobId).toBe('job-1');
    expect(record).not.toHaveBeenCalled();
  });

  it('a job still RUNNING by its status read is adopted', async () => {
    jobOver.mockResolvedValue(false);
    const adopted = heldStream();
    stream.mockImplementation(adopted.impl);
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));

    await waitFor(() => expect(hook.result.current.state.phase).toBe('streaming'));
    expect(hook.result.current.state.jobId).toBe('job-1');
  });

  it('a planner turn from an EARLIER job does not stop the running one being adopted', async () => {
    getSession.mockResolvedValue(
      session({
        pendingPlanId: 'plan-1',
        lastJobId: 'job-1',
        turns: [
          turn('user', 'plan this'),
          turn('assistant', 'Done with the last one.', { jobId: 'job-0' }),
          turn('user', 'and this'),
        ],
      }),
    );
    const adopted = heldStream();
    stream.mockImplementation(adopted.impl);
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));

    await waitFor(() => expect(hook.result.current.state.phase).toBe('streaming'));
    expect(hook.result.current.state.jobId).toBe('job-1');
  });

  it('an adopted run that turns out to be over goes back to watching the plan', async () => {
    const adopted = heldStream();
    stream.mockImplementation(adopted.impl);
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));

    await waitFor(() => expect(hook.result.current.state.phase).toBe('streaming'));
    adopted.emit('status', { status: 'succeeded' });
    await adopted.end();

    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    // The plan still reads `generating`, so the screen still says so, and it is not an
    // error on a screen that sent nothing.
    expect(hook.result.current.state.liveReview?.status).toBe('generating');
    expect(hook.result.current.state.errorCode).toBeNull();
    // Once per job: going back to watching does not adopt it again.
    await act(async () => {});
    expect(adopted.impl).toHaveBeenCalledTimes(1);
  });

  it('an adopted run STOPPED under the screen reads as stopped, not as still writing', async () => {
    const adopted = heldStream();
    stream.mockImplementation(adopted.impl);
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));

    await waitFor(() => expect(hook.result.current.state.phase).toBe('streaming'));
    adopted.emit('status', { status: 'canceled' });
    await adopted.end();

    await waitFor(() => expect(hook.result.current.state.stopped).toBe(true));
    expect(hook.result.current.state.liveReview).toBeNull();
  });

  it('an ANCHORED overlay adopts the run through the item’s own relay', async () => {
    streamAnchored.mockImplementation(async () => {});
    const hook = renderHook(() =>
      usePlanChangeConversation({ sessionId: 's1', anchorId: 'item-1' }),
    );

    await waitFor(() => expect(streamAnchored).toHaveBeenCalled());
    expect(streamAnchored.mock.calls[0]!.slice(0, 2)).toEqual(['item-1', 'job-1']);
    expect(stream).not.toHaveBeenCalled();
    await waitFor(() => expect(hook.result.current.state.phase).not.toBe('streaming'));
  });

  it('a plan an agent writes over MCP opens no replay: it has no conversation phase', async () => {
    fetchReview.mockResolvedValue({ ...generating, authorSource: 'mcp' });
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));

    await waitFor(() => expect(hook.result.current.state.liveReview?.status).toBe('generating'));
    expect(planRunPhase(hook.result.current.state)).toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });
});
