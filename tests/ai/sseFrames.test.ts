import { describe, expect, it } from 'vitest';
import { drainSseFrames, parseSseFrame, unwrapProgressFrame } from '@/lib/ai/sseFrames';

describe('parseSseFrame', () => {
  it('parses an event + JSON data frame', () => {
    expect(parseSseFrame('event: assistant\ndata: {"text":"hi"}')).toEqual({
      event: 'assistant',
      data: { text: 'hi' },
    });
  });

  it('defaults the event to "message" and leaves non-JSON data as a string', () => {
    expect(parseSseFrame('data: plain')).toEqual({ event: 'message', data: 'plain' });
  });

  it('ignores comment (keep-alive) lines and joins multi-line data', () => {
    expect(parseSseFrame(': keep-alive\nevent: docs\ndata: {"a":1}')).toEqual({
      event: 'docs',
      data: { a: 1 },
    });
  });

  it('returns null for a frame with no data line', () => {
    expect(parseSseFrame('event: status')).toBeNull();
  });
});

describe('drainSseFrames', () => {
  it('splits complete frames and returns the unconsumed remainder', () => {
    const buf =
      'event: assistant\ndata: {"text":"a"}\n\nevent: status\ndata: {"phase":"drafting"}\n\nevent: assistant\ndata: {"text":"b"';
    const { frames, rest } = drainSseFrames(buf);
    expect(frames).toEqual([
      { event: 'assistant', data: { text: 'a' } },
      { event: 'status', data: { phase: 'drafting' } },
    ]);
    // the third frame is incomplete (no trailing blank line) → carried over
    expect(rest).toBe('event: assistant\ndata: {"text":"b"');
  });

  it('returns no frames when the buffer holds no complete frame', () => {
    const { frames, rest } = drainSseFrames('event: assistant\ndata: {"text":"a"}');
    expect(frames).toEqual([]);
    expect(rest).toBe('event: assistant\ndata: {"text":"a"}');
  });
});

// MOTIR-10878 — motir-ai writes every PROGRESS frame as `{ jobId, seq, data }`
// (`motir-ai/src/app.ts` `flushProgress`); the job's own frames carry no envelope.
describe('unwrapProgressFrame', () => {
  it('returns a progress frame’s payload, with the envelope’s jobId and seq', () => {
    expect(unwrapProgressFrame({ jobId: 'job-1', seq: 3, data: { text: 'Hel' } })).toEqual({
      text: 'Hel',
      jobId: 'job-1',
      seq: 3,
    });
  });

  it('unwraps an envelope with no jobId, keeping its seq', () => {
    expect(unwrapProgressFrame({ seq: 2, data: { text: 'lo' } })).toEqual({ text: 'lo', seq: 2 });
  });

  it('lets the envelope’s jobId and seq win over the payload’s', () => {
    expect(
      unwrapProgressFrame({ jobId: 'job-1', seq: 4, data: { jobId: 'other', seq: 99, x: 1 } }),
    ).toEqual({ x: 1, jobId: 'job-1', seq: 4 });
  });

  it('passes the job’s own status, done and error frames through unchanged', () => {
    const status = { jobId: 'job-1', status: 'succeeded' };
    const done = { jobId: 'job-1', timedOut: true };
    const error = { code: 'MOTIR_AI_UNAVAILABLE', message: 'down' };
    expect(unwrapProgressFrame(status)).toBe(status);
    expect(unwrapProgressFrame(done)).toBe(done);
    expect(unwrapProgressFrame(error)).toBe(error);
  });

  it('passes a flat frame, and anything that is not the exact envelope, through unchanged', () => {
    const flat = { text: 'hi' };
    expect(unwrapProgressFrame(flat)).toBe(flat);
    for (const notEnvelope of [
      { jobId: 'job-1', seq: 1, data: {}, status: 'running' },
      { jobId: 'job-1', seq: '1', data: {} },
      { jobId: 'job-1', seq: 1, data: 'text' },
      { jobId: 'job-1', seq: 1, data: null },
      { jobId: 'job-1', seq: 1, data: [1] },
    ]) {
      expect(unwrapProgressFrame(notEnvelope)).toBe(notEnvelope);
    }
    expect(unwrapProgressFrame(null)).toBeNull();
    expect(unwrapProgressFrame('raw')).toBe('raw');
    const list = [1, 2];
    expect(unwrapProgressFrame(list)).toBe(list);
  });
});
