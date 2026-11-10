// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// The ASK half of the conversation loop (MOTIR-1343 · gated by MOTIR-1822) —
// the arms `use-plan-change-conversation.test.tsx` does not reach because its
// settle DEFAULTS to a redirect, which walks the shipped plan-change tail.
//
// What lives here is everything that happens when the door does something OTHER
// than hand back a plan change: an answer, a job that said nothing, a stream
// that failed, the correction re-run, and the redirect that arrives BEFORE any
// stream (a reply to the planner's pending question, which skips the classifier
// because the affordance already settled the disposition).

const { open, submitAsk, rerunAsk, settleAsk, streamAsk, stream, fetchReview } = vi.hoisted(() => ({
  open: vi.fn(),
  submitAsk: vi.fn(),
  rerunAsk: vi.fn(),
  settleAsk: vi.fn(),
  streamAsk: vi.fn(),
  stream: vi.fn(),
  fetchReview: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  // The resume read answers `{ session, earlier }` (MOTIR-6024); these cases
  // mock the SESSION, so the factory wraps it.
  findResumableSession: async (...a: unknown[]) => ({
    session: await (open as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  appendPlanChangeTurn: vi.fn(),
  submitPlanChange: vi.fn(),
  recordPlannerTurn: vi.fn(async () => session(['x'])),
  resumeContextualSession: vi.fn(),
  submitContextualPlan: vi.fn(),
  resubmitContextualPlan: vi.fn(),
  submitAskTurn: submitAsk,
  rerunAskTurn: rerunAsk,
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
  return { ...actual, fetchPlanReview: fetchReview };
});

import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';
import { consumeStream, PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { planReview, planReviewItem } from '../helpers/planReview';

/** A promise a test resolves by hand — how a run is held mid-flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const REVIEW = planReview([
  planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'Recurring' }),
]);

/** Put a PENDING PROPOSAL on the canvas, the way the product does: a turn that
 *  redirected at the door, whose plan read back non-empty. */
async function withPendingProposal() {
  submitAsk.mockResolvedValueOnce({
    outcome: 'redirected',
    jobId: 'job-augment-1',
    planId: 'plan-1',
    session: ANSWERED,
  });
  fetchReview.mockResolvedValueOnce(REVIEW);
  const hook = await mounted();
  await act(async () => {
    await hook.result.current.send('add recurring invoices');
  });
  expect(hook.result.current.state.phase).toBe('review');
  return hook;
}

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
    createdAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    turns: bodies.map((body, seq) => ({
      id: `t${seq}`,
      seq,
      role: 'user' as const,
      body,
      jobId: null,
      question: null,
      isAnswer: false,
      intent: 'ask' as const,
      intentCorrected: false,
      citations: [],
      authorId: 'u1',
      createdAt: '2026-08-20T10:00:00.000Z',
    })),
    workItemRefs: {},
  };
}

const ANSWERED = session(['which stories are blocked?']);

beforeEach(() => {
  open.mockResolvedValue(session([]));
  submitAsk.mockImplementation(async (body: string) => ({
    jobId: 'ask-1',
    turnId: 't0',
    session: session([body]),
  }));
  rerunAsk.mockImplementation(async () => ({
    jobId: 'ask-2',
    turnId: 't0',
    session: ANSWERED,
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

async function mounted() {
  const hook = renderHook(() => usePlanChangeConversation({}));
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

describe('an ANSWER', () => {
  it('lands the thread and returns to idle — no proposal, no error', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('which stories are blocked?');
    });

    expect(streamAsk).toHaveBeenCalledTimes(1);
    expect(settleAsk).toHaveBeenCalledWith('ask-1', expect.anything(), 's1');
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.session).toEqual(ANSWERED);
    expect(result.current.state.progress).toBeNull();
    expect(result.current.state.errorCode).toBeNull();
    // An ask proposes nothing, so the canvas keeps showing the saved plan.
    expect(result.current.state.review).toBeNull();
    expect(result.current.state.planId).toBeNull();
  });

  it('narrates the wait as READING while the ask job runs', async () => {
    let seen: unknown = null;
    streamAsk.mockImplementation(async () => {
      seen = 'checked';
    });
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('why?');
    });

    expect(seen).toBe('checked');
    expect(result.current.state.progress).toBeNull();
  });

  // MOTIR-7923 wired the ask stream's frame handler; MOTIR-8158 (founder decision
  // 2026-10-10) then made its lookups quiet: a `retrieval` frame draws no row, so
  // the rail stays on "Reading your request…" until the answer lands.
  it('draws NO row for a lookup while it answers, then settles as before', async () => {
    const held = deferred<void>();
    let emit!: (event: string, data: unknown) => void;
    streamAsk.mockImplementation(
      async (
        _jobId: string,
        _signal: AbortSignal,
        _onError: (code: string | null) => void,
        _onDone: () => void,
        onFrame?: (event: string, data: unknown) => void,
      ) => {
        if (!onFrame) throw new Error('the ask stream was opened without a frame handler');
        emit = onFrame;
        await held.promise;
      },
    );
    const { result } = await mounted();

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('which service owns the code-graph fan-out?');
    });
    await waitFor(() => expect(streamAsk).toHaveBeenCalledTimes(1));

    act(() => {
      // Phase bookkeeping and lookups are all quiet.
      emit('status', { phase: 'classifying' });
      emit('retrieval_ready', { tools: 4 });
      emit('status', { phase: 'answering' });
      emit('retrieval', { tool: 'search_code_graph', family: 'code_graph', ok: true });
      emit('retrieval', { tool: 'get_work_item', family: 'plan_tree', ok: true });
    });

    expect(result.current.state.phase).toBe('streaming');
    expect(result.current.state.acts).toEqual([{ kind: 'reading' }]);
    expect(result.current.state.progress).toEqual({ kind: 'reading' });

    await act(async () => {
      held.resolve();
      await sending;
    });

    // The answer lands exactly as it always did.
    expect(settleAsk).toHaveBeenCalledWith('ask-1', expect.anything(), 's1');
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.progress).toBeNull();
    expect(result.current.state.session).toEqual(ANSWERED);
    expect(result.current.state.errorCode).toBeNull();
  });
});

