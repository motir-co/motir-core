import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  submitJob,
  getJob,
  cancelJob,
  getPreplanState,
  parseSseFrame,
  createCheckoutSession,
  createPortalSession,
  streamJob,
  MOTIR_AI_REQUEST_TIMEOUT_MS,
  MOTIR_AI_SUBMIT_BUDGET_MS,
  type RequestActor,
} from '@/lib/ai/motirAiClient';
import { verifyJobToken } from '@/lib/ai/jobToken';
import { turnSubmitKey } from '@/lib/ai/turnSubmitKey';
import {
  MotirAiConfigError,
  MotirAiBadRequestError,
  MotirAiUnavailableError,
  MotirAiJobFailedError,
  MotirAiJobNotFoundError,
} from '@/lib/ai/errors';

const tenant = {
  organizationId: 'org_1',
  isMeta: false,
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  projectKey: 'MOTIR',
};
const actor: RequestActor = { userId: 'user_1' };

/** A text/event-stream response carrying the given SSE frames. */
function sseResponse(frames: string[]): Response {
  return new Response(frames.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

beforeEach(() => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('config fail-fast', () => {
  it('throws MotirAiConfigError when MOTIR_AI_URL is unset', async () => {
    delete process.env['MOTIR_AI_URL'];
    await expect(submitJob('noop', tenant, {}, actor)).rejects.toBeInstanceOf(MotirAiConfigError);
  });

  it('throws MotirAiConfigError when the service token is unset', async () => {
    delete process.env['MOTIR_AI_SERVICE_TOKEN'];
    await expect(getJob('job_1', 'pj_1')).rejects.toBeInstanceOf(MotirAiConfigError);
  });
});

describe('submitJob', () => {
  it('posts a valid v1 envelope with a fresh job-scoped token and returns the jobId', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jobId: 'job_42', status: 'queued' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    const { jobId } = await submitJob('noop', tenant, { prompt: 'hi' }, actor);
    expect(jobId).toBe('job_42');

    const [reqUrl, init] = fetchMock.mock.calls[0]!;
    expect(reqUrl).toBe('https://ai.example.test/v1/jobs');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer svc-token');

    const body = JSON.parse(init.body);
    expect(body.envelopeVersion).toBe('v1');
    expect(body.jobKind).toBe('noop');
    expect(body.tenant).toEqual(tenant);
    expect(body.context).toEqual({ prompt: 'hi' });
    // the minted read-back token verifies and is scoped to the actor + project
    const claims = verifyJobToken(body.readBackToken);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('user_1');
    expect(claims!.projectId).toBe('pj_1');
  });

  it('gives every submission its own per-job rate-limit key (MOTIR-8599)', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ jobId: 'j', status: 'queued' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    await submitJob('noop', tenant, { prompt: 'a' }, actor);
    await submitJob('noop', tenant, { prompt: 'b' }, actor);

    const keys = fetchMock.mock.calls.map(
      ([, init]) => verifyJobToken(JSON.parse(init.body as string).readBackToken)!.jobKey,
    );
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('maps a 400 problem+json to MotirAiBadRequestError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { type: 't', title: 'bad', status: 400, code: 'validation_error', detail: 'nope' },
            400,
          ),
        ),
    );
    await expect(submitJob('noop', tenant, {}, actor)).rejects.toBeInstanceOf(
      MotirAiBadRequestError,
    );
  });

  it('maps a network failure to MotirAiUnavailableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(submitJob('noop', tenant, {}, actor)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });

  // MOTIR-7337: undici throws one `TypeError('fetch failed')` for every
  // transport failure, and the only thing that says WHICH is `err.cause`.
  it('names the transport failure on a REAL refused connection, and keeps the cause', async () => {
    // A port that was just listening and is now closed: a genuine ECONNREFUSED
    // through Node's own fetch, no stub in between.
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env['MOTIR_AI_URL'] = `http://127.0.0.1:${port}`;

    const err = await submitJob('noop', tenant, {}, actor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MotirAiUnavailableError);
    expect((err as Error).message).toBe('motir-ai is unavailable: fetch failed (ECONNREFUSED)');
    expect(((err as Error).cause as Error).message).toBe('fetch failed');
  });

  it('names a nested cause by its code only — never the host or address it carries', async () => {
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND motir-ai.internal'), {
      code: 'ENOTFOUND',
    });
    const thrown = new TypeError('fetch failed', { cause: dns });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(thrown));

    const err = await submitJob('noop', tenant, {}, actor).catch((e: unknown) => e);
    expect((err as Error).message).toBe('motir-ai is unavailable: fetch failed (ENOTFOUND)');
    // The message reaches API callers; the private name must not.
    expect((err as Error).message).not.toContain('motir-ai.internal');
    expect((err as Error).cause).toBe(thrown);
  });

  it('leaves a failure with no coded cause exactly as it was', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const err = await submitJob('noop', tenant, {}, actor).catch((e: unknown) => e);
    expect((err as Error).message).toBe('motir-ai is unavailable: ECONNREFUSED');
  });
});

