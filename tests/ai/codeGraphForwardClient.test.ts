import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MotirAiConfigError,
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';
import {
  MOTIR_AI_REQUEST_TIMEOUT_MS,
  forwardPullRequestState,
  forwardRetire,
} from '@/lib/ai/motirAiClient';

// THE CODE-GRAPH FORWARD clients (MOTIR-12055 · story MOTIR-11870), against motir-ai's
// `POST /v1/code-graph/pull-request-state` and `POST /v1/code-graph/retire`
// (motir-ai `docs/contract.md`). The status split is the contract the forward job's
// retry rests on: settled and refused are DATA, unavailable and unauthorized THROW.

const SCOPE = { coreOrganizationId: 'org_1', repoRef: 'moooon/motir-core' };
const OPEN = {
  ...SCOPE,
  ref: 'feature-x',
  pullRequestNumber: 42,
  state: 'open' as const,
  reportedAt: '2026-11-22T10:00:00Z',
};
const RETIRE = { ...SCOPE, ref: 'feature-x' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

const problem = (code: string, status: number) =>
  jsonResponse({ type: `https://motir.co/errors/${code}`, title: code, status, code }, status);

function stubFetch(response: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const sent = (fetchMock: ReturnType<typeof stubFetch>) => {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) as unknown };
};

beforeEach(() => {
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example.test/');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const calls = [
  {
    name: 'forwardPullRequestState',
    route: 'pull-request-state',
    call: () => forwardPullRequestState(OPEN),
    outcomes: ['recorded', 'stale', 'unknown_ref', 'default_branch'],
  },
  {
    name: 'forwardRetire',
    route: 'retire',
    call: () => forwardRetire(RETIRE),
    outcomes: ['retired', 'already_done', 'default_branch'],
  },
] as const;

describe('forwardPullRequestState sends exactly the named fields', () => {
  it('POSTs to the route with the service token and the six fields', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ref: 'feature-x', outcome: 'recorded' }));
    await forwardPullRequestState(OPEN);
    const { url, init, body } = sent(fetchMock);
    expect(url).toBe('https://ai.example.test/v1/code-graph/pull-request-state');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer svc-token');
    expect(body).toEqual(OPEN);
  });

  it('a merged report also carries mergedAt', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ outcome: 'recorded' }));
    const merged = { ...OPEN, state: 'merged' as const, mergedAt: '2026-11-22T11:00:00Z' };
    await forwardPullRequestState(merged);
    expect(sent(fetchMock).body).toEqual(merged);
  });

  it('a report that is not merged never sends mergedAt, even when the input has one', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ outcome: 'recorded' }));
    await forwardPullRequestState({ ...OPEN, state: 'closed', mergedAt: '2026-11-22T11:00:00Z' });
    expect(sent(fetchMock).body).toEqual({ ...OPEN, state: 'closed' });
  });

  it('extra properties on the input object travel nowhere', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ outcome: 'recorded' }));
    const smuggled = { ...OPEN, coreWorkspaceId: 'ws_1', installationId: '99', token: 'x' };
    await forwardPullRequestState(smuggled);
    expect(sent(fetchMock).body).toEqual(OPEN);
  });
});

describe('forwardRetire sends exactly the named fields', () => {
  it('POSTs { coreOrganizationId, repoRef, ref } with the service token', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ref: 'feature-x', outcome: 'retired' }));
    await forwardRetire({ ...RETIRE, pullRequestNumber: 3, state: 'open' } as typeof RETIRE);
    const { url, init, body } = sent(fetchMock);
    expect(url).toBe('https://ai.example.test/v1/code-graph/retire');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer svc-token');
    expect(body).toEqual(RETIRE);
  });
});

describe.each(calls)('$name answers', ({ route, call, outcomes }) => {
  it.each(outcomes)('a 200 %s as settled', async (outcome) => {
    stubFetch(() => jsonResponse({ ref: 'feature-x', outcome }));
    await expect(call()).resolves.toEqual({ kind: 'settled', outcome });
  });

  it.each([[{ outcome: 'retired_maybe' }], [{}], [null], [{ outcome: 7 }]])(
    'a 200 with an unknown or missing outcome (%j) as unavailable, naming the field',
    async (body) => {
      stubFetch(() => jsonResponse(body));
      await expect(call()).rejects.toThrow(
        new MotirAiUnavailableError(
          `motir-ai returned a malformed 'outcome' from POST /v1/code-graph/${route}`,
        ),
      );
    },
  );

  it('a 200 whose body is not JSON as unavailable', async () => {
    stubFetch(() => new Response('<html>', { status: 200 }));
    await expect(call()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('a fetch that rejects as unavailable', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(call()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('the 30 s deadline as unavailable', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    const pending = call().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(MOTIR_AI_REQUEST_TIMEOUT_MS);
    const error = await pending;
    expect(error).toBeInstanceOf(MotirAiUnavailableError);
    expect((error as Error).message).toContain(`${String(MOTIR_AI_REQUEST_TIMEOUT_MS)}ms`);
  });

  it.each([
    ['internal_error', 500],
    ['ai_job_failed', 502],
    ['codegraph_unavailable', 503],
    ['rate_limited', 429],
  ])('a %s (%i) as unavailable', async (code, status) => {
    stubFetch(() => problem(code, status));
    await expect(call()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('a 502 with no problem body as unavailable', async () => {
    stubFetch(() => new Response('Bad Gateway', { status: 502 }));
    await expect(call()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('a 401 as unauthorized: our own service token is wrong', async () => {
    stubFetch(() => problem('service_unauthorized', 401));
    await expect(call()).rejects.toBeInstanceOf(MotirAiUnauthorizedError);
  });

  it.each([
    ['validation_error', 400],
    ['permission_denied', 403],
    ['not_found', 404],
    ['conflict', 409],
    ['gone', 410],
  ])('a %s (%i) as refused, with its status and code', async (code, status) => {
    stubFetch(() => problem(code, status));
    await expect(call()).resolves.toEqual({ kind: 'refused', status, code });
  });

  it('a 4xx with no problem body as refused, under the fallback code', async () => {
    stubFetch(() => new Response('nope', { status: 404, statusText: 'Not Found' }));
    await expect(call()).resolves.toEqual({ kind: 'refused', status: 404, code: 'internal_error' });
  });

  it('an unset MOTIR_AI_SERVICE_TOKEN as a config error, before anything is sent', async () => {
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', '');
    const fetchMock = stubFetch(() => jsonResponse({ outcome: outcomes[0] }));
    await expect(call()).rejects.toBeInstanceOf(MotirAiConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