// MOTIR-10864 — the session's own sentences reach the rail as they arrive. The stream
// here is the REAL `consumeStream` over a body written exactly as motir-ai writes it
// (`{ jobId, seq, data: { text } }`), held open so each frame lands on its own.
describe("the answering session's NOTES, live (MOTIR-10864)", () => {
  /** A held SSE body: `push` writes one frame, `end` closes it. */
  function heldWire() {
    const enc = new TextEncoder();
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
      },
    });
    let seq = 0;
    return {
      response: { ok: true, body } as unknown as Response,
      note: (text: string) => {
        seq += 1;
        const data = JSON.stringify({ jobId: 'ask-1', seq, data: { text } });
        ctl.enqueue(enc.encode(`event: note\ndata: ${data}\n\n`));
      },
      end: () => {
        ctl.enqueue(enc.encode(`event: done\ndata: {"jobId":"ask-1"}\n\n`));
        ctl.close();
      },
    };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('the first note replaces "Reading your request…", and each later one is added as it arrives', async () => {
    const wire = heldWire();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => wire.response),
    );
    streamAsk.mockImplementation(
      (
        jobId: string,
        signal: AbortSignal,
        onError: (code: string | null) => void,
        onDone: () => void,
        onFrame?: (event: string, data: unknown) => void,
      ) => consumeStream(`/api/ai/ask/${jobId}/stream`, signal, onError, onDone, onFrame),
    );
    const { result } = await mounted();

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('which stories are blocked?');
    });
    // The submit's own act comes first; the ask's opening act once the job is up.
    await waitFor(() => expect(result.current.state.acts).toEqual([{ kind: 'reading' }]));
    await waitFor(() => expect(streamAsk).toHaveBeenCalledTimes(1));

    const sentences = Array.from({ length: 16 }, (_, i) => `Reading story ${i + 1} of the plan.`);
    act(() => wire.note(sentences[0]!));
    await waitFor(() =>
      expect(result.current.state.acts).toEqual([{ kind: 'note', text: sentences[0] }]),
    );
    expect(result.current.state.progress).toEqual({ kind: 'note', text: sentences[0] });

    for (let i = 1; i < sentences.length; i += 1) {
      act(() => wire.note(sentences[i]!));
      await waitFor(() => expect(result.current.state.acts).toHaveLength(i + 1));
    }
    expect(result.current.state.acts).toEqual(sentences.map((text) => ({ kind: 'note', text })));

    await act(async () => {
      wire.end();
      await sending;
    });
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.session).toEqual(ANSWERED);
  });
});