describe('submitJob — resume (MOTIR-7916)', () => {
  it('puts `resume` on the envelope when given, and leaves the body byte-identical when not', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ jobId: 'j', status: 'queued' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    await submitJob('plan', tenant, { prompt: 'x' }, actor);
    await submitJob('plan', tenant, { prompt: 'x' }, actor, {
      resume: { planId: 'plan-1', fromJobId: 'job-1' },
    });

    const plain = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const resumed = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(plain).not.toHaveProperty('resume');
    expect(Object.keys(plain)).toEqual([
      'envelopeVersion',
      'jobKind',
      'tenant',
      'context',
      'readBackToken',
    ]);
    expect(resumed.resume).toEqual({ planId: 'plan-1', fromJobId: 'job-1' });
  });
});

describe('submitJob — a keyed submit rides out a waking machine (MOTIR-9255)', () => {
  /** A fetch that hangs until the caller's own AbortSignal fires. */
  const hang = (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });

  beforeEach(() => {
    // Time still flows, so the org-flag read before the post meets a live clock;
    // the test jumps it forward over the deadline and the pauses.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let the org-flag read reach the first post before time is jumped. */
  async function untilPosted(fetchMock: ReturnType<typeof vi.fn>, calls = 1): Promise<void> {
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(calls));
  }

  it('⚠️ a first attempt that TIMES OUT is re-sent under the SAME key, and the job it returns is the answer', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(hang)
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job_late', status: 'succeeded' }, 202));
    vi.stubGlobal('fetch', fetchMock);
    const key = turnSubmitKey('turn_1', 'guide_work_item', null);

    const pending = submitJob('guide_work_item', tenant, {}, actor, { idempotencyKey: key });
    await untilPosted(fetchMock);
    await vi.advanceTimersByTimeAsync(MOTIR_AI_REQUEST_TIMEOUT_MS + 5_000);

    await expect(pending).resolves.toEqual({ jobId: 'job_late' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((c) =>
      JSON.parse((c[1] as RequestInit).body as string),
    );
    expect(bodies.map((b) => b.idempotencyKey)).toEqual([key, key]);
    // One envelope, sent twice — the read-back token is minted once per job.
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it('re-sends a transport failure and a 5xx from a proxy that could not wake the machine', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ code: 'internal_error', status: 502, title: 'x' }, 502))
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job_1', status: 'queued' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    const pending = submitJob('ask_project', tenant, {}, actor, { idempotencyKey: 'k' });
    await untilPosted(fetchMock);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ jobId: 'job_1' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up TYPED once the budget is spent', async () => {
    const fetchMock = vi.fn().mockImplementation(hang);
    vi.stubGlobal('fetch', fetchMock);

    const pending = submitJob('ask_project', tenant, {}, actor, { idempotencyKey: 'k' });
    const assertion = expect(pending).rejects.toBeInstanceOf(MotirAiUnavailableError);
    await untilPosted(fetchMock);
    await vi.advanceTimersByTimeAsync(MOTIR_AI_SUBMIT_BUDGET_MS);
    await assertion;
    // 30 s + 2 s pause + 30 s + 2 s pause + the 26 s left — never past the budget.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never re-sends a refusal that is not about reaching motir-ai', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ code: 'validation_error', status: 400, title: 'bad', detail: 'bad' }, 400),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      submitJob('ask_project', tenant, {}, actor, { idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(MotirAiBadRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a KEYLESS submit is one attempt, as it always was — a re-send could create a second job', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitJob('noop', tenant, {}, actor)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).not.toHaveProperty(
      'idempotencyKey',
    );
  });

  it('keys one ATTEMPT of a turn: a re-send reuses it, a retry after a failed job does not', () => {
    expect(turnSubmitKey('t1', 'ask_project', null)).toBe(turnSubmitKey('t1', 'ask_project', null));
    expect(turnSubmitKey('t1', 'ask_project', 'job_failed')).not.toBe(
      turnSubmitKey('t1', 'ask_project', null),
    );
    expect(turnSubmitKey('t1', 'guide_work_item', 'job_a')).not.toBe(
      turnSubmitKey('t1', 'ask_project', 'job_a'),
    );
  });
});

