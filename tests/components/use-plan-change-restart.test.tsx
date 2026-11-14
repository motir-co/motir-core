// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';

// PLAN SOMETHING NEW, as the overlay's state machine follows it (Story MOTIR-7631 ·
// MOTIR-7650; `docs/decisions/conversation-turn-intent.md` AMENDMENT 3). The rail
// draws the SERVER's thread, so these cases pin what reaches state:
//
//   * the control's dialog confirms with `confirmRestart` (MOTIR-11261): the restart
//     and nothing written first, resolving whether it happened, with no rail error;
//   * a LEGACY confirm turn's Keep planning lands the marker the server returns,
//     and nothing else moves;
//   * Confirm SWAPS onto the new session in place, carrying nothing across, and
//     tells the host the new id;
//   * the address that then names the new session opens nothing;
//   * a refused answer is the recoverable session error.

const { open, readSession, answer } = vi.hoisted(() => ({
  open: vi.fn(),
  readSession: vi.fn(),
  answer: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  findResumableSession: async (...a: unknown[]) => ({
    session: await (open as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  getPlanChangeSession: readSession,
  answerRestart: answer,
  startCopiedSession: vi.fn(),
  resumeContextualSession: vi.fn(async () => ({ session: null, planId: null })),
  submitContextualPlan: vi.fn(),
  resubmitContextualPlan: vi.fn(),
  submitAskTurn: vi.fn(),
  rerunAskTurn: vi.fn(),
  settleAskJob: vi.fn(),
  submitPlanChange: vi.fn(),
  recordPlannerTurn: vi.fn(),
  attachMidRunTurn: vi.fn(),
  peekMailbox: vi.fn(),
  stopPlanChangeRun: vi.fn(),
}));

import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';

function turn(seq: number, over: Partial<PlanChangeTurnDto> = {}): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role: 'user',
    body: 'Split the export work.',
    jobId: null,
    question: null,
    confirm: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: 'u1',
    createdAt: '2026-10-06T10:00:00.000Z',
    ...over,
  };
}

function session(id: string, turns: PlanChangeTurnDto[]): PlanChangeSessionDto {
  return {
    id,
    projectId: 'p1',
    targetKeys: ['ACME-40'],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-06T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-10-06T09:00:00.000Z',
    updatedAt: '2026-10-06T10:00:00.000Z',
    turns,
    workItemRefs: {},
  };
}

const OPEN = session('s1', [turn(0)]);
const CONFIRM = turn(1, {
  role: 'assistant',
  confirm: 'new_session',
  body: 'Start something new?',
});
const WITH_CONFIRM = session('s1', [turn(0), CONFIRM]);
const KEPT = session('s1', [turn(0), CONFIRM, turn(2, { role: 'system', body: 'Kept planning.' })]);
const FRESH = session('s2', []);

beforeEach(() => {
  open.mockResolvedValue(OPEN);
  readSession.mockResolvedValue(OPEN);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mounted(opts: { sessionId?: string; onRestarted?: (id: string) => void } = {}) {
  const hook = renderHook(
    (props: { sessionId?: string }) =>
      usePlanChangeConversation({
        sessionId: props.sessionId ?? null,
        ...(opts.onRestarted ? { onRestarted: opts.onRestarted } : {}),
      }),
    { initialProps: opts.sessionId ? { sessionId: opts.sessionId } : {} },
  );
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

describe('the dialog confirm (MOTIR-11261)', () => {
  it('restarts with nothing written first, swaps, and resolves true', async () => {
    answer.mockResolvedValue({ outcome: 'restarted', endedSessionId: 's1', session: FRESH });
    const onRestarted = vi.fn();
    const { result } = await mounted({ onRestarted });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.confirmRestart();
    });

    expect(ok).toBe(true);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith('s1', 'confirm');
    expect(result.current.state).toMatchObject({
      session: FRESH,
      restartedFrom: 's1',
      restarting: false,
      errorCode: null,
    });
    expect(onRestarted).toHaveBeenCalledWith('s2');
  });

  it('a refused restart resolves false, keeps the session, and records no rail error', async () => {
    answer.mockRejectedValue(new PlanEditsClientError(409, 'PLAN_SESSION_ENDED'));
    const { result } = await mounted();

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.confirmRestart();
    });

    expect(ok).toBe(false);
    expect(result.current.state.session).toEqual(OPEN);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.restarting).toBe(false);
  });

  it('an aborted restart resolves false', async () => {
    answer.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const { result } = await mounted();

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.confirmRestart();
    });

    expect(ok).toBe(false);
    expect(result.current.state.errorCode).toBeNull();
  });

  it('does nothing on an ended session', async () => {
    open.mockResolvedValue({ ...OPEN, endedAt: '2026-10-06T11:00:00.000Z', endReason: 'idle' });
    const { result } = await mounted();

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.confirmRestart();
      await result.current.answerRestartConfirm('confirm');
    });

    expect(ok).toBe(false);
    expect(answer).not.toHaveBeenCalled();
  });
});

