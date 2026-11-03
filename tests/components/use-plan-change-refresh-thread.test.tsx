// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// Bug MOTIR-10255 — `refreshThread`: the rail re-reads the thread once a Grill me
// grilling over a plan offer ended, because the grilling's end stored the requirement
// it wrote ON the offer, which lives on the thread. What is asserted is the session the
// hook exposes after the read, never a render.

const { open, read } = vi.hoisted(() => ({ open: vi.fn(), read: vi.fn() }));

vi.mock('@/lib/planning/planChangeClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/planChangeClient')>()),
  findResumableSession: async (...a: unknown[]) => ({
    session: await (open as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  getPlanChangeSession: read,
}));

import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';

function session(id: string, offerRequirement: string | null): PlanChangeSessionDto {
  return {
    id,
    projectId: 'p1',
    targetKeys: [],
    turnCount: 1,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    turns: [
      {
        id: 't0',
        seq: 0,
        role: 'assistant' as const,
        body: offerRequirement ?? 'An answer.',
        jobId: null,
        question: null,
        isAnswer: true,
        intent: 'ask' as const,
        intentCorrected: false,
        citations: [],
        authorId: null,
        createdAt: '2026-08-20T10:00:00.000Z',
      },
    ],
    workItemRefs: {},
  } as PlanChangeSessionDto;
}

beforeEach(() => {
  open.mockResolvedValue(session('s1', null));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mounted() {
  const hook = renderHook(() => usePlanChangeConversation({}));
  await waitFor(() => expect(hook.result.current.state.session?.id).toBe('s1'));
  return hook;
}

describe('refreshThread', () => {
  it('replaces the thread with the one it read', async () => {
    const { result } = await mounted();
    read.mockResolvedValue(session('s1', 'The written requirement.'));
    await act(async () => {
      await result.current.refreshThread();
    });
    expect(read).toHaveBeenCalledWith('s1');
    expect(result.current.state.session?.turns[0]!.body).toBe('The written requirement.');
  });

  it('keeps the thread when the read answers another session', async () => {
    const { result } = await mounted();
    read.mockResolvedValue(session('s2', 'Someone else’s.'));
    await act(async () => {
      await result.current.refreshThread();
    });
    expect(result.current.state.session?.id).toBe('s1');
    expect(result.current.state.session?.turns[0]!.body).toBe('An answer.');
  });

  it('resolves and keeps the thread when the read fails', async () => {
    const { result } = await mounted();
    read.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await expect(result.current.refreshThread()).resolves.toBeUndefined();
    });
    expect(result.current.state.session?.turns[0]!.body).toBe('An answer.');
  });

  it('writes nothing once unmounted mid-read', async () => {
    const hook = await mounted();
    let answer: (s: PlanChangeSessionDto) => void = () => {};
    read.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const pending = hook.result.current.refreshThread();
    hook.unmount();
    answer(session('s1', 'Too late.'));
    await expect(pending).resolves.toBeUndefined();
  });

  it('reads nothing before a thread exists', async () => {
    open.mockResolvedValue(null);
    const hook = renderHook(() => usePlanChangeConversation({}));
    await act(async () => {
      await hook.result.current.refreshThread();
    });
    expect(read).not.toHaveBeenCalled();
  });
});
