// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// THE COMPOSER STAYS LIVE (Story MOTIR-4054 · MOTIR-4274) — the client half of
// the boundary mailbox.
//
// The pipe shipped with MOTIR-4067 and the drawing with MOTIR-4066, and nothing
// connected them: the product wrote to the mailbox from nowhere and the drawn
// queued state rendered nowhere. This is that connection, and the two things it
// has to get right are both invisible when they go wrong:
//
//   1. THE BRANCH. One control, two destinations, chosen by the run's phase. A
//      mid-run turn sent down the SUBMIT path opens a SECOND planning job on a
//      thread that already has one; a between-runs turn sent to the MAILBOX
//      lands in a box nothing will ever check. Neither throws.
//   2. QUEUED IS NOT DELIVERED. The run reads at a phase boundary that can be a
//      whole authoring session away, so a turn that looks delivered and changes
//      nothing for thirty seconds reads as a bug.
//
// ⚠️ RE-POINTED BY MOTIR-7996 (ADR AMENDMENT 4). A mid-run turn no longer goes
// to the mailbox: it is posted to `ask_project` WITH A RUN SNAPSHOT
// (`submitMidRunAskTurn`), streamed and settled on its OWN controller, and the
// mailbox is written only when the settle says `forwarded`. The mailbox still
// carries what is forwarded, so the queued → read poll below is unchanged; what
// changed is the DOOR the turn takes to get there, and that the run's own
// `jobId` / `phase` / `stopping` are untouched while it does.
//
// Driven through the ANCHORED door for the same reason the stop suite is: the
// project thread's `send` goes through the ONE DOOR (`submitAskTurn`), a second
// settle path this card does not touch.

const openSession = vi.fn();
const resumeContextual = vi.fn();
const recordPlannerTurn = vi.fn();
const submitContextualPlan = vi.fn();
const attachMidRunTurn = vi.fn();
const submitMidRunAskTurn = vi.fn();
const settleAskJob = vi.fn();
const streamAskJob = vi.fn();
const peekMailbox = vi.fn();
const stopRun = vi.fn();
const streamContextual = vi.fn();
const readPending = vi.fn();
const readRunPause = vi.fn();
const answerRunPause = vi.fn();

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
  attachMidRunTurn: (...a: unknown[]) => attachMidRunTurn(...a),
  peekMailbox: (...a: unknown[]) => peekMailbox(...a),
  stopPlanChangeRun: (...a: unknown[]) => stopRun(...a),
  submitPlanChange: vi.fn(),
  resubmitContextualPlan: vi.fn(),
  submitAskTurn: vi.fn(),
  rerunAskTurn: vi.fn(),
  submitMidRunAskTurn: (...a: unknown[]) => submitMidRunAskTurn(...a),
  settleAskJob: (...a: unknown[]) => settleAskJob(...a),
  readRunPause: (...a: unknown[]) => readRunPause(...a),
  answerRunPause: (...a: unknown[]) => answerRunPause(...a),
}));

