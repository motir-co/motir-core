// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePlanGeneration } from '@/lib/hooks/usePlanGeneration';
import { OUT_OF_CREDITS_CODE } from '@/lib/planning/planGenerateClient';
import { planReview, planReviewItem } from '../helpers/planReview';
import { createElement, type ReactNode } from 'react';
import {
  LiveSignalProvider,
  type LiveSignalListener,
  type LiveSignalSource,
} from '@/lib/live/liveSignal';
import { createLiveFlag } from '@/lib/live/liveFlag';

// The 7.4 generation driver (Subtask 7.4.9 / MOTIR-1396). It POSTs the job, then
// runs the live-reveal poll (success → planned/empty) + the SSE stream (failure →
// failed/out_of_credits) concurrently. These tests pin the submit-time outcomes
// (the deterministic paths): the DISTINCT out-of-credits mapping (7.2) vs a
// generic failure, and the transition into the generating reveal. The terminal
// reveal/stream resolution is covered by the GenerationFlow component test.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** An immediately-closed SSE body (no error frame ⇒ the stream signals success). */
function emptyStream(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('usePlanGeneration (MOTIR-1396)', () => {
  it('maps a 402 submit to the out_of_credits phase (the distinct credits outcome)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(402, { code: OUT_OF_CREDITS_CODE }),
    );

    const { result } = renderHook(() => usePlanGeneration());
    act(() => result.current.start());

    await waitFor(() => expect(result.current.phase).toBe('out_of_credits'));
  });

  it('maps a non-credits submit failure (502) to the failed phase', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(502, { code: 'MOTIR_AI_UNAVAILABLE' }),
    );

    const { result } = renderHook(() => usePlanGeneration());
    act(() => result.current.start());

    await waitFor(() => expect(result.current.phase).toBe('failed'));
  });

  it('transitions to generating with the opened planId after a successful submit', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/ai/plan/generate') {
        return Promise.resolve(jsonResponse(200, { jobId: 'job_1', planId: 'plan_1' }));
      }
      if (url.includes('/stream')) return Promise.resolve(emptyStream());
      // The reveal poll (/api/plans/:id) — still generating, no items yet.
      return Promise.resolve(
        jsonResponse(200, {
          id: 'plan_1',
          projectId: 'p',
          status: 'generating',
          title: null,
          summary: null,
          itemCount: 0,
          createdAt: '2026-06-26T00:00:00.000Z',
          plannedAt: null,
          decidedAt: null,
          decidedByName: null,
          // The three-party attribution (MOTIR-2991). The default is the UNATTRIBUTED
          // state, so every pre-existing case keeps asserting a header without one and
          // each attribution state opts in explicitly.
          origin: 'user',
          sourceJobId: null,
          createdByName: null,
          authorSource: null,
          authorHarness: null,
          authorModel: null,
          history: [],
          items: [],
          stale: false,
          staleCount: 0,
          // A small level, so the derived default is the CANVAS unless a case says
          // otherwise (MOTIR-4024).
          arrivalLevelSize: 1,
          arrivalLevelTotal: 1,
        }),
      );
    });

    const { result, unmount } = renderHook(() => usePlanGeneration());
    act(() => result.current.start());

    await waitFor(() => expect(result.current.phase).toBe('generating'));
    expect(result.current.planId).toBe('plan_1');
    unmount(); // aborts the poll/stream
  });

  // MOTIR-6301 (the live-drawing gate's coverage top-up). The reveal poll became
  // THE shared generating-plan poll (MOTIR-6295), and its SUCCESS arm — the
  // snapshot that says the plan left `generating` — was reached by no spec: the
  // cases above settle through the submit and the stream. Driven here through the
  // real poll over a stubbed `/api/plans/:id`.
  function revealing(status: 'planned', items: ReturnType<typeof planReviewItem>[]) {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/ai/plan/generate') {
        return Promise.resolve(jsonResponse(200, { jobId: 'job_1', planId: 'plan_1' }));
      }
      if (url.includes('/stream')) return Promise.resolve(emptyStream());
      return Promise.resolve(jsonResponse(200, planReview(items, { id: 'plan_1', status })));
    });
  }

  it('settles PLANNED, with the revealed items, when the poll reads the plan proposed', async () => {
    const item = planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', title: 'Invoices' });
    revealing('planned', [item]);
    const { result, unmount } = renderHook(() => usePlanGeneration());
    act(() => result.current.start());

    await waitFor(() => expect(result.current.phase).toBe('planned'));
    expect(result.current.items.map((i) => i.planItemId)).toEqual(['pi_1']);
    expect(result.current.version).toBeGreaterThan(0);
    unmount();
  });

  it('settles EMPTY when the plan left generating holding no proposals', async () => {
    revealing('planned', []);
    const { result, unmount } = renderHook(() => usePlanGeneration());
    act(() => result.current.start());

    await waitFor(() => expect(result.current.phase).toBe('empty'));
    expect(result.current.items).toEqual([]);
    unmount();
  });

  // MOTIR-8575 — the reveal files each snapshot MERGED by identity: a re-read that
  // changed nothing keeps the very same `items` array and does not bump `version`.
  it('an unchanged snapshot keeps the same items array and version (MOTIR-8575)', async () => {
    const item = planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', title: 'Invoices' });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/ai/plan/generate') {
        return Promise.resolve(jsonResponse(200, { jobId: 'job_1', planId: 'plan_1' }));
      }
      // A stream that stays open: the plan is still being written.
      if (url.includes('/stream')) {
        return Promise.resolve(
          new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, planReview([item], { id: 'plan_1', status: 'generating' })),
      );
    });
    const listeners = new Set<LiveSignalListener>();
    const source: LiveSignalSource = {
      subscribe: (_topic, onSignal) => {
        listeners.add(onSignal);
        return () => listeners.delete(onSignal);
      },
      reconnecting: createLiveFlag(false),
    };
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(LiveSignalProvider, { source }, children);
    const { result, unmount } = renderHook(() => usePlanGeneration(), { wrapper });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    const items = result.current.items;
    const version = result.current.version;
    const reads = () =>
      vi.mocked(globalThis.fetch).mock.calls.filter(([u]) => String(u) === '/api/plans/plan_1')
        .length;
    const before = reads();

    await act(async () => {
      for (const l of [...listeners]) l({ topic: { kind: 'plan', planId: 'plan_1' }, seq: 1 });
    });
    await waitFor(() => expect(reads()).toBe(before + 1));
    await act(async () => {});
    expect(result.current.items).toBe(items);
    expect(result.current.version).toBe(version);
    unmount();
  });

  // MOTIR-10878 — on motir-ai's real wire every PROGRESS frame nests its payload
  // under `data` (`{ jobId, seq, data }`); the job's own `status`, `done` and the
  // relay's `error` frames are flat. This stream reads only those flat frames, so
  // a progress payload — even one naming a `status` — must change nothing.
  function sseResponse(frames: Array<{ event: string; data: unknown }>): Response {
    const body = frames
      .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
      .join('');
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(body));
          c.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }
  const progress = (event: string, seq: number, payload: Record<string, unknown>) => ({
    event,
    data: { jobId: 'job_1', seq, data: payload },
  });
  function streaming(
    frames: Array<{ event: string; data: unknown }>,
    items = [] as ReturnType<typeof planReviewItem>[],
  ) {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/ai/plan/generate') {
        return Promise.resolve(jsonResponse(200, { jobId: 'job_1', planId: 'plan_1' }));
      }
      if (url.includes('/stream')) return Promise.resolve(sseResponse(frames));
      return Promise.resolve(
        jsonResponse(200, planReview(items, { id: 'plan_1', status: 'planned' })),
      );
    });
  }

  it('reads past nested progress frames to the flat error frame’s typed code (MOTIR-10878)', async () => {
    streaming([
      { event: 'status', data: { jobId: 'job_1', status: 'running' } },
      progress('walk_position', 1, { phase: 'lay', target: null, depth: 0 }),
      progress('status', 2, { status: 'succeeded', phase: 'laying' }),
      { event: 'status', data: { jobId: 'job_1', status: 'failed' } },
      { event: 'error', data: { code: OUT_OF_CREDITS_CODE, message: 'No credits.' } },
    ]);
    const { result, unmount } = renderHook(() => usePlanGeneration());
    act(() => result.current.start());

    await waitFor(() => expect(result.current.phase).toBe('out_of_credits'));
    unmount();
  });

  it('a nested progress payload naming a failed status does not fail the run (MOTIR-10878)', async () => {
    const item = planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', title: 'Invoices' });
    streaming(
      [
        progress('status', 1, { status: 'failed' }),
        progress('search', 2, { query: 'invoices' }),
        { event: 'status', data: { jobId: 'job_1', status: 'succeeded' } },
        { event: 'done', data: { jobId: 'job_1' } },
      ],
      [item],
    );
    const { result, unmount } = renderHook(() => usePlanGeneration());
    act(() => result.current.start());

    await waitFor(() => expect(result.current.phase).toBe('planned'));
    expect(result.current.items.map((i) => i.planItemId)).toEqual(['pi_1']);
    unmount();
  });
});
