// MOTIR-10864 — motir-ai writes every progress frame as `{ jobId, seq, data: <payload> }`,
// and core relays it unchanged. The one browser consumer flattens it, so a reader that
// reads `data.text` on a `note` reads the session's sentence and not `undefined`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeStream } from '@/lib/planning/planEditsClient';
import { narrateFrame, withAskAct } from '@/lib/hooks/usePlanChangeConversation';

const enc = new TextEncoder();

/** One SSE frame exactly as motir-ai's `GET /v1/jobs/:id/stream` writes it. */
const wireProgress = (event: string, seq: number, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify({ jobId: 'job-1', seq, data })}\n\n`;

function sseResponse(body: string): Response {
  let sent = false;
  const reader = {
    read: async () => {
      if (sent) return { done: true, value: undefined };
      sent = true;
      return { done: false, value: enc.encode(body) };
    },
  };
  return { ok: true, body: { getReader: () => reader } } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('consumeStream over the real wire', () => {
  it("hands every note's sentence to the reader, in order — the reported job's 16 calls", async () => {
    const sentences = Array.from({ length: 16 }, (_, i) => `Reading part ${i + 1} of the plan.`);
    const body =
      `event: status\ndata: ${JSON.stringify({ jobId: 'job-1', status: 'running' })}\n\n` +
      sentences.map((text, i) => wireProgress('note', i + 1, { text })).join('') +
      `event: done\ndata: ${JSON.stringify({ jobId: 'job-1' })}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(body)),
    );
    const frames: [string, unknown][] = [];
    const onDone = vi.fn();

    await consumeStream('/s', new AbortController().signal, vi.fn(), onDone, (e, d) =>
      frames.push([e, d]),
    );

    expect(frames[0]).toEqual(['status', { jobId: 'job-1', status: 'running' }]);
    const notes = frames.filter(([e]) => e === 'note');
    expect(notes.map(([e, d]) => narrateFrame(e, d))).toEqual(
      sentences.map((text) => ({ kind: 'note', text })),
    );
    expect(notes.map(([, d]) => (d as { seq: number }).seq)).toEqual(
      sentences.map((_, i) => i + 1),
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('withAskAct', () => {
  it('lets a note take the place of the reading line, and appends anything else', () => {
    const reading = [{ kind: 'reading' as const }];
    const first = withAskAct(reading, { kind: 'note', text: 'a' });
    expect(first).toEqual([{ kind: 'note', text: 'a' }]);
    expect(withAskAct(first, { kind: 'note', text: 'b' })).toEqual([
      { kind: 'note', text: 'a' },
      { kind: 'note', text: 'b' },
    ]);
    expect(withAskAct(reading, { kind: 'redirected' })).toEqual([
      { kind: 'reading' },
      { kind: 'redirected' },
    ]);
    expect(reading).toEqual([{ kind: 'reading' }]);
  });
});