describe('getJob', () => {
  it('returns a succeeded view with the result and no error', async () => {
    // The WIRE body motir-ai actually sends — `planDelta` included. Core dropped
    // that field from its `ResultEnvelope` mirror (MOTIR-1747: it is empty by
    // construction and nothing reads it), and results are read loosely, so the
    // extra key must pass through untouched rather than trip the client.
    const result = {
      envelopeVersion: 'v1',
      jobKind: 'noop',
      planDelta: { operations: [] },
      summary: 'ok',
      usage: { model: null, inputTokens: 0, outputTokens: 0 },
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ jobId: 'job_1', status: 'succeeded', result, error: null }),
        ),
    );
    const view = await getJob('job_1', 'pj_1');
    expect(view.status).toBe('succeeded');
    expect(view.result).toEqual(result);
    expect(view.error).toBeNull();
  });

  it('maps a failed job error into a typed error on the view', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          jobId: 'job_1',
          status: 'failed',
          result: null,
          error: { type: 't', title: 'failed', status: 500, code: 'ai_job_failed', detail: 'boom' },
        }),
      ),
    );
    const view = await getJob('job_1', 'pj_1');
    expect(view.status).toBe('failed');
    // A job's terminal `ai_job_failed` is the handler refusing, not motir-ai being
    // down (MOTIR-8569) — so the view carries the job-failed class, unprefixed.
    expect(view.error).toBeInstanceOf(MotirAiJobFailedError);
    expect(view.error?.message).toBe('motir-ai job failed: boom');
  });

  it('throws MotirAiJobNotFoundError on a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { type: 't', title: 'nf', status: 404, code: 'not_found', jobId: 'job_x' },
            404,
          ),
        ),
    );
    await expect(getJob('job_x', 'pj_1')).rejects.toBeInstanceOf(MotirAiJobNotFoundError);
  });
});

describe('cancelJob (MOTIR-9065)', () => {
  it('sends DELETE /v1/jobs/:id with the project scope and returns the answer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jobId: 'job_1', status: 'canceled' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cancelJob('job_1', 'pj_42')).resolves.toEqual({
      jobId: 'job_1',
      status: 'canceled',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://ai.example.test/v1/jobs/job_1?coreProjectId=pj_42');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('throws a typed error when motir-ai refuses, so the caller can say why', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('404 Not Found', { status: 404, statusText: 'Not Found' })),
    );
    // A bare 404 is not problem+json, so it reads as motir-ai's own failure, carrying
    // the status text the sweep reports as why.
    await expect(cancelJob('job_1', 'pj_1')).rejects.toThrow(MotirAiUnavailableError);
    await expect(cancelJob('job_1', 'pj_1')).rejects.toThrow('Not Found');
  });
});