vi.mock('@/lib/planning/planEditsClient', () => ({
  streamContextualPlanJob: (...a: unknown[]) => streamContextual(...a),
  streamAugmentJob: vi.fn(),
  streamAskJob: (...a: unknown[]) => streamAskJob(...a),
  PlanEditsClientError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string | null,
    ) {
      super(`Plan edits request failed (${status})`);
    }
  },
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

type Frame = (event: string, data: unknown) => void;
const { PlanEditsClientError } = await import('@/lib/planning/planEditsClient');

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

const TARGETS = [
  { id: 'wi-1', identifier: 'MOTIR-1', title: 'A card', kind: 'story' },
] as unknown as Parameters<ReturnType<typeof usePlanChangeConversation>['send']>[1];

/** A settle that FORWARDED: the mailbox as it stands, one [id, text] per entry. */
function forwarded(...pairs: Array<[string, string]>) {
  return {
    outcome: 'forwarded' as const,
    delivery: {
      turns: pairs.map(([id, text]) => ({
        id,
        text,
        receivedAt: 'x',
        disposition: 'fold',
        target: null,
      })),
      stopped: false,
    },
    session: SESSION,
  };
}

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

async function mounted() {
  const hook = renderHook(() => usePlanChangeConversation({ anchorId: 'wi-1' }));
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

/** Start a run and leave it streaming. Returns the release + the pending promise.
 *
 *  ⚠️ REAL TIMERS ONLY. `waitFor` polls, and under fake timers it waits on a
 *  clock nobody is advancing while the promise chain it is actually waiting for
 *  resolves on microtasks — which deadlocks. Every fake-timer test below
 *  therefore installs its timers AFTER this helper has returned, never before. */
async function running(hook: Awaited<ReturnType<typeof mounted>>) {
  const release = heldStream();
  let promise!: Promise<void>;
  await act(async () => {
    promise = hook.result.current.send('Add a stop control.', TARGETS);
    await Promise.resolve();
  });
  await waitFor(() => expect(hook.result.current.state.phase).toBe('streaming'));
  return { release, promise };
}

beforeEach(() => {
  vi.clearAllMocks();
  openSession.mockResolvedValue(SESSION);
  resumeContextual.mockResolvedValue(SESSION);
  recordPlannerTurn.mockResolvedValue(SESSION);
  submitContextualPlan.mockResolvedValue({ jobId: 'job-1', planId: 'plan-1', session: SESSION });
  readPending.mockResolvedValue(null);
  streamContextual.mockResolvedValue(undefined);
  submitMidRunAskTurn.mockResolvedValue({ jobId: 'ask-1', turnId: 't1', session: SESSION });
  streamAskJob.mockResolvedValue(undefined);
  settleAskJob.mockResolvedValue(forwarded(['m1', 'Also drop the narration card.']));
  peekMailbox.mockResolvedValue({ turns: [], stopped: false });
  readRunPause.mockResolvedValue(null);
});

describe('THE BRANCH — one control, two destinations, chosen by the phase', () => {
  it('a turn typed DURING a run goes to the ANSWERING session, not the mailbox, and starts no second job', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    submitContextualPlan.mockClear();

    await act(async () => {
      await hook.result.current.send('Also drop the narration card.', TARGETS);
    });

    expect(submitMidRunAskTurn).toHaveBeenCalledTimes(1);
    expect(submitMidRunAskTurn).toHaveBeenCalledWith(
      's1',
      'job-1',
      'plan-1',
      'Also drop the narration card.',
      expect.anything(),
    );
    // The mailbox is written by the SERVER at settle, when the verdict is a
    // change; the browser no longer posts to it.
    expect(attachMidRunTurn).not.toHaveBeenCalled();
    // ⚠️ THE HALF THAT WOULD BE SILENT. A mid-run turn down the submit path opens
    // a SECOND planning job on a thread that already has one — nothing throws,
    // and two runs then race for the same plan.
    expect(submitContextualPlan).not.toHaveBeenCalled();
    // The ask is streamed and settled as ITS OWN job.
    // …with its frames read for the question's quick reply (MOTIR-11797).
    expect(streamAskJob).toHaveBeenCalledWith(
      'ask-1',
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(settleAskJob).toHaveBeenCalledWith('ask-1', expect.anything(), 's1');

    await act(async () => {
      release();
      await promise;
    });
  });

  it('draws the question’s QUICK REPLY in its answering row until the answer settles (MOTIR-11797)', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    let settle!: (v: unknown) => void;
    settleAskJob.mockImplementation(
      () =>
        new Promise((r) => {
          settle = r;
        }),
    );
    streamAskJob.mockImplementation(
      async (_j: string, _s: AbortSignal, _e: unknown, _d: unknown, onFrame: Frame) => {
        // A frame that carries no usable text, and one for another question, change nothing.
        onFrame('conversation_ack', { text: '   ' });
        onFrame('note', { text: 'Reading the plan.' });
        onFrame('conversation_ack', { text: '  You want the narration card dropped.  ' });
      },
    );

    let sent!: Promise<void>;
    act(() => {
      sent = hook.result.current.send('Also drop the narration card.', TARGETS);
    });
    await waitFor(() =>
      expect(hook.result.current.state.midRunAsk).toEqual({
        text: 'Also drop the narration card.',
        ack: 'You want the narration card dropped.',
      }),
    );
    // The planning run is untouched by it.
    expect(hook.result.current.state.jobId).toBe('job-1');

    await act(async () => {
      settle(forwarded(['m1', 'Also drop the narration card.']));
      await sent;
    });
    expect(hook.result.current.state.midRunAsk ?? null).toBeNull();

    await act(async () => {
      release();
      await promise;
    });
  });

  it('keeps the planning run’s jobId, phase and stopping across a mid-run ask', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    // Hold the ask's settle open so the assertions run WHILE it is in flight.
    let finish!: () => void;
    settleAskJob.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ outcome: 'answered', session: SESSION });
        }),
    );

    let sent!: Promise<void>;
    await act(async () => {
      sent = hook.result.current.send('How far along are you?', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(settleAskJob).toHaveBeenCalled());

    expect(hook.result.current.state.jobId).toBe('job-1');
    expect(hook.result.current.state.phase).toBe('streaming');
    expect(hook.result.current.state.stopping).toBe(false);

    // And Stop still raises the stop on the PLANNING job, not on the ask.
    await act(async () => {
      await hook.result.current.stop();
    });
    expect(stopRun).toHaveBeenCalledWith('s1', 'job-1', expect.any(String));

    await act(async () => {
      finish();
      await sent;
    });
    expect(hook.result.current.state.jobId).toBe('job-1');

    await act(async () => {
      release();
      await promise;
    });
  });

  it('an answered question writes nothing into the queue', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    settleAskJob.mockResolvedValue({ outcome: 'answered', session: SESSION });

    await act(async () => {
      await hook.result.current.send('How far along are you?', TARGETS);
    });

    expect(hook.result.current.state.queued).toEqual([]);
    expect(hook.result.current.state.refusedForward).toBeNull();

    await act(async () => {
      release();
      await promise;
    });
  });

  it('⚠️ a forward refused because the run ended sets refusedForward — the words come back', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    settleAskJob.mockResolvedValue({
      outcome: 'forward_refused',
      code: 'PLAN_CHANGE_JOB_NOT_RUNNING',
      jobStatus: 'succeeded',
      text: 'Also drop the narration card.',
      session: SESSION,
    });

    await act(async () => {
      await hook.result.current.send('Also drop the narration card.', TARGETS);
    });

    expect(hook.result.current.state.refusedForward).toEqual({
      text: 'Also drop the narration card.',
      code: 'PLAN_CHANGE_JOB_NOT_RUNNING',
    });
    expect(hook.result.current.state.queued).toEqual([]);

    // The next mid-run send clears it.
    settleAskJob.mockResolvedValue({ outcome: 'answered', session: SESSION });
    await act(async () => {
      await hook.result.current.send('Never mind, how far along?', TARGETS);
    });
    expect(hook.result.current.state.refusedForward).toBeNull();

    await act(async () => {
      release();
      await promise;
    });
  });

  it('a turn typed BETWEEN runs still takes the shipped submit path, unchanged', async () => {
    // The regression this card is most likely to cause, so it is asserted rather
    // than assumed: the other silent failure is a turn landing in a mailbox
    // nothing will ever check.
    const hook = await mounted();

    await act(async () => {
      await hook.result.current.send('Add a stop control.', TARGETS);
    });

    expect(submitContextualPlan).toHaveBeenCalledTimes(1);
    expect(attachMidRunTurn).not.toHaveBeenCalled();
  });

  it('submits each mid-run send as its own ask — a new sentence is never a replay', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    submitMidRunAskTurn
      .mockResolvedValueOnce({ jobId: 'ask-1', turnId: 't1', session: SESSION })
      .mockResolvedValueOnce({ jobId: 'ask-2', turnId: 't2', session: SESSION });

    await act(async () => {
      await hook.result.current.send('First thing.', TARGETS);
    });
    await act(async () => {
      await hook.result.current.send('Second thing.', TARGETS);
    });

    // The forward's idempotency is the SERVER's (`forward:<ask job id>`), keyed on
    // the ask job each send produced — so two sentences are two jobs.
    expect(settleAskJob.mock.calls.map((c) => c[0])).toEqual(['ask-1', 'ask-2']);

    await act(async () => {
      release();
      await promise;
    });
  });

  it('does not send an empty turn down either path', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);

    await act(async () => {
      await hook.result.current.send('   \n ', TARGETS);
    });

    expect(attachMidRunTurn).not.toHaveBeenCalled();
    expect(submitMidRunAskTurn).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await promise;
    });
  });
});

