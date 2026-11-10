import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import type { JobStreamEvent } from '@/lib/ai/types';
import type { AiJobsFixture } from '@/lib/test-ai-jobs-mock';

// MOTIR-10878 — the in-repo motir-ai mock's `GET /v1/jobs/:id/stream` writes its
// frames in the shape motir-ai does (`motir-ai/src/app.ts`, `flushProgress`): a
// PROGRESS frame nests the payload as `{ jobId, seq, data }`, the job's own
// `status` / `done` frames are flat. It used to write progress frames flat, which
// is how three browser readers that read the payload at the top level went unseen
// by every e2e and acceptance lane. Crossed on the wire by the REAL relay client
// (`streamJob`) through the undici intercept the lanes install.

const ORIGIN = 'http://motir-ai.stream-wire-mock.test';
let fixturePath: string;
let agent: MockAgent;

beforeAll(async () => {
  fixturePath = join(mkdtempSync(join(tmpdir(), 'motir-stream-wire-')), 'jobs.json');
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', fixturePath);
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const { installAiJobsBoundaryMock } = await import('@/lib/test-ai-jobs-mock');
  installAiJobsBoundaryMock(agent);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await agent.close();
});

const { streamJob } = await import('@/lib/ai/motirAiClient');
const { unwrapProgressFrame } = await import('@/lib/ai/sseFrames');
const { walkPositionOf } = await import('@/lib/ai/jobStream');

function declare(fixture: AiJobsFixture): void {
  writeFileSync(fixturePath, JSON.stringify(fixture));
}

async function frames(jobId: string): Promise<JobStreamEvent[]> {
  const out: JobStreamEvent[] = [];
  for await (const frame of streamJob(jobId, 'proj-1')) out.push(frame);
  return out;
}

describe('the jobs mock’s stream writes motir-ai’s wire (MOTIR-10878)', () => {
  it('nests a draft’s `token` and `explanation` frames, and keeps `status` / `done` flat', async () => {
    declare({ generateExplanation: [{ explanationMd: 'Needed weekly.', language: 'en' }] });
    const jobId = 'e2e-generate_explanation-0';

    expect(await frames(jobId)).toEqual([
      { event: 'token', data: { jobId, seq: 1, data: { text: 'Needed ' } } },
      { event: 'token', data: { jobId, seq: 2, data: { text: 'weekly.' } } },
      {
        event: 'explanation',
        data: { jobId, seq: 3, data: { explanationMd: 'Needed weekly.', language: 'en' } },
      },
      { event: 'status', data: { jobId, status: 'succeeded' } },
      { event: 'done', data: { jobId } },
    ]);
  });

  it('a draft frame read through the envelope gives back the payload the job emitted', async () => {
    declare({ generateExplanation: [{ explanationMd: 'Weekly.' }] });
    const [first] = await frames('e2e-generate_explanation-0');
    expect(unwrapProgressFrame(first!.data)).toMatchObject({ text: 'Week' });
  });

  it('nests a failed run’s `walk_position`, which the relay still reads as the stop point', async () => {
    declare({
      plan: [
        {
          status: 'failed',
          walkStop: {
            phase: 'author',
            target: 'planItem:a',
            targetTitle: 'Export',
            depth: 2,
            reasonCode: 'provider_error',
          },
        },
      ],
    });
    const jobId = 'e2e-plan-0';
    const relayed = await frames(jobId);

    expect(relayed.map((f) => f.event)).toEqual(['search', 'walk_position', 'status', 'done']);
    expect(relayed[0]!.data).toEqual({ jobId, seq: 1, data: {} });
    expect(relayed[1]!.data).toEqual({
      jobId,
      seq: 2,
      data: { phase: 'author', target: 'planItem:a', targetTitle: 'Export', depth: 2 },
    });
    expect(relayed[2]!.data).toEqual({ jobId, status: 'failed' });
    expect(relayed.map(walkPositionOf).filter(Boolean)).toEqual([
      { phase: 'author', target: 'planItem:a', targetTitle: 'Export', depth: 2 },
    ]);
  });

  it('a succeeded run that reports its status sends it flat, after the nested `search`', async () => {
    declare({ plan: [{ status: 'succeeded', statusFrame: true }] });
    const jobId = 'e2e-plan-0';
    expect(await frames(jobId)).toEqual([
      { event: 'search', data: { jobId, seq: 1, data: {} } },
      { event: 'status', data: { jobId, status: 'succeeded' } },
      { event: 'done', data: { jobId } },
    ]);
  });

  it('a plain succeeded run sends the nested `search` and the close', async () => {
    declare({ plan: [{ status: 'succeeded' }] });
    const jobId = 'e2e-plan-0';
    expect(await frames(jobId)).toEqual([
      { event: 'search', data: { jobId, seq: 1, data: {} } },
      { event: 'done', data: { jobId } },
    ]);
  });

  it('a HELD run’s window carries the nested `search`, the flat status and the timed-out close', async () => {
    declare({ plan: [{ status: 'running' }] });
    const jobId = 'e2e-plan-0';
    // One window, read raw: `streamJob` would follow held windows for ever.
    const res = await fetch(`${ORIGIN}/v1/jobs/${jobId}/stream?coreProjectId=proj-1`);
    expect(await res.text()).toBe(
      [
        `event: search\ndata: ${JSON.stringify({ jobId, seq: 1, data: {} })}\n\n`,
        `event: status\ndata: ${JSON.stringify({ jobId, status: 'running' })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ jobId, timedOut: true })}\n\n`,
      ].join(''),
    );
  });
});