describe('getJob — the lost-machine fact (MOTIR-8304)', () => {
  const failedWith = (code: string, status = 500) =>
    jsonResponse({
      jobId: 'job_1',
      status: 'failed',
      result: null,
      error: { type: 't', title: 'failed', status, code, detail: 'detail', jobId: 'job_1' },
    });

  it('a job motir-ai reaped as abandoned is a lost machine, and still MOTIR_AI_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failedWith('ai_job_abandoned')));
    const view = await getJob('job_1', 'pj_1');
    expect(view.lostMachine).toBe(true);
    expect(view.error).toBeInstanceOf(MotirAiUnavailableError);
    expect(view.error?.code).toBe('MOTIR_AI_UNAVAILABLE');
  });

  it.each([
    ['ai_job_failed', 500, 'MOTIR_AI_JOB_FAILED'],
    ['rate_limited', 429, 'MOTIR_AI_UNAVAILABLE'],
    ['internal_error', 500, 'MOTIR_AI_UNAVAILABLE'],
  ])('a %s failure is not a lost machine, and maps to %s', async (code, status, mapped) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failedWith(code, status)));
    const view = await getJob('job_1', 'pj_1');
    expect(view.lostMachine).toBe(false);
    expect(view.error?.code).toBe(mapped);
  });

  it('a running job is not a lost machine', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ jobId: 'job_1', status: 'running', result: null, error: null }),
        ),
    );
    expect((await getJob('job_1', 'pj_1')).lostMachine).toBe(false);
  });
});

describe('getJob — the resumable verdict (MOTIR-9121)', () => {
  const failed = (extra: Record<string, unknown>) =>
    jsonResponse({
      jobId: 'job_1',
      status: 'failed',
      result: null,
      error: {
        type: 't',
        title: 'Validation failed',
        status: 400,
        code: 'validation_error',
        detail: 'd',
        jobId: 'job_1',
      },
      ...extra,
    });

  it.each([true, false])('passes motir-ai’s `resumable: %s` through', async (resumable) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failed({ resumable })));
    expect((await getJob('job_1', 'pj_1')).resumable).toBe(resumable);
  });

  it('a motir-ai that does not say leaves it absent — unknown, never false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failed({})));
    expect(Object.keys(await getJob('job_1', 'pj_1'))).not.toContain('resumable');
  });

  it('a value that is not a boolean reads as unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failed({ resumable: 'no' })));
    expect(Object.keys(await getJob('job_1', 'pj_1'))).not.toContain('resumable');
  });
});

