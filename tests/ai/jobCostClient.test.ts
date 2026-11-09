import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getJobCost } from '@/lib/ai/motirAiClient';
import {
  MotirAiConfigError,
  MotirAiJobNotFoundError,
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';

// `getJobCost` (MOTIR-10815) — one plan job's cost from motir-ai's
// `GET /v1/jobs/:id/cost?coreProjectId=` (MOTIR-10814). Unlike the agent-run usage
// read, a 404 is NOT a value: motir-ai answers it for another project's job, and
// reading that as zeros would be a plan that cost nothing.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getJobCost', () => {
  it('GETs the job cost scoped by project, with the service credential', async () => {
    const body = {
      jobId: 'job/1',
      ledgerComplete: true,
      totalCostMicroUsd: 700,
      credits: 10,
      bySessionKind: { conversation: 100, lay: 300, author: 300, entry_author: 0, tool: 0 },
    };
    const fetchMock = vi.fn(async () => json(body));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getJobCost('job/1', 'proj_1')).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ai.test/v1/jobs/job%2F1/cost?coreProjectId=proj_1');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer svc-token');
  });

  it('hands the figures back as they arrived — a null, a string, a missing key stay so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ jobId: 'job_1', ledgerComplete: false, totalCostMicroUsd: null, credits: '3' }),
      ),
    );
    const cost = await getJobCost('job_1', 'proj_1');
    expect(cost.totalCostMicroUsd).toBe(null);
    expect(cost.credits).toBe('3');
    expect(cost.bySessionKind).toBeUndefined();
  });

  it('throws the typed not_found on a 404 — never a value', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ code: 'not_found', status: 404, title: 'job not found' }, 404)),
    );
    await expect(getJobCost('job_1', 'proj_1')).rejects.toBeInstanceOf(MotirAiJobNotFoundError);
  });

  it('throws the typed error on any other non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ code: 'service_unauthorized', status: 401, title: 'bad token' }, 401),
      ),
    );
    await expect(getJobCost('job_1', 'proj_1')).rejects.toBeInstanceOf(MotirAiUnauthorizedError);
  });

  it('throws unavailable on a body that is not an object', async () => {
    for (const body of [null, [1, 2], 'nope']) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => json(body)),
      );
      await expect(getJobCost('job_1', 'proj_1')).rejects.toBeInstanceOf(MotirAiUnavailableError);
    }
  });

  it('throws the config error when motir-ai is not configured', async () => {
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', '');
    await expect(getJobCost('job_1', 'proj_1')).rejects.toBeInstanceOf(MotirAiConfigError);
  });
});