describe('a SILENT job — it ran and said nothing at all', () => {
  it('is its own error code, not the plan-change EMPTY copy', async () => {
    settleAsk.mockResolvedValue({ outcome: 'silent', session: ANSWERED });
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('why?');
    });

    // Core writes NOTHING for it — inventing a body would be motir-core writing
    // the assistant's words — so the rail says so honestly instead.
    expect(result.current.state.errorCode).toBe('ASK_SILENT');
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.session).toEqual(ANSWERED);
  });
});

describe('a failure while the ask streams', () => {
  it('is recoverable in place — the thread survives and settle is never called', async () => {
    streamAsk.mockImplementation(
      async (_jobId: string, _signal: AbortSignal, onError: (code: string | null) => void) => {
        onError('FAILED');
      },
    );
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('why?');
    });

    expect(result.current.state.errorCode).toBe('FAILED');
    expect(result.current.state.phase).toBe('idle');
    // The run stopped at the stream — nothing was filed against a job that failed.
    expect(settleAsk).not.toHaveBeenCalled();
  });

  it('flags an out-of-credits refusal as GATED rather than as an error', async () => {
    streamAsk.mockImplementation(
      async (_jobId: string, _signal: AbortSignal, onError: (code: string | null) => void) => {
        onError('MOTIR_AI_OUT_OF_CREDITS');
      },
    );
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('why?');
    });

    expect(result.current.state.outOfCredits).toBe(true);
    expect(result.current.state.errorCode).toBeNull();
  });

  it('treats a refusal at the DOOR the same way', async () => {
    submitAsk.mockRejectedValue(new PlanEditsClientError(402, 'MOTIR_AI_OUT_OF_CREDITS'));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('why?');
    });

    expect(result.current.state.outOfCredits).toBe(true);
    expect(result.current.state.errorCode).toBeNull();
  });
});

describe('the CORRECTION re-run', () => {
  it('names the TURN and asks for a flip — never the direction', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.correctTurn('t0');
    });

    // Which intent to flip TO is derived server-side from what the turn ran as,
    // so even the affordance where a person explicitly asks for a different
    // reading leaves the intent server-resolved (ADR §1).
    expect(rerunAsk).toHaveBeenCalledWith('t0', { flip: true, sessionId: 's1' }, expect.anything());
    expect(submitAsk).not.toHaveBeenCalled();
  });

  it('runs the SAME machinery — stream, settle, and the thread comes back', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.correctTurn('t0');
    });

    expect(streamAsk).toHaveBeenCalledTimes(1);
    expect(settleAsk).toHaveBeenCalledWith('ask-2', expect.anything(), 's1');
    expect(result.current.state.session).toEqual(ANSWERED);
    expect(result.current.state.phase).toBe('idle');
  });

  it('is ignored while a run is already in flight — one run at a time', async () => {
    let release!: () => void;
    submitAsk.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () =>
          resolve({ jobId: 'ask-1', turnId: 't0', session: session(['why?']) } as never);
      }),
    );
    const { result } = await mounted();

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.send('why?');
      await result.current.correctTurn('t0');
    });
    expect(rerunAsk).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await first;
    });
  });

  it('a correction that FLIPS to a plan change lands in the shipped review', async () => {
    rerunAsk.mockResolvedValue({
      outcome: 'redirected',
      jobId: 'job-augment-1',
      planId: 'plan-1',
      session: ANSWERED,
    });
    fetchReview.mockResolvedValue(null);
    const { result } = await mounted();

    await act(async () => {
      await result.current.correctTurn('t0');
    });

    // No ask job was opened at all — the flip went straight to the plan-change
    // submit, so the run is a plan-change run from its first frame.
    expect(streamAsk).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(result.current.state.jobId).toBe('job-augment-1');
    expect(result.current.state.planId).toBe('plan-1');
  });
});