describe('Keep planning', () => {
  it('lands the marker the server returns and moves nothing else', async () => {
    open.mockResolvedValue(WITH_CONFIRM);
    answer.mockResolvedValue(KEPT);
    const onRestarted = vi.fn();
    const { result } = await mounted({ onRestarted });

    await act(async () => {
      await result.current.answerRestartConfirm('keep');
    });

    expect(answer).toHaveBeenCalledWith('s1', 'keep');
    expect(result.current.state.session).toEqual(KEPT);
    expect(result.current.state.restartedFrom ?? null).toBeNull();
    expect(onRestarted).not.toHaveBeenCalled();
  });
});

describe('Confirm — the swap', () => {
  it('swaps onto the new empty session in place, names the ended one, and tells the host', async () => {
    open.mockResolvedValue(WITH_CONFIRM);
    answer.mockResolvedValue({ outcome: 'restarted', endedSessionId: 's1', session: FRESH });
    const onRestarted = vi.fn();
    const { result } = await mounted({ onRestarted });

    await act(async () => {
      await result.current.answerRestartConfirm('confirm');
    });

    expect(answer).toHaveBeenCalledWith('s1', 'confirm');
    expect(result.current.state).toMatchObject({
      phase: 'idle',
      session: FRESH,
      restartedFrom: 's1',
      restarting: false,
      errorCode: null,
      review: null,
      acts: [],
      queued: [],
      reopened: null,
      readOnly: false,
    });
    expect(onRestarted).toHaveBeenCalledWith('s2');
  });

  it('the address that then names the new session opens nothing; another address opens as usual', async () => {
    readSession.mockResolvedValue(WITH_CONFIRM);
    answer.mockResolvedValue({ outcome: 'restarted', endedSessionId: 's1', session: FRESH });
    const hook = await mounted({ sessionId: 's1' });
    expect(readSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      await hook.result.current.answerRestartConfirm('confirm');
    });
    hook.rerender({ sessionId: 's2' });
    await act(async () => {});
    expect(readSession).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.session?.id).toBe('s2');

    // Open it: the ended session's address reopens it by id…
    readSession.mockResolvedValue({ ...WITH_CONFIRM, endedAt: '2026-10-06T11:00:00.000Z' });
    hook.rerender({ sessionId: 's1' });
    await waitFor(() => expect(hook.result.current.state.session?.id).toBe('s1'));
    // …and coming back to the new one's address opens IT again.
    readSession.mockResolvedValue(FRESH);
    hook.rerender({ sessionId: 's2' });
    await waitFor(() => expect(hook.result.current.state.session?.id).toBe('s2'));
    expect(readSession).toHaveBeenCalledTimes(3);
  });

  it('a refused confirm keeps the session and says so', async () => {
    open.mockResolvedValue(WITH_CONFIRM);
    answer.mockRejectedValue(new PlanEditsClientError(409, 'PLAN_SESSION_ENDED'));
    const onRestarted = vi.fn();
    const { result } = await mounted({ onRestarted });

    await act(async () => {
      await result.current.answerRestartConfirm('confirm');
    });

    expect(result.current.state.session).toEqual(WITH_CONFIRM);
    expect(result.current.state.errorCode).toBe('SESSION_UNAVAILABLE');
    expect(onRestarted).not.toHaveBeenCalled();
  });
});

