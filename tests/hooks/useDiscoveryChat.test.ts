// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useDiscoveryChat } from '@/lib/hooks/useDiscoveryChat';
import type { PreplanStateDTO } from '@/lib/dto/aiPreplan';

// MOTIR-10878 — the onboarding discovery loop reads its job's frames as motir-ai
// writes them. Every frame the discovery job emits (`assistant`, `status`,
// `state`, `docs`, `revisions`, …) is a PROGRESS frame, which
// `GET /v1/jobs/:id/stream` writes as `{ jobId, seq, data: <payload> }`
// (`motir-ai/src/app.ts` `flushProgress`) and `/api/ai/chat/:jobId/stream`
// relays unchanged; only the job's own `status` and `done` frames are flat. Read
// at the top level, every payload field was `undefined`, so no reply, no state and
// no announced tier ever reached the loop. The `fetch`es are stubbed; the hook,
// its frame parsing and the reducer are real.

const JOB = 'job-1';

/** A progress frame exactly as it arrives on the wire. */
function progress(event: string, seq: number, payload: Record<string, unknown>) {
  return { event, data: { jobId: JOB, seq, data: payload } };
}

function sse(frames: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const body = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
}

const EMPTY_PREPLAN: PreplanStateDTO = { session: null, docs: [], catalog: null };

const VISION_PREPLAN: PreplanStateDTO = {
  session: null,
  catalog: null,
  docs: [
    {
      kind: 'vision',
      currentBody: '# Vision\n\nA tool for invoices.',
      currentVersion: 1,
      summary: [],
      versions: [],
    },
  ],
};

/** Stub one discovery turn: the pre-plan reads answer in turn (the last
 *  repeating), the chat submit answers a job id, and its stream answers `frames`. */
function stubTurn(frames: Array<{ event: string; data: unknown }>, preplans: PreplanStateDTO[]) {
  let preplanReads = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/ai/pre-plan') {
      const dto = preplans[Math.min(preplanReads, preplans.length - 1)]!;
      preplanReads += 1;
      return new Response(JSON.stringify(dto), { status: 200 });
    }
    if (url === '/api/ai/chat')
      return new Response(JSON.stringify({ jobId: JOB }), { status: 200 });
    if (url === `/api/ai/chat/${JOB}/stream`) return new Response(sse(frames), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    preplanReads: () => fetchMock.mock.calls.filter(([u]) => u === '/api/ai/pre-plan').length,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useDiscoveryChat — motir-ai’s nested progress frames (MOTIR-10878)', () => {
  it('reads the reply, the session patch and the announced tier through the envelope', async () => {
    const io = stubTurn(
      [
        { event: 'status', data: { jobId: JOB, status: 'running' } },
        progress('status', 1, { phase: 'drafting', tier: 'vision' }),
        progress('assistant', 2, { text: 'Who sends the invoices?' }),
        progress('state', 3, { classification: 'saas', platform: 'web', currentGate: 'vision' }),
        progress('docs', 4, { docs: [{ id: 'doc-1', kind: 'vision', version: 1 }] }),
        { event: 'status', data: { jobId: JOB, status: 'succeeded' } },
        { event: 'done', data: { jobId: JOB } },
      ],
      [EMPTY_PREPLAN, VISION_PREPLAN],
    );

    const { result } = renderHook(() => useDiscoveryChat({ initialIdea: 'An invoicing app' }));

    await waitFor(() => expect(result.current.state.view).toBe('review'));
    const { state } = result.current;
    expect(state.turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'An invoicing app'],
      ['assistant', 'Who sends the invoices?'],
    ]);
    expect(state.session).toMatchObject({
      classification: 'saas',
      platform: 'web',
      currentGate: 'vision',
    });
    expect(state.producedKinds).toEqual(['vision']);
    // The announced tier's body was pulled and its review gate opened.
    expect(io.preplanReads()).toBe(2);
    expect(state.docs.vision?.contentMd).toContain('A tool for invoices.');
    expect(state.activeKind).toBe('vision');
    expect(state.isStreaming).toBe(false);
    expect(state.error).toBeNull();
  });

  it('routes a nested `revisions` cascade back to its gate and refreshes the bodies', async () => {
    const io = stubTurn(
      [
        progress('revisions', 1, {
          revisions: [
            { tier: 'vision', reason: 'direct' },
            { tier: 'feasibility', reason: 'cascade' },
          ],
          gate: 'vision',
        }),
        { event: 'done', data: { jobId: JOB } },
      ],
      [EMPTY_PREPLAN, VISION_PREPLAN],
    );

    const { result } = renderHook(() => useDiscoveryChat({ initialIdea: 'Change the vision' }));

    await waitFor(() => expect(io.preplanReads()).toBe(2));
    await waitFor(() => expect(result.current.state.isStreaming).toBe(false));
    const { state } = result.current;
    expect(state.cascade).toEqual({
      directTier: 'vision',
      tiers: ['vision', 'feasibility'],
      fromKind: null,
    });
    expect(state.activeKind).toBe('vision');
    expect(state.view).toBe('review');
  });

  it('settles the error a flat `error` frame names, after nested frames', async () => {
    stubTurn(
      [
        progress('assistant', 1, { text: 'Let me think.' }),
        { event: 'error', data: { code: 'MOTIR_AI_OUT_OF_CREDITS', message: 'No credits.' } },
      ],
      [EMPTY_PREPLAN],
    );

    const { result } = renderHook(() => useDiscoveryChat({ initialIdea: 'An app' }));

    await waitFor(() => expect(result.current.state.error).not.toBeNull());
    expect(result.current.state.error).toEqual({
      code: 'MOTIR_AI_OUT_OF_CREDITS',
      message: 'No credits.',
    });
    expect(result.current.state.turns.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Let me think.',
    });
  });
});