describe('getPreplanState', () => {
  const query = { coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1' };

  it('GETs /v1/preplan with the core ids + service credential, returns the parsed state', async () => {
    const state = {
      session: {
        aiProjectId: 'ai_1',
        classification: 'startup',
        platform: 'web',
        docSkipSet: ['feasibility'],
        designStarter: 'next-prisma-vercel',
        validationTiming: 'standard',
        currentGate: 'vision',
        conversation: [{ role: 'user', content: 'hi' }],
        status: 'active',
        createdAt: '2026-06-19T00:00:00.000Z',
        updatedAt: '2026-06-19T00:00:00.000Z',
      },
      docs: [
        {
          kind: 'discovery',
          currentBody: '# Discovery (Tier 1)\n\n## 1. Audience\n\nEnterprise teams.',
          currentVersion: 2,
          summary: [],
          versions: [
            { version: 1, changeReason: null, changeKind: 'created', diff: null, createdAt: '…' },
            {
              version: 2,
              changeReason: 'enterprise audience',
              changeKind: 'direct_revision',
              diff: [{ path: 'problem.gap', kind: 'changed', before: 'a', after: 'b' }],
              createdAt: '…',
            },
          ],
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(state));
    vi.stubGlobal('fetch', fetchMock);

    const got = await getPreplanState(query);

    const [reqUrl, init] = fetchMock.mock.calls[0]!;
    const u = new URL(reqUrl as string);
    expect(u.pathname).toBe('/v1/preplan');
    expect(u.searchParams.get('coreWorkspaceId')).toBe('ws_1');
    expect(u.searchParams.get('coreProjectId')).toBe('pj_1');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer svc-token' });
    expect(got).toEqual(state);
  });

  it('returns the empty state for a not-yet-started project (not an error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ session: null, docs: [] })));
    expect(await getPreplanState(query)).toEqual({ session: null, docs: [] });
  });

  it('maps a 400 to a typed bad-request error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ type: 't', title: 'bad', status: 400, code: 'validation_error' }, 400),
        ),
    );
    await expect(getPreplanState(query)).rejects.toBeInstanceOf(MotirAiBadRequestError);
  });

  it('maps a transport failure to MotirAiUnavailableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(getPreplanState(query)).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('createCheckoutSession', () => {
  const input = {
    coreOrganizationId: 'org_1',
    priceId: 'pro_pool_annual',
    successUrl: 'https://app.test/settings/organization/billing?checkout=success',
    cancelUrl: 'https://app.test/settings/organization/billing?checkout=cancel',
  };

  it('passes through the existing_plan pointer for an org on a live plan (MOTIR-8394)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          outcome: 'existing_plan',
          livePriceLookupKey: 'max_pool_annual',
          upgradePath: true,
        }),
      ),
    );
    expect(await createCheckoutSession(input)).toEqual({
      outcome: 'existing_plan',
      livePriceLookupKey: 'max_pool_annual',
    });
  });

  it('POSTs the input to /v1/stripe/checkout-session and returns the hosted url', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await createCheckoutSession(input);
    expect(res).toEqual({ outcome: 'session', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });

    const [reqUrl, init] = fetchMock.mock.calls[0]!;
    expect(reqUrl).toBe('https://ai.example.test/v1/stripe/checkout-session');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer svc-token');
    expect(JSON.parse(init.body)).toEqual(input);
  });

  it('carries the top-up bundle `quantity` on the wire under that exact name (MOTIR-2949)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ url: 'https://checkout.stripe.com/c/pay/cs_test_2' }));
    vi.stubGlobal('fetch', fetchMock);

    await createCheckoutSession({ ...input, priceId: 'credit_topup', quantity: 10 });

    // motir-ai reads `quantity` (an optional integer >= 1) off the body and hands
    // it to `line_items[].quantity` — a rename on this side silently reverts the
    // charge to one unit, which is the bug this field exists to close.
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ ...input, priceId: 'credit_topup', quantity: 10 });
  });

  it('maps a problem+json error to a typed error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ code: 'validation_error', title: 'bad price', status: 400 }, 400),
        ),
    );
    await expect(createCheckoutSession(input)).rejects.toBeInstanceOf(MotirAiBadRequestError);
  });

  it('throws when a 2xx response is missing the url', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 200)));
    await expect(createCheckoutSession(input)).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('maps a transport failure to MotirAiUnavailableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(createCheckoutSession(input)).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('createPortalSession', () => {
  const input = {
    coreOrganizationId: 'org_1',
    returnUrl: 'https://app.test/settings/organization/billing',
  };

  it('POSTs to /v1/stripe/portal-session and returns the portal url', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ url: 'https://billing.stripe.com/p/session/1' }));
    vi.stubGlobal('fetch', fetchMock);

    const { url } = await createPortalSession(input);
    expect(url).toBe('https://billing.stripe.com/p/session/1');

    const [reqUrl, init] = fetchMock.mock.calls[0]!;
    expect(reqUrl).toBe('https://ai.example.test/v1/stripe/portal-session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(input);
  });

  it('maps a 404 (no Stripe customer yet) to MotirAiJobNotFoundError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ code: 'not_found', title: 'no customer', status: 404 }, 404),
        ),
    );
    await expect(createPortalSession(input)).rejects.toBeInstanceOf(MotirAiJobNotFoundError);
  });
});

