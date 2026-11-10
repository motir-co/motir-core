// MOTIR-10880 — the e2e seams that stand in for a relayed motir-ai job stream write
// motir-ai's wire, and the browser readers read it through ONE unwrap.
//
// ⚠️ A TEST ABOUT TEST HELPERS. The browser lanes cross the progress envelope only if
// the bodies they are fed carry it: before this card every planning-rail seam wrote
// its frames flat, so `consumeStream`'s unwrap was never crossed by a browser. These
// cases pin the seams' shape where a unit run sees it, instead of waiting for an e2e
// leg to notice a seam drifting back to flat.
import { afterEach, describe, expect, it } from 'vitest';
import { drainSseFrames, unwrapProgressFrame } from '@/lib/ai/sseFrames';
import * as planEditsClient from '@/lib/planning/planEditsClient';
import { consumeStream } from '@/lib/planning/planEditsClient';
import {
  isUnenvelopedEvent,
  jobStreamBody,
  jobStreamFrame,
} from '../e2e/_helpers/job-stream-frames';
import { startSseFrameServer, type SseFrameServer } from '../e2e/_helpers/sse-frame-server';

const framesOf = (body: string) => drainSseFrames(body).frames;

describe('jobStreamFrame', () => {
  it("wraps a progress frame in motir-ai's { jobId, seq, data } envelope", () => {
    expect(framesOf(jobStreamFrame('note', { text: 'Reading.' }, 'job-1', 3))).toEqual([
      { event: 'note', data: { jobId: 'job-1', seq: 3, data: { text: 'Reading.' } } },
    ]);
  });

  it("writes the job's own status, done and error frames flat", () => {
    const body =
      jobStreamFrame('status', { jobId: 'job-1', status: 'running' }, 'job-1', 1) +
      jobStreamFrame('done', {}, 'job-1', 2) +
      jobStreamFrame('error', { code: 'FAILED' }, 'job-1', 3);
    expect(framesOf(body)).toEqual([
      { event: 'status', data: { jobId: 'job-1', status: 'running' } },
      { event: 'done', data: {} },
      { event: 'error', data: { code: 'FAILED' } },
    ]);
    for (const event of ['status', 'done', 'error']) expect(isUnenvelopedEvent(event)).toBe(true);
    expect(isUnenvelopedEvent('planned')).toBe(false);
  });
});

describe('jobStreamBody', () => {
  it('numbers the progress frames 1, 2, 3… and leaves the job frames unnumbered', () => {
    const body = jobStreamBody('job-7', [
      ['status', { jobId: 'job-7', status: 'running' }],
      ['search', {}],
      ['planned', { proposed: 2 }],
      ['done', {}],
    ]);
    expect(framesOf(body)).toEqual([
      { event: 'status', data: { jobId: 'job-7', status: 'running' } },
      { event: 'search', data: { jobId: 'job-7', seq: 1, data: {} } },
      { event: 'planned', data: { jobId: 'job-7', seq: 2, data: { proposed: 2 } } },
      { event: 'done', data: {} },
    ]);
  });

  it('reads back, through the one unwrap, as the payloads the spec named', () => {
    const body = jobStreamBody('job-7', [
      ['planned', { proposed: 2 }],
      ['done', {}],
    ]);
    expect(framesOf(body).map(({ event, data }) => [event, unwrapProgressFrame(data)])).toEqual([
      ['planned', { proposed: 2, jobId: 'job-7', seq: 1 }],
      ['done', {}],
    ]);
  });
});

describe('the unwrap has one home', () => {
  it('planEditsClient no longer carries its own copy', () => {
    expect('unwrapProgressFrame' in planEditsClient).toBe(false);
  });
});

describe('the incremental SSE frame server', () => {
  let sse: SseFrameServer | null = null;
  afterEach(async () => {
    await sse?.close();
    sse = null;
  });

  /** Open a stream on the server, hand the spec's writes to it, and collect what
   *  `consumeStream` hands its reader — the same reader the planning rail uses. */
  async function readThrough(
    server: SseFrameServer,
    url: string,
    writes: (s: SseFrameServer) => void,
  ): Promise<[string, unknown][]> {
    const frames: [string, unknown][] = [];
    const connected = server.nextConnection();
    let failed: string | null | undefined;
    const done = consumeStream(
      url,
      new AbortController().signal,
      (code) => (failed = code),
      () => {},
      (event, data) => frames.push([event, data]),
    );
    await connected;
    writes(server);
    server.done();
    await done;
    expect(failed).toBeUndefined();
    return frames;
  }

  it('writes progress frames enveloped under the job the request names, numbered per job', async () => {
    sse = await startSseFrameServer();
    const first = await readThrough(sse, `${sse.url}?jobId=job-a`, (s) => {
      s.write('status', { jobId: 'job-a', status: 'running' });
      s.write('note', { text: 'one' });
      s.write('target_settled', {});
    });
    expect(first).toEqual([
      ['status', { jobId: 'job-a', status: 'running' }],
      ['note', { text: 'one', jobId: 'job-a', seq: 1 }],
      ['target_settled', { jobId: 'job-a', seq: 2 }],
    ]);

    // A re-subscribe to the same job continues its numbering, so the rail's
    // `seq <= lastSeq` dedupe never drops a frame the spec wrote.
    const again = await readThrough(sse, `${sse.url}?jobId=job-a`, (s) =>
      s.write('note', { text: 'two' }),
    );
    expect(again).toEqual([['note', { text: 'two', jobId: 'job-a', seq: 3 }]]);

    // Another job starts its own count; a request naming no job gets a stand-in id.
    const other = await readThrough(sse, `${sse.url}?jobId=job-b`, (s) =>
      s.write('note', { text: 'b' }),
    );
    expect(other).toEqual([['note', { text: 'b', jobId: 'job-b', seq: 1 }]]);
    const unnamed = await readThrough(sse, sse.url, (s) => s.write('note', { text: 'x' }));
    expect(unnamed).toEqual([['note', { text: 'x', jobId: 'sse-frame-server-job', seq: 1 }]]);
  });

  it('refuses a write with no open stream', async () => {
    sse = await startSseFrameServer();
    expect(() => sse!.write('note', { text: 'x' })).toThrow('no open stream to write to');
  });
});