describe('QUEUED is not DELIVERED', () => {
  it('records what the door says is waiting, unread', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);

    await act(async () => {
      await hook.result.current.send('Also drop the narration card.', TARGETS);
    });

    expect(hook.result.current.state.queued).toEqual([
      { id: 'm1', text: 'Also drop the narration card.', read: false },
    ]);

    await act(async () => {
      release();
      await promise;
    });
  });

  it('takes the WHOLE pending set from the answer, not a local append', async () => {
    // The door answers with the mailbox as it stands, which keeps the count right
    // when the run consumed something between two sends — a local append would
    // show a turn that is already gone.
    const hook = await mounted();
    const { release, promise } = await running(hook);

    settleAskJob.mockResolvedValue(forwarded(['m1', 'one'], ['m2', 'two']));
    await act(async () => {
      await hook.result.current.send('two', TARGETS);
    });

    expect(hook.result.current.state.queued.map((t) => t.id)).toEqual(['m1', 'm2']);

    await act(async () => {
      release();
      await promise;
    });
  });

  it('⚠️ flips to READ when the turn leaves the pending set — the TRANSITION', async () => {
    // There is no push for this: `motir-ai` consumes at a boundary and emits no
    // frame, and its `MailboxReport` never reaches motir-core. Absence from the
    // pending set IS the evidence, which is why the client asks.
    const hook = await mounted();
    const { release, promise } = await running(hook);
    vi.useFakeTimers();
    try {
      await act(async () => {
        await hook.result.current.send('Also drop the narration card.', TARGETS);
      });
      expect(hook.result.current.state.queued[0]!.read).toBe(false);

      // The run took it: the pending set no longer holds it.
      peekMailbox.mockResolvedValue({ turns: [], stopped: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });

      const [turn] = hook.result.current.state.queued;
      expect(turn!.read).toBe(true);
      // NOT removed. The transcript is a record, and the turn the run took is
      // exactly the one worth still seeing.
      expect(turn!.text).toBe('Also drop the narration card.');

      await act(async () => {
        release();
        await promise;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays UNREAD while the turn is still waiting', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    vi.useFakeTimers();
    try {
      await act(async () => {
        await hook.result.current.send('Also drop the narration card.', TARGETS);
      });

      peekMailbox.mockResolvedValue({
        turns: [
          {
            id: 'm1',
            text: 'Also drop the narration card.',
            receivedAt: 'x',
            disposition: 'fold',
            target: null,
          },
        ],
        stopped: false,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6200);
      });

      expect(hook.result.current.state.queued[0]!.read).toBe(false);

      await act(async () => {
        release();
        await promise;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('⚠️ asks NOTHING on an ordinary run — the poll is bounded by its own condition', async () => {
    // The property that makes a poll acceptable here. Nobody typed anything, so
    // there is nothing unread and no request is made at all.
    const hook = await mounted();
    const { release, promise } = await running(hook);
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(peekMailbox).not.toHaveBeenCalled();

      await act(async () => {
        release();
        await promise;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops asking once everything queued has been read', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    vi.useFakeTimers();
    try {
      await act(async () => {
        await hook.result.current.send('Also drop the narration card.', TARGETS);
      });

      peekMailbox.mockResolvedValue({ turns: [], stopped: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      const afterRead = peekMailbox.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      // The LAST READ stops it, not a timeout.
      expect(peekMailbox.mock.calls.length).toBe(afterRead);

      await act(async () => {
        release();
        await promise;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('the queue is per-RUN — a new run starts with an empty one', async () => {
    const hook = await mounted();
    const first = await running(hook);
    await act(async () => {
      await hook.result.current.send('Also drop the narration card.', TARGETS);
    });
    expect(hook.result.current.state.queued).toHaveLength(1);
    await act(async () => {
      first.release();
      await first.promise;
    });

    streamContextual.mockResolvedValue(undefined);
    await act(async () => {
      await hook.result.current.send('A whole new request.', TARGETS);
    });

    // Carrying them over would show the user sentences that can never be read
    // again — the previous job's mailbox is not this one's.
    expect(hook.result.current.state.queued).toEqual([]);
  });
});

describe('A REFUSAL IS LEGIBLE', () => {
  it('an UNTYPED failure still says something — `MAILBOX_FAILED`, not silence', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    submitMidRunAskTurn.mockRejectedValue(new Error('network'));

    await act(async () => {
      await hook.result.current.send('Also drop it.', TARGETS);
    });

    expect(hook.result.current.state.errorCode).toBe('MAILBOX_FAILED');
    expect(hook.result.current.state.queued).toEqual([]);
    expect(hook.result.current.state.phase).toBe('streaming');

    await act(async () => {
      release();
      await promise;
    });
  });

  it('an ABORTED send is not an error — nothing is written', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    submitMidRunAskTurn.mockRejectedValue(new DOMException('gone', 'AbortError'));

    await act(async () => {
      await hook.result.current.send('Also drop it.', TARGETS);
    });

    expect(hook.result.current.state.errorCode).toBeNull();
    expect(hook.result.current.state.queued).toEqual([]);

    await act(async () => {
      release();
      await promise;
    });
  });

  it('surfaces the door’s typed code when the run settled between render and send', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    submitMidRunAskTurn.mockRejectedValue(
      new PlanEditsClientError(409, 'PLAN_CHANGE_JOB_NOT_RUNNING'),
    );

    await act(async () => {
      await hook.result.current.send('Too late.', TARGETS);
    });

    expect(hook.result.current.state.errorCode).toBe('PLAN_CHANGE_JOB_NOT_RUNNING');
    // The THREAD is untouched: a state conflict on one turn is not a failure of
    // the conversation, and nothing queued was invented.
    expect(hook.result.current.state.queued).toEqual([]);
    expect(hook.result.current.state.phase).toBe('streaming');

    await act(async () => {
      release();
      await promise;
    });
  });
});

// ── The rest of the mid-run send's branches (MOTIR-7990's coverage floor) ─────
//
// Each case below is an outcome the rail draws differently, and every one of them
// is silent when it goes wrong: a failed ask stream that still settles, a stale
// settle that rolls the thread back, a reply to the planner's question that is
// given a verdict instead, and a send after the rail unmounted that writes state.

/** An `unclear` pause the planner posted on `job-1`, unanswered. */
const OPEN_UNCLEAR = {
  id: 'pause-1',
  jobId: 'job-1',
  kind: 'unclear' as const,
  changeTurnIds: [],
  reason: null,
  question: 'Which billing card do you mean?',
  createdAt: 'x',
  answer: null,
  answeredAt: null,
  replyText: null,
  delivery: 'pending' as const,
  refusedCode: null,
  mailboxEntryId: null,
};

describe('the mid-run ask — the outcomes the rail draws', () => {
  it('a turn typed while the planner’s UNCLEAR question is open is its ANSWER — the pause door, never a verdict', async () => {
    submitContextualPlan.mockResolvedValue({
      jobId: 'job-1',
      planId: 'plan-1',
      session: { ...SESSION, runPause: OPEN_UNCLEAR },
    });
    answerRunPause.mockResolvedValue({
      outcome: 'answered',
      pause: { ...OPEN_UNCLEAR, answer: 'replied', replyText: 'The billing one.' },
      delivery: {
        turns: [
          {
            id: 'm9',
            text: 'The billing one.',
            receivedAt: 'x',
            disposition: 'fold',
            target: null,
          },
        ],
        stopped: false,
      },
    });
    const hook = await mounted();
    const { release, promise } = await running(hook);

    await act(async () => {
      await hook.result.current.send('The billing one.', TARGETS);
    });

    expect(answerRunPause).toHaveBeenCalledWith(
      's1',
      'job-1',
      'pause-1',
      'reply',
      'The billing one.',
    );
    // Not the answering session, and no ask record is drawn for it.
    expect(submitMidRunAskTurn).not.toHaveBeenCalled();
    expect(hook.result.current.state.midRunAsk ?? null).toBeNull();
    expect(hook.result.current.state.queued).toEqual([
      { id: 'm9', text: 'The billing one.', read: false },
    ]);

    await act(async () => {
      release();
      await promise;
    });
  });

  it('a change revised into the FINISHED run’s plan sets lateRevision (MOTIR-7997)', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    settleAskJob.mockResolvedValue({
      outcome: 'revised_late',
      planId: 'plan-1',
      revisionJobId: 'rev-1',
      text: 'Also drop it.',
      session: SESSION,
    });

    await act(async () => {
      await hook.result.current.send('Also drop it.', TARGETS);
    });

    expect(hook.result.current.state.lateRevision).toEqual({
      planId: 'plan-1',
      revisionJobId: 'rev-1',
      count: 1,
    });
    expect(hook.result.current.state.midRunAsk ?? null).toBeNull();

    await act(async () => {
      release();
      await promise;
    });
  });

  it('⚠️ a FAILED ask stream shows its code and is never settled — the run’s phase is untouched', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    streamAskJob.mockImplementation(async (_job, _signal, onError: (c: string | null) => void) => {
      onError('ASK_FAILED');
    });

    await act(async () => {
      await hook.result.current.send('How far along?', TARGETS);
    });

    expect(hook.result.current.state.errorCode).toBe('ASK_FAILED');
    expect(settleAskJob).not.toHaveBeenCalled();
    expect(hook.result.current.state.phase).toBe('streaming');
    expect(hook.result.current.state.jobId).toBe('job-1');

    await act(async () => {
      release();
      await promise;
    });
  });

  it('an UNCODED stream failure still says something — FAILED', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    streamAskJob.mockImplementation(async (_job, _signal, onError: (c: string | null) => void) => {
      onError(null);
    });

    await act(async () => {
      await hook.result.current.send('How far along?', TARGETS);
    });

    expect(hook.result.current.state.errorCode).toBe('FAILED');
    expect(settleAskJob).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await promise;
    });
  });

  it('an OUT-OF-CREDITS stream failure is the credit gate, not an error banner', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);
    streamAskJob.mockImplementation(async (_job, _signal, onError: (c: string | null) => void) => {
      onError('MOTIR_AI_OUT_OF_CREDITS');
    });

    await act(async () => {
      await hook.result.current.send('How far along?', TARGETS);
    });

    expect(hook.result.current.state.outOfCredits).toBe(true);
    expect(hook.result.current.state.errorCode).toBeNull();
    expect(settleAskJob).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await promise;
    });
  });

  it('⚠️ a slow settle carrying an OLDER session never rolls the thread back — a newer one is adopted', async () => {
    const held = { ...SESSION, turnCount: 5 };
    submitContextualPlan.mockResolvedValue({ jobId: 'job-1', planId: 'plan-1', session: held });
    const hook = await mounted();
    const { release, promise } = await running(hook);
    // Turns only grow: the ask's copy of the thread is behind the rail's.
    submitMidRunAskTurn.mockResolvedValue({ jobId: 'ask-1', turnId: 't1', session: SESSION });
    settleAskJob.mockResolvedValue({ outcome: 'answered', session: SESSION });

    await act(async () => {
      await hook.result.current.send('How far along?', TARGETS);
    });
    expect(hook.result.current.state.session?.turnCount).toBe(5);

    // A copy AHEAD of the rail's is the newer write, and replaces it.
    settleAskJob.mockResolvedValue({ outcome: 'answered', session: { ...SESSION, turnCount: 7 } });
    await act(async () => {
      await hook.result.current.send('And now?', TARGETS);
    });
    expect(hook.result.current.state.session?.turnCount).toBe(7);

    await act(async () => {
      release();
      await promise;
    });
  });

  it('a send made before the run has its job id goes nowhere — it cannot be addressed', async () => {
    // Busy from the click: the submit is in flight, the phase is `streaming`, and
    // there is no job to address the turn at yet.
    let resolveSubmit!: (v: unknown) => void;
    submitContextualPlan.mockImplementation(
      () =>
        new Promise((r) => {
          resolveSubmit = r;
        }),
    );
    const hook = await mounted();
    let first!: Promise<void>;
    await act(async () => {
      first = hook.result.current.send('Add a stop control.', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.state.phase).toBe('streaming'));
    expect(hook.result.current.state.jobId).toBeNull();

    await act(async () => {
      await hook.result.current.send('Also this.', TARGETS);
    });
    expect(submitMidRunAskTurn).not.toHaveBeenCalled();
    expect(attachMidRunTurn).not.toHaveBeenCalled();

    await act(async () => {
      resolveSubmit({ jobId: 'job-1', planId: 'plan-1', session: SESSION });
      await first;
    });
  });
});

describe('the mid-run ask after the rail UNMOUNTED writes nothing', () => {
  it('after the ask submit resolves — the ask is never streamed', async () => {
    let open!: () => void;
    submitMidRunAskTurn.mockImplementation(
      () =>
        new Promise((r) => {
          open = () => r({ jobId: 'ask-1', turnId: 't1', session: SESSION });
        }),
    );
    const hook = await mounted();
    const { release, promise } = await running(hook);
    let sent!: Promise<void>;
    await act(async () => {
      sent = hook.result.current.send('How far along?', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(submitMidRunAskTurn).toHaveBeenCalled());
    hook.unmount();
    await act(async () => {
      open();
      await sent;
      release();
      await promise;
    });
    expect(streamAskJob).not.toHaveBeenCalled();
  });

  it('after the ask stream fails', async () => {
    let fail!: () => void;
    streamAskJob.mockImplementation(
      (_job, _signal, onError: (c: string | null) => void) =>
        new Promise<void>((r) => {
          fail = () => {
            onError('ASK_FAILED');
            r();
          };
        }),
    );
    const hook = await mounted();
    const { release, promise } = await running(hook);
    let sent!: Promise<void>;
    await act(async () => {
      sent = hook.result.current.send('How far along?', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(streamAskJob).toHaveBeenCalled());
    hook.unmount();
    await act(async () => {
      fail();
      await sent;
      release();
      await promise;
    });
    expect(settleAskJob).not.toHaveBeenCalled();
  });

  it('after the ask stream ends cleanly — the settle is never asked', async () => {
    let end!: () => void;
    streamAskJob.mockImplementation(
      () =>
        new Promise<void>((r) => {
          end = r;
        }),
    );
    const hook = await mounted();
    const { release, promise } = await running(hook);
    let sent!: Promise<void>;
    await act(async () => {
      sent = hook.result.current.send('How far along?', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(streamAskJob).toHaveBeenCalled());
    hook.unmount();
    await act(async () => {
      end();
      await sent;
      release();
      await promise;
    });
    expect(settleAskJob).not.toHaveBeenCalled();
  });

  it('after the settle resolves, and after the submit rejects', async () => {
    let settle!: () => void;
    settleAskJob.mockImplementation(
      () =>
        new Promise((r) => {
          settle = () => r({ outcome: 'answered', session: SESSION });
        }),
    );
    const hook = await mounted();
    const { release, promise } = await running(hook);
    let sent!: Promise<void>;
    await act(async () => {
      sent = hook.result.current.send('How far along?', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(settleAskJob).toHaveBeenCalled());
    hook.unmount();
    await act(async () => {
      settle();
      await sent;
      release();
      await promise;
    });

    let reject!: () => void;
    submitMidRunAskTurn.mockImplementation(
      () =>
        new Promise((_r, rej) => {
          reject = () => rej(new Error('network'));
        }),
    );
    const second = await mounted();
    const run2 = await running(second);
    let sent2!: Promise<void>;
    await act(async () => {
      sent2 = second.result.current.send('How far along?', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(submitMidRunAskTurn).toHaveBeenCalled());
    second.unmount();
    await act(async () => {
      reject();
      await sent2;
      run2.release();
      await run2.promise;
    });
  });
});

describe('a run with NO plan id still queues to the MAILBOX (the pre-AMENDMENT-4 door)', () => {
  // A streaming job that is not a planning run (no `planId`) has no answering
  // session to route through, so the turn is attached to the job's mailbox as it
  // always was — never dropped, never a second job.
  beforeEach(() => {
    submitContextualPlan.mockResolvedValue({ jobId: 'job-1', session: SESSION });
  });

  it('attaches the turn, keyed per send, and records the pending set', async () => {
    attachMidRunTurn.mockResolvedValue({
      turns: [{ id: 'm1', text: 'Also this.', receivedAt: 'x', disposition: 'fold', target: null }],
      stopped: false,
    });
    const hook = await mounted();
    const { release, promise } = await running(hook);
    expect(hook.result.current.state.planId).toBeNull();

    await act(async () => {
      await hook.result.current.send('Also this.', TARGETS);
    });

    expect(submitMidRunAskTurn).not.toHaveBeenCalled();
    expect(attachMidRunTurn).toHaveBeenCalledWith(
      's1',
      'job-1',
      'Also this.',
      expect.stringMatching(/^turn:job-1:/),
    );
    expect(hook.result.current.state.queued).toEqual([
      { id: 'm1', text: 'Also this.', read: false },
    ]);

    await act(async () => {
      release();
      await promise;
    });
  });

  it('surfaces the door’s typed code, says MAILBOX_FAILED for an untyped one, and ignores an abort', async () => {
    const hook = await mounted();
    const { release, promise } = await running(hook);

    attachMidRunTurn.mockRejectedValueOnce(
      new PlanEditsClientError(409, 'PLAN_CHANGE_JOB_NOT_RUNNING'),
    );
    await act(async () => {
      await hook.result.current.send('Too late.', TARGETS);
    });
    expect(hook.result.current.state.errorCode).toBe('PLAN_CHANGE_JOB_NOT_RUNNING');

    attachMidRunTurn.mockRejectedValueOnce(new Error('network'));
    await act(async () => {
      await hook.result.current.send('Again.', TARGETS);
    });
    expect(hook.result.current.state.errorCode).toBe('MAILBOX_FAILED');

    attachMidRunTurn.mockRejectedValueOnce(new DOMException('gone', 'AbortError'));
    await act(async () => {
      await hook.result.current.send('Once more.', TARGETS);
    });
    // The abort changed nothing — the last error stands, nothing was queued.
    expect(hook.result.current.state.errorCode).toBe('MAILBOX_FAILED');
    expect(hook.result.current.state.queued).toEqual([]);
    expect(hook.result.current.state.phase).toBe('streaming');

    await act(async () => {
      release();
      await promise;
    });
  });

  it('writes nothing once the rail has unmounted — on success or on failure', async () => {
    let answer!: (ok: boolean) => void;
    attachMidRunTurn.mockImplementation(
      () =>
        new Promise((res, rej) => {
          answer = (ok) => (ok ? res({ turns: [], stopped: false }) : rej(new Error('network')));
        }),
    );
    for (const ok of [true, false]) {
      const hook = await mounted();
      const { release, promise } = await running(hook);
      let sent!: Promise<void>;
      await act(async () => {
        sent = hook.result.current.send('Also this.', TARGETS);
        await Promise.resolve();
      });
      await waitFor(() => expect(attachMidRunTurn).toHaveBeenCalled());
      hook.unmount();
      await act(async () => {
        answer(ok);
        await sent;
        release();
        await promise;
      });
      attachMidRunTurn.mockClear();
    }
  });
});