describe('the redirect that arrives BEFORE any stream', () => {
  it('a reply to the planner’s question skips the ask job entirely', async () => {
    // The server short-circuits when the thread is really waiting on a question:
    // the affordance already settled the disposition, so there is nothing to
    // classify, and the run must be a plan-change run from the start.
    submitAsk.mockResolvedValue({
      outcome: 'redirected',
      jobId: 'job-augment-1',
      planId: 'plan-1',
      session: ANSWERED,
    });
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('money in');
    });

    expect(streamAsk).not.toHaveBeenCalled();
    expect(settleAsk).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(result.current.state.planId).toBe('plan-1');
  });

  it('draws NO hand-off marker — nothing was read and re-read', async () => {
    submitAsk.mockResolvedValue({
      outcome: 'redirected',
      jobId: 'job-augment-1',
      planId: 'plan-1',
      session: ANSWERED,
    });
    let midFlight: unknown = 'unset';
    stream.mockImplementation(async () => {
      midFlight = null;
    });
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('money in');
    });

    // `redirected` progress is the marker's trigger; this path never sets it.
    expect(midFlight).toBeNull();
    expect(result.current.state.progress).toBeNull();
  });

  it('a retry after one re-runs the accumulated intent, not a named turn', async () => {
    // There is no ask turn id to name — nothing opened one — so the retry falls
    // back to the shipped resubmit rather than inventing a turn to re-run.
    submitAsk.mockResolvedValue({
      outcome: 'redirected',
      jobId: 'job-augment-1',
      planId: 'plan-1',
      session: ANSWERED,
    });
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('money in');
    });

    await act(async () => {
      await result.current.retry();
    });

    expect(rerunAsk).not.toHaveBeenCalled();
  });
});

describe('asking WHILE a proposal is pending — a question is a lookup, not an abandonment', () => {
  it('a failed ask returns to REVIEW, and the proposal survives', async () => {
    const hook = await withPendingProposal();
    streamAsk.mockImplementation(
      async (_jobId: string, _signal: AbortSignal, onError: (code: string | null) => void) => {
        onError('FAILED');
      },
    );

    await act(async () => {
      await hook.result.current.send('what does that cover?');
    });

    expect(hook.result.current.state.phase).toBe('review');
    expect(hook.result.current.state.review).toEqual(REVIEW);
    expect(hook.result.current.state.errorCode).toBe('FAILED');
  });

  it('a SILENT answer likewise leaves the gate up', async () => {
    const hook = await withPendingProposal();
    settleAsk.mockResolvedValue({ outcome: 'silent', session: ANSWERED });

    await act(async () => {
      await hook.result.current.send('what does that cover?');
    });

    expect(hook.result.current.state.phase).toBe('review');
    expect(hook.result.current.state.review).toEqual(REVIEW);
  });

  it('an answered question keeps it too — the canvas is not cleared by a question', async () => {
    const hook = await withPendingProposal();

    await act(async () => {
      await hook.result.current.send('what does that cover?');
    });

    expect(hook.result.current.state.review).toEqual(REVIEW);
    expect(hook.result.current.state.phase).toBe('review');
  });

  it('a SETTLE that fails keeps the gate up and reports it', async () => {
    // The last hop can fail on its own: the job succeeded, the answer exists,
    // and filing it did not. The proposal already on the canvas is untouched.
    const hook = await withPendingProposal();
    settleAsk.mockRejectedValue(new Error('filing failed'));

    await act(async () => {
      await hook.result.current.send('what does that cover?');
    });

    expect(hook.result.current.state.phase).toBe('review');
    expect(hook.result.current.state.review).toEqual(REVIEW);
    expect(hook.result.current.state.errorCode).toBe('FAILED');
    expect(hook.result.current.state.outOfCredits).toBe(false);
  });

  it('a refusal at the DOOR keeps it as well', async () => {
    const hook = await withPendingProposal();
    submitAsk.mockRejectedValue(new PlanEditsClientError(500, null));

    await act(async () => {
      await hook.result.current.send('what does that cover?');
    });

    expect(hook.result.current.state.review).toEqual(REVIEW);
    expect(hook.result.current.state.errorCode).toBe('FAILED');
  });
});