// ⚠️ THE BYTE-UPLOAD SUITE IS GONE, AND SO IS WHAT IT TESTED (MOTIR-2138). This
// file used to carry an `indexCodeGraph` describe block — the raw-gzip POST to
// motir-ai's ingest route, the one binary method on this boundary. Both
// code-graph jobs moved onto the container fleet (MOTIR-2027 / MOTIR-2057) and
// the method then sat here with no caller, kept alive by these very tests. It is
// deleted; the guarantee that nothing re-adopts it is asserted as ABSENCE where
// the jobs run (`tests/jobs/code-graph-index.test.ts`,
// `tests/github/codeGraphIndexService.test.ts`), which no spy could do.
//
// The concrete consequence for THIS file: the boundary is JSON-only, so it has
// ONE deadline, and the cases below pin that rather than the two-tier split.

// ── The deadline (MOTIR-1974) ───────────────────────────────────────────────
//
// A motir-ai that ACCEPTS the connection and then never answers is the failure
// this pins, and it is worse than a refused one: with no deadline, `fetch` waits
// forever and the caller is killed from outside. In production that caller was a
// background job on Vercel, so the kill arrived as a bare
// `FUNCTION_INVOCATION_TIMEOUT` 504 with no step output — Inngest saw an untyped
// platform error, not a `MotirAiUnavailableError` its retry budget could reason
// about, and all five `system.code-graph-index` runs dead-lettered.
//
// The stub below never resolves; it only settles when the client's OWN abort
// fires. So if the deadline is ever removed, this test hangs to the vitest
// timeout instead of quietly passing — the failure mode it guards IS the failure
// mode of the test.
describe('request deadlines', () => {
  /** A fetch that hangs until the caller's own AbortSignal fires. */
  function hangingFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason ?? new Error('aborted')),
          );
        }),
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails a hanging call fast and TYPED, at MOTIR_AI_REQUEST_TIMEOUT_MS — not a tick before', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const pending = getPreplanState({ coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1' });
    const assertion = expect(pending).rejects.toBeInstanceOf(MotirAiUnavailableError);

    // One tick short of the deadline it is still waiting — the timeout is the
    // declared constant, not an incidental shorter one.
    await vi.advanceTimersByTimeAsync(MOTIR_AI_REQUEST_TIMEOUT_MS - 1);
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it('reports the deadline rather than the runtime’s opaque abort message', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const pending = getJob('job_1', 'pj_1');
    const assertion = expect(pending).rejects.toThrow(
      `motir-ai did not respond within ${MOTIR_AI_REQUEST_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(MOTIR_AI_REQUEST_TIMEOUT_MS);
    await assertion;
  });
});

describe('parseSseFrame', () => {
  it('parses an event + JSON data frame', () => {
    const ev = parseSseFrame('event: status\ndata: {"jobId":"job_1","status":"running"}');
    expect(ev).toEqual({ event: 'status', data: { jobId: 'job_1', status: 'running' } });
  });

  it('defaults the event name and keeps non-JSON data as a string', () => {
    expect(parseSseFrame('data: hello')).toEqual({ event: 'message', data: 'hello' });
  });

  it('returns null for a comment-only / dataless frame', () => {
    expect(parseSseFrame(': keep-alive')).toBeNull();
    expect(parseSseFrame('event: status')).toBeNull();
  });
});

// MOTIR-2359 — the core project id rides every job read and stream. Asserted on
// the REQUEST URL the fake fetch receives, not on the return value: what is being
// proved is that the id reaches motir-ai, and a service's own output cannot show
// that. Until MOTIR-2360 lands, motir-ai ignores the parameter — sending one the
// producer does not read is harmless; requiring one the consumer does not send is
// not, which is why the order is this way round.
describe('the boundary sends the core project id (MOTIR-2359)', () => {
  it('getJob puts ?coreProjectId= on the job read', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ jobId: 'job_1', status: 'succeeded', result: null, error: null }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await getJob('job_1', 'pj_42');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/v1/jobs/job_1?');
    expect(new URL(url).searchParams.get('coreProjectId')).toBe('pj_42');
  });

  it('streamJob puts ?coreProjectId= on the stream open', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['event: done\ndata: {}\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    for await (const _ of streamJob('job_1', 'pj_42')) break;
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/v1/jobs/job_1/stream?');
    expect(new URL(url).searchParams.get('coreProjectId')).toBe('pj_42');
  });
});
