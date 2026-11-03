// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import { useGrillSession } from '@/components/planning/useGrillSession';
import type { SharpenSessionDto, SharpenTurnDto } from '@/lib/dto/sharpen';

// MOTIR-10235 — the driver's half of a read that can now run long: a reload picks the
// read up as busy, one Stop is all a session takes, and credits that ended a read while
// the person was away are told when they come back.

const client = vi.hoisted(() => ({
  getOpenSharpen: vi.fn(),
  getLatestConversationSharpen: vi.fn(),
  openSharpen: vi.fn(),
  resubmitSharpen: vi.fn(),
  settleSharpen: vi.fn(),
  sharpenAct: vi.fn(),
}));
vi.mock('@/lib/planning/sharpenClient', () => client);

function plannerTurn(extra: Partial<SharpenTurnDto> = {}): SharpenTurnDto {
  return {
    id: 'p1',
    seq: 1,
    role: 'planner',
    action: null,
    body: 'The planner could not answer this turn.',
    readingId: null,
    jobId: 'j1',
    failed: false,
    outOfCredits: false,
    createdAt: '2026-11-03T00:00:00.000Z',
    ...extra,
  } as SharpenTurnDto;
}

function open(extra: Partial<SharpenSessionDto> = {}): SharpenSessionDto {
  return {
    id: 's1',
    scope: { kind: 'plan', planId: 'plan_1' },
    status: 'open',
    endReason: null,
    pendingQuestion: null,
    settled: [],
    assumptions: [],
    writeBack: null,
    inFlight: { turnId: 't1', jobId: 'j1' },
    turns: [],
    notes: [],
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
    lastActivityAt: '2026-11-03T00:00:00.000Z',
    ...extra,
  } as SharpenSessionDto;
}

const onPlan = { on: true, planId: 'plan_1', active: true, personTurns: 1 };

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
});
afterEach(cleanup);

describe('a reload during a read', () => {
  it('is busy while the job runs, and free once it settles', async () => {
    let settle: (v: unknown) => void = () => {};
    client.getOpenSharpen.mockResolvedValue(open());
    client.settleSharpen.mockImplementation(() => new Promise((r) => (settle = r)));
    const { result } = renderHook(() => useGrillSession(onPlan));
    await waitFor(() => expect(result.current.pending).toBe(true));
    await act(async () => {
      settle({ outcome: 'settled', session: open({ inFlight: null }) });
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  it('a session with nothing in flight is not busy', async () => {
    client.getOpenSharpen.mockResolvedValue(open({ inFlight: null }));
    const { result } = renderHook(() => useGrillSession(onPlan));
    await waitFor(() => expect(result.current.session).not.toBeNull());
    expect(result.current.pending).toBe(false);
  });
});

describe('Stop', () => {
  const stopped = open({
    turns: [{ ...plannerTurn(), id: 'st', role: 'person', action: 'stop', jobId: 'j2' }],
    inFlight: { turnId: 'st', jobId: 'j2' },
  });

  it('goes to the door once however often it is pressed, and the stop’s job keeps it busy', async () => {
    let answer: (v: unknown) => void = () => {};
    client.getOpenSharpen.mockResolvedValue(open());
    client.settleSharpen.mockImplementation((_s, jobId: string, signal: AbortSignal) =>
      jobId === 'j2'
        ? Promise.resolve({ outcome: 'pending', session: stopped })
        : new Promise((_r, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
    );
    client.sharpenAct.mockImplementation(() => new Promise((r) => (answer = r)));
    const { result } = renderHook(() => useGrillSession(onPlan));
    await waitFor(() => expect(result.current.pending).toBe(true));

    act(() => {
      result.current.stop();
      result.current.stop();
    });
    expect(client.sharpenAct).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer({ outcome: 'sharpening', jobId: 'j2', turnId: 'st', session: stopped });
    });
    // The superseded read's end does not clear the pending of the stop's own run.
    await waitFor(() => expect(result.current.session?.inFlight?.jobId).toBe('j2'));
    expect(result.current.pending).toBe(true);
    expect(result.current.error).toBeNull();

    act(() => result.current.stop());
    expect(client.sharpenAct).toHaveBeenCalledTimes(1);
  });

  it('can be pressed again when the first press never reached the door', async () => {
    client.getOpenSharpen.mockResolvedValue(open({ inFlight: null }));
    client.sharpenAct.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useGrillSession(onPlan));
    await waitFor(() => expect(result.current.session).not.toBeNull());
    await act(async () => result.current.stop());
    await waitFor(() => expect(result.current.error).toBe('failed'));
    client.sharpenAct.mockResolvedValueOnce({
      outcome: 'sharpening',
      jobId: null,
      session: open(),
    });
    await act(async () => result.current.stop());
    expect(client.sharpenAct).toHaveBeenCalledTimes(2);
  });
});

describe('credits ended a read while the person was away', () => {
  it('says so on coming back, from the stored turn', async () => {
    client.getOpenSharpen.mockResolvedValue(
      open({ inFlight: null, turns: [plannerTurn({ failed: true, outOfCredits: true })] }),
    );
    const { result } = renderHook(() => useGrillSession(onPlan));
    await waitFor(() => expect(result.current.error).toBe('outOfCredits'));
  });

  it('says nothing of credits for any other session', async () => {
    client.getOpenSharpen.mockResolvedValue(
      open({ inFlight: null, turns: [plannerTurn({ failed: true })] }),
    );
    const { result } = renderHook(() => useGrillSession(onPlan));
    await waitFor(() => expect(result.current.session).not.toBeNull());
    expect(result.current.error).toBeNull();
  });
});
