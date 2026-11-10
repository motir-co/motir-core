// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useExplanationDraft } from '@/lib/hooks/useExplanationDraft';

// Story MOTIR-7734 · MOTIR-8744 — the draft hook keeps the LANGUAGE the terminal
// `explanation` frame names (`draftLanguage`), so the form can save the draft
// with it. The two `fetch`es (submit, then the SSE stream) are stubbed; the hook
// and its frame parsing are real.

function sse(frames: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const body = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
}

/** A PROGRESS frame exactly as motir-ai writes it and core's stream route relays
 *  it: the payload nested under `data`, beside the job id and its seq
 *  (`motir-ai/src/app.ts` `flushProgress`, MOTIR-10878). */
function progress(event: string, seq: number, payload: Record<string, unknown>) {
  return { event, data: { jobId: 'job-1', seq, data: payload } };
}

/** Stub one draft's stream frames: the submit answers a job id, the stream these. */
function stubStream(frames: Array<{ event: string; data: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/stream')
        ? new Response(sse(frames), { status: 200 })
        : new Response(JSON.stringify({ jobId: 'job-1' }), { status: 200 }),
    ),
  );
}

/** Stub one draft whose stream carries one terminal `explanation` frame, on the wire. */
function stubDraft(frame: Record<string, unknown>) {
  stubStream([progress('explanation', 1, frame)]);
}

function draftHook() {
  return renderHook(() =>
    useExplanationDraft({
      onText: () => {},
      getContext: () => ({ title: 'Export the report' }),
    }),
  );
}

async function draft(result: ReturnType<typeof draftHook>['result']) {
  act(() => result.current.start());
  await waitFor(() => expect(result.current.isDrafting).toBe(false));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useExplanationDraft — the draft’s language', () => {
  it('keeps the frame’s language with the draft', async () => {
    stubDraft({ explanationMd: '매주 필요합니다.', language: 'ko' });
    const { result } = draftHook();
    await draft(result);
    expect(result.current.draftBaseline).toBe('매주 필요합니다.');
    expect(result.current.draftLanguage).toBe('ko');
  });

  it('a frame with no language, or one outside the eleven codes, leaves it null', async () => {
    stubDraft({ explanationMd: 'Needed weekly.' });
    const { result } = draftHook();
    await draft(result);
    expect(result.current.draftLanguage).toBeNull();

    stubDraft({ explanationMd: 'Needed weekly.', language: 'xx' });
    await draft(result);
    expect(result.current.draftLanguage).toBeNull();
  });

  it('a regenerate replaces it with the new frame’s, and reset() clears it', async () => {
    stubDraft({ explanationMd: '每周都需要。', language: 'zh' });
    const { result } = draftHook();
    await draft(result);
    expect(result.current.draftLanguage).toBe('zh');

    stubDraft({ explanationMd: 'Jede Woche nötig.', language: 'de' });
    await draft(result);
    expect(result.current.draftLanguage).toBe('de');

    act(() => result.current.reset());
    expect(result.current.draftLanguage).toBeNull();
    expect(result.current.draftBaseline).toBeNull();
  });
});

// MOTIR-10878 — the frames on motir-ai's REAL wire: every progress frame nests its
// payload under `data`, and the job's own `status` / `done` frames do not. Read at
// the top level, `token.text` and `explanation.explanationMd` were `undefined`, so
// the draft streamed into the editor as nothing.
describe('useExplanationDraft — motir-ai’s nested progress frames (MOTIR-10878)', () => {
  it('streams each nested `token` into the editor, then settles on the `explanation`', async () => {
    stubStream([
      { event: 'status', data: { jobId: 'job-1', status: 'running' } },
      progress('status', 1, { phase: 'drafting' }),
      progress('token', 2, { text: 'Needed ' }),
      progress('token', 3, { text: 'weekly.' }),
      progress('explanation', 4, { explanationMd: 'Needed weekly.', language: 'en' }),
      { event: 'status', data: { jobId: 'job-1', status: 'succeeded' } },
      { event: 'done', data: { jobId: 'job-1' } },
    ]);
    const seen: string[] = [];
    const { result } = renderHook(() =>
      useExplanationDraft({
        onText: (text) => seen.push(text),
        getContext: () => ({ title: 'Export the report' }),
      }),
    );
    await draft(result);
    expect(seen).toEqual(['', 'Needed ', 'Needed weekly.', 'Needed weekly.']);
    expect(result.current.draftBaseline).toBe('Needed weekly.');
    expect(result.current.draftLanguage).toBe('en');
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe('idle');
  });

  it('keeps the streamed text and reports the code of the `error` frame that follows', async () => {
    stubStream([
      progress('token', 1, { text: 'Half a draft' }),
      { event: 'status', data: { jobId: 'job-1', status: 'failed' } },
      { event: 'error', data: { code: 'MOTIR_AI_OUT_OF_CREDITS', message: 'No credits.' } },
    ]);
    const { result } = draftHook();
    await draft(result);
    expect(result.current.draftBaseline).toBe('Half a draft');
    expect(result.current.error).toEqual({
      code: 'MOTIR_AI_OUT_OF_CREDITS',
      message: 'No credits.',
    });
    expect(result.current.phase).toBe('error');
  });
});
