// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// THE STOP's client state machine (Story MOTIR-4054 · MOTIR-4068).
//
// The component suite next door asserts what the stopped state RENDERS. This one
// asserts the thing no render can see and that is the actual defect the card
// exists to prevent:
//
//   **a stopped run proposes nothing NEW at the moment it ends, which is exactly
//   the shape the settle path already reads as `EMPTY`.**
//
// So without a `stopping` flag the honest outcome of a deliberate act surfaces as
// a failure banner the user has to dismiss — "a run that lands in a failure state
// and merely renders politely" is the criterion's own words, and this is where it
// is checked. It is asserted on the STORED state (`errorCode`), never on the
// absence of a thrown error.

// ⚠️ THE RUN IS DRIVEN THROUGH THE ANCHORED DOOR, deliberately.
//
// The PROJECT thread's `send` goes through the ONE DOOR (`submitAskTurn` →
// `runAsk`), which may or may not hand off to a plan run — a second settle path
// this card does not touch. The ANCHORED door (`submitContextualPlan` → `run` →
// `finishPlanRun`) reaches the settle under test directly, with no branch in
// between. Same reducer, same stop state, one fewer thing that can be wrong.
const openSession = vi.fn();
const resumeContextual = vi.fn();
const recordPlannerTurn = vi.fn();
const submitContextualPlan = vi.fn();
const stopRun = vi.fn();
const skipCheck = vi.fn();
const streamContextual = vi.fn();
const readPending = vi.fn();