describe('an ask in flight when the surface goes away', () => {
  it('writes no state after unmount — the door', async () => {
    const pending = deferred<{ jobId: string; turnId: string; session: PlanChangeSessionDto }>();
    submitAsk.mockReturnValueOnce(pending.promise);
    const hook = await mounted();

    let run!: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('why?');
    });
    hook.unmount();

    await act(async () => {
      pending.resolve({ jobId: 'ask-1', turnId: 't0', session: ANSWERED });
      await run;
    });

    // The settle never ran: the hook stopped at the first mounted check.
    expect(settleAsk).not.toHaveBeenCalled();
  });

  it('drops a SETTLE that lands after unmount', async () => {
    const pending = deferred<{ outcome: 'answered'; session: PlanChangeSessionDto }>();
    settleAsk.mockReturnValueOnce(pending.promise);
    const hook = await mounted();

    let run!: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('why?');
    });
    hook.unmount();

    await act(async () => {
      pending.resolve({ outcome: 'answered', session: ANSWERED });
      await run;
    });

    expect(hook.result.current.state.session).not.toEqual(ANSWERED);
  });

  it('swallows an ABORTED ask rather than flagging it as failed', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    submitAsk.mockRejectedValue(abort);
    const hook = await mounted();

    await act(async () => {
      await hook.result.current.send('why?');
    });

    // An abort is the surface going away, not a failure the user should see.
    expect(hook.result.current.state.errorCode).toBeNull();
    expect(hook.result.current.state.outOfCredits).toBe(false);
  });
});

describe('an UNCODED stream failure', () => {
  it('still says something — FAILED, never a blank error', async () => {
    streamAsk.mockImplementation(
      async (_jobId: string, _signal: AbortSignal, onError: (code: string | null) => void) => {
        onError(null);
      },
    );
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('why?');
    });

    expect(result.current.state.errorCode).toBe('FAILED');
    expect(settleAsk).not.toHaveBeenCalled();
  });
});

describe('a pick SEEDED at the project (MOTIR-6435) — the seed rides the first send only', () => {
  async function seededMount() {
    const hook = renderHook(() => usePlanChangeConversation({ seedGateId: 'gate-1' }));
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    return hook;
  }

  it('carries the gate on the send that has no session yet', async () => {
    const { result } = await seededMount();

    await act(async () => {
      await result.current.send('plan the follow-up');
    });

    expect(submitAsk).toHaveBeenCalledTimes(1);
    const args = submitAsk.mock.calls[0]!;
    expect(args[0]).toBe('plan the follow-up');
    expect(args[3]).toBeNull();
    expect(args[4]).toBe('gate-1');
  });

  it('a SEED_NOT_APPLICABLE refusal drops the seed, so the retry is an ordinary turn', async () => {
    submitAsk.mockRejectedValueOnce(new PlanEditsClientError(409, 'SEED_NOT_APPLICABLE'));
    const { result } = await seededMount();

    await act(async () => {
      await result.current.send('plan the follow-up');
    });
    // The send failed and says so; the seed is what the next send must not carry.
    expect(result.current.state.errorCode).not.toBeNull();

    await act(async () => {
      await result.current.send('plan the follow-up');
    });
    expect(submitAsk.mock.calls[1]![4]).toBeNull();
  });

  it('any OTHER refusal keeps the seed for the next attempt', async () => {
    submitAsk.mockRejectedValueOnce(new PlanEditsClientError(503, 'MOTIR_AI_UNAVAILABLE'));
    const { result } = await seededMount();

    await act(async () => {
      await result.current.send('plan the follow-up');
    });
    await act(async () => {
      await result.current.send('plan the follow-up');
    });

    expect(submitAsk.mock.calls[1]![4]).toBe('gate-1');
  });

  it('…and so does a failure that is not the client error at all', async () => {
    submitAsk.mockRejectedValueOnce(new TypeError('network'));
    const { result } = await seededMount();

    await act(async () => {
      await result.current.send('plan the follow-up');
    });
    await act(async () => {
      await result.current.send('plan the follow-up');
    });

    expect(submitAsk.mock.calls[1]![4]).toBe('gate-1');
  });
});