describe('the edges', () => {
  it('does nothing with no session open', async () => {
    open.mockResolvedValue(null);
    const { result } = await mounted();

    await act(async () => {
      await result.current.confirmRestart();
      await result.current.answerRestartConfirm('keep');
    });

    expect(answer).not.toHaveBeenCalled();
  });

  it('a second press while one is in flight sends nothing', async () => {
    let release: (r: unknown) => void = () => {};
    answer.mockReturnValue(new Promise((r) => (release = r)));
    const { result } = await mounted();

    let second: boolean | undefined;
    await act(async () => {
      const first = result.current.confirmRestart();
      second = await result.current.confirmRestart();
      await result.current.answerRestartConfirm('confirm');
      await result.current.answerRestartConfirm('keep');
      release({ outcome: 'restarted', endedSessionId: 's1', session: FRESH });
      await first;
    });

    expect(second).toBe(false);
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('an aborted call is not a session error', async () => {
    const aborted = new DOMException('aborted', 'AbortError');
    answer.mockRejectedValue(aborted);
    open.mockResolvedValue(WITH_CONFIRM);
    const { result } = await mounted();

    await act(async () => {
      await result.current.answerRestartConfirm('confirm');
      await result.current.answerRestartConfirm('keep');
    });

    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.restarting).toBe(false);
  });

  it('swaps with no host callback to tell', async () => {
    open.mockResolvedValue(WITH_CONFIRM);
    answer.mockResolvedValue({ outcome: 'restarted', endedSessionId: 's1', session: FRESH });
    const { result } = await mounted();

    await act(async () => {
      await result.current.answerRestartConfirm('confirm');
    });

    expect(result.current.state.session).toEqual(FRESH);
    expect(result.current.state.restartedFrom).toBe('s1');
  });

  it('an answer that lands after unmount writes nothing', async () => {
    let release: (s: PlanChangeSessionDto) => void = () => {};
    open.mockResolvedValue(WITH_CONFIRM);
    answer.mockReturnValue(new Promise((r) => (release = r)));
    const onRestarted = vi.fn();
    const hook = await mounted({ onRestarted });

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hook.result.current.answerRestartConfirm('keep');
    });
    hook.unmount();
    release(KEPT);
    await pending;

    expect(onRestarted).not.toHaveBeenCalled();
  });
});

describe('nothing is written once the overlay has gone (unmount mid-call)', () => {
  /** Mount, start `call`, unmount while it is in flight, then settle it. */
  async function unmountDuring(
    call: (h: Awaited<ReturnType<typeof mounted>>) => Promise<void>,
    settle: () => void,
  ) {
    const onRestarted = vi.fn();
    const hook = await mounted({ onRestarted });
    let pending!: Promise<void>;
    await act(async () => {
      pending = call(hook);
      await Promise.resolve();
    });
    hook.unmount();
    settle();
    await act(async () => {
      await pending;
    });
    return onRestarted;
  }

  it('the dialog confirm, landing or refused, tells the host nothing', async () => {
    for (const ok of [true, false]) {
      let done!: () => void;
      answer.mockReturnValueOnce(
        new Promise((res, rej) => {
          done = () =>
            ok ? res({ session: FRESH, endedSessionId: 's1' }) : rej(new Error('network'));
        }),
      );
      const onRestarted = await unmountDuring(
        async (h) => {
          await h.result.current.confirmRestart();
        },
        () => done(),
      );
      expect(answer).toHaveBeenCalledWith('s1', 'confirm');
      expect(onRestarted).not.toHaveBeenCalled();
      answer.mockClear();
    }
  });

  it('a Confirm, landing or refused, tells the host nothing', async () => {
    for (const ok of [true, false]) {
      open.mockResolvedValue(WITH_CONFIRM);
      let done!: () => void;
      answer.mockReturnValueOnce(
        new Promise((res, rej) => {
          done = () =>
            ok ? res({ session: FRESH, endedSessionId: 's1' }) : rej(new Error('network'));
        }),
      );
      const onRestarted = await unmountDuring(
        (h) => h.result.current.answerRestartConfirm('confirm'),
        () => done(),
      );
      expect(answer).toHaveBeenCalledWith('s1', 'confirm');
      expect(onRestarted).not.toHaveBeenCalled();
      answer.mockClear();
    }
  });

  it('a Keep planning that lands after unmount', async () => {
    open.mockResolvedValue(WITH_CONFIRM);
    let done!: () => void;
    answer.mockReturnValueOnce(
      new Promise((res) => {
        done = () => res(KEPT);
      }),
    );
    await unmountDuring(
      (h) => h.result.current.answerRestartConfirm('keep'),
      () => done(),
    );
    expect(answer).toHaveBeenCalledWith('s1', 'keep');
  });
});