vi.mock('@/lib/planning/planChangeClient', () => ({
  // The resume read answers `{ session, earlier }` (MOTIR-6024); these cases
  // mock the SESSION, so the factory wraps it.
  findResumableSession: async (...a: unknown[]) => ({
    session: await (openSession as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  resumeContextualSession: (...a: unknown[]) => resumeContextual(...a),
  recordPlannerTurn: (...a: unknown[]) => recordPlannerTurn(...a),
  submitContextualPlan: (...a: unknown[]) => submitContextualPlan(...a),
  stopPlanChangeRun: (...a: unknown[]) => stopRun(...a),
  skipPlanFinalCheck: (...a: unknown[]) => skipCheck(...a),
  submitPlanChange: vi.fn(),
  resubmitContextualPlan: vi.fn(),
  submitAskTurn: vi.fn(),
  rerunAskTurn: vi.fn(),
  settleAskJob: vi.fn(),
}));

vi.mock('@/lib/planning/planEditsClient', () => ({
  streamContextualPlanJob: (...a: unknown[]) => streamContextual(...a),
  streamAugmentJob: vi.fn(),
  streamAskJob: vi.fn(),
  PlanEditsClientError: class extends Error {},
  OUT_OF_CREDITS_CODE: 'MOTIR_AI_OUT_OF_CREDITS',
}));

vi.mock('@/lib/planning/planReview', async (orig) => ({
  ...(await orig<typeof import('@/lib/planning/planReview')>()),
  readPendingProposal: (...a: unknown[]) => readPending(...a),
}));

// The run's plan is live-polled while it is written (MOTIR-6295). This suite is
// about the stream, not the poll, so the poll's read never settles: no request
// leaves the process, and the hook aborts it on unmount.
vi.mock('@/lib/planning/planReviewClient', async (orig) => ({
  ...(await orig<typeof import('@/lib/planning/planReviewClient')>()),
  fetchPlanReview: () => new Promise(() => {}),
}));

const { usePlanChangeConversation } = await import('@/lib/hooks/usePlanChangeConversation');

const SESSION = {
  id: 's1',
  projectId: 'p1',
  turnCount: 0,
  targetKeys: [],
  lastJobId: null,
  lastSubmittedAt: null,
  turns: [],
  refs: {},
};

/** Hold the stream OPEN until the test releases it — which is the only way to
 *  observe the interval between the click and the run actually ending. */
function heldStream() {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  streamContextual.mockImplementation(async () => {
    await held;
  });
  return release;
}

/** The anchored target every send below carries. */
const TARGETS = [
  { id: 'wi-1', identifier: 'MOTIR-1', title: 'A card', kind: 'story' },
] as unknown as Parameters<ReturnType<typeof usePlanChangeConversation>['send']>[1] & object[];

async function mounted() {
  const hook = renderHook(() => usePlanChangeConversation({ anchorId: 'wi-1' }));
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

beforeEach(() => {
  vi.clearAllMocks();
  openSession.mockResolvedValue(SESSION);
  resumeContextual.mockResolvedValue(SESSION);
  recordPlannerTurn.mockResolvedValue(SESSION);
  submitContextualPlan.mockResolvedValue({ jobId: 'job-1', planId: 'plan-1', session: SESSION });
  stopRun.mockResolvedValue({ turns: [], stopped: true });
  readPending.mockResolvedValue(null);
  streamContextual.mockResolvedValue(undefined);
});

describe('the stop RAISES, and does not claim the run is over', () => {
  it('sets `stopping` — never `stopped` — while the run is still streaming', async () => {
    const release = heldStream();
    const { result } = await mounted();

    let running!: Promise<void>;
    await act(async () => {
      running = result.current.send('Add a stop control.', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('streaming'));

    await act(async () => {
      await result.current.stop();
    });

    // The click is not the stop. `runWalk` reads the flag at its next PHASE
    // BOUNDARY, so the run is still narrating and the surface must say so.
    expect(result.current.state.stopping).toBe(true);
    expect(result.current.state.stopped).toBe(false);
    expect(result.current.state.phase).toBe('streaming');
    expect(stopRun).toHaveBeenCalledWith('s1', 'job-1', 'stop:job-1');

    await act(async () => {
      release();
      await running;
    });
  });

  it('⚠️ a STOPPED run settles with NO error — the defect this card exists to catch', async () => {
    const release = heldStream();
    const { result } = await mounted();

    let running!: Promise<void>;
    await act(async () => {
      running = result.current.send('Add a stop control.', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('streaming'));
    await act(async () => {
      await result.current.stop();
    });

    // The run ends having proposed nothing new — the shape that reads as `EMPTY`.
    readPending.mockResolvedValue(null);
    await act(async () => {
      release();
      await running;
    });

    expect(result.current.state.stopped).toBe(true);
    expect(result.current.state.stopping).toBe(false);
    // ASSERTED ON THE STORED STATE, per the criterion — not on the absence of a
    // thrown error, because a run that lands in a failure state and merely
    // renders politely would pass that weaker check.
    expect(result.current.state.errorCode).toBeNull();
  });

  it('…and the SAME settle still reports EMPTY when nobody stopped it', async () => {
    // The control for the assertion above. Without this, "no error after a stop"
    // would be satisfied by a build that never reports EMPTY at all.
    const { result } = await mounted();
    readPending.mockResolvedValue(null);

    await act(async () => {
      await result.current.send('Add a stop control.', TARGETS);
    });

    expect(result.current.state.stopped).toBe(false);
    expect(result.current.state.errorCode).toBe('EMPTY');
  });

  it('⚠️ THE PLAN SURVIVES — proposals made before the stop are still reviewable', async () => {
    const release = heldStream();
    const { result } = await mounted();

    let running!: Promise<void>;
    await act(async () => {
      running = result.current.send('Add a stop control.', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('streaming'));
    await act(async () => {
      await result.current.stop();
    });

    // A run stopped AFTER it appended a level: the plan keeps its id and holds
    // what it proposed up to the stop point.
    readPending.mockResolvedValue({ planId: 'plan-1', items: [{ id: 'i1' }] });
    await act(async () => {
      release();
      await running;
    });

    expect(result.current.state.stopped).toBe(true);
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.planId).toBe('plan-1');
    expect(result.current.state.review).toMatchObject({ planId: 'plan-1' });
    expect(result.current.state.errorCode).toBeNull();
  });
});

// MOTIR-11191 — motir-ai now ends the job within seconds of the stop (it aborts the
// author sessions in flight rather than waiting for the phase boundary), so the
// stream ending is the ONLY thing the overlay waits on: the moment it ends, the bar
// goes stopping → stopped, and the plan written before the stop is reviewable.
describe('the overlay follows the run’s end, and nothing else (MOTIR-11191)', () => {
  it('goes stopping → stopped on the stream’s end, with the plan open for Approve or Discard', async () => {
    const release = heldStream();
    const { result } = await mounted();

    let running!: Promise<void>;
    await act(async () => {
      running = result.current.send('Add a stop control.', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('streaming'));
    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.state.stopping).toBe(true);
    expect(result.current.state.stopped).toBe(false);

    // The job ends on the stop: written cards stand, one cut off has its title.
    readPending.mockResolvedValue({ planId: 'plan-1', items: [{ id: 'i1' }, { id: 'i2' }] });
    await act(async () => {
      release();
      await running;
    });

    // No further wait, poll or retry stands between the stream's end and `stopped`.
    expect(result.current.state.stopping).toBe(false);
    expect(result.current.state.stopped).toBe(true);
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toMatchObject({ planId: 'plan-1' });
    expect(result.current.state.errorCode).toBeNull();
    expect(stopRun).toHaveBeenCalledTimes(1);
  });
});

describe('the stop is SAFE where the click is redundant', () => {
  it('does nothing when no run is in flight', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.stop();
    });
    expect(stopRun).not.toHaveBeenCalled();
    expect(result.current.state.stopping).toBe(false);
  });

  it('does not raise a SECOND stop while one is in flight', async () => {
    const release = heldStream();
    const { result } = await mounted();

    let running!: Promise<void>;
    await act(async () => {
      running = result.current.send('Add a stop control.', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('streaming'));

    await act(async () => {
      await result.current.stop();
      await result.current.stop();
      await result.current.stop();
    });

    expect(stopRun).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await running;
    });
  });

  it('an ABORTED raise leaves `stopping` alone — the unmount path, not a failure', async () => {
    const release = heldStream();
    const { result } = await mounted();
    stopRun.mockRejectedValue(new DOMException('gone', 'AbortError'));

    let running!: Promise<void>;
    await act(async () => {
      running = result.current.send('Add a stop control.', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('streaming'));

    await act(async () => {
      await result.current.stop();
    });

    // An abort is what a navigation away produces; it is not the raise failing,
    // so the state is not rewritten to say the click did not land.
    expect(result.current.state.stopping).toBe(true);

    await act(async () => {
      release();
      await running;
    });
  });

  it('a FAILED raise clears `stopping` — the bar must not claim a click that did not land', async () => {
    const release = heldStream();
    const { result } = await mounted();
    stopRun.mockRejectedValue(new Error('network'));

    let running!: Promise<void>;
    await act(async () => {
      running = result.current.send('Add a stop control.', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('streaming'));

    await act(async () => {
      await result.current.stop();
    });

    // Leaving the bar in its stopping state would tell the user the stop landed
    // when it did not, and they would wait instead of clicking again. The run
    // itself is untouched.
    expect(result.current.state.stopping).toBe(false);
    expect(result.current.state.phase).toBe('streaming');

    await act(async () => {
      release();
      await running;
    });
  });
});

describe('the stop state is PER-RUN', () => {
  it('a new run clears a previous run’s stopped state', async () => {
    const { result } = await mounted();

    // Run one, stopped.
    const release = heldStream();
    let first!: Promise<void>;
    await act(async () => {
      first = result.current.send('First.', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('streaming'));
    await act(async () => {
      await result.current.stop();
    });
    await act(async () => {
      release();
      await first;
    });
    expect(result.current.state.stopped).toBe(true);

    // Run two: a fresh run is not a stopped one, and carrying the flag would
    // paint the new run with the previous one's ending.
    streamContextual.mockResolvedValue(undefined);
    await act(async () => {
      await result.current.send('Second.', TARGETS);
    });
    expect(result.current.state.stopped).toBe(false);
    expect(result.current.state.stopping).toBe(false);
  });
});

describe('the SKIP of the final check (MOTIR-11266)', () => {
  it('answers `not_running` with no run in flight, and posts nothing', async () => {
    const { result } = await mounted();
    await expect(result.current.skipFinalCheck()).resolves.toBe('not_running');
    expect(skipCheck).not.toHaveBeenCalled();
  });

  it('posts the running job with a key stable per job, and answers the door’s outcome', async () => {
    const release = heldStream();
    skipCheck.mockResolvedValue({
      outcome: 'skipped',
      mailbox: { turns: [], stopped: false, skipFinalCheck: true },
    });
    const { result } = await mounted();
    let running!: Promise<void>;
    await act(async () => {
      running = result.current.send('Add a stop control.', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('streaming'));

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.skipFinalCheck();
    });
    expect(outcome).toBe('skipped');
    expect(skipCheck).toHaveBeenCalledWith('s1', 'job-1', 'skip-final-check:job-1');
    // A skip ends only the check: the run is neither stopping nor stopped.
    expect(result.current.state.stopping).toBe(false);

    skipCheck.mockRejectedValueOnce(new Error('network'));
    await act(async () => {
      await expect(result.current.skipFinalCheck()).rejects.toThrow('network');
    });

    await act(async () => {
      release();
      await running;
    });
  });
});
