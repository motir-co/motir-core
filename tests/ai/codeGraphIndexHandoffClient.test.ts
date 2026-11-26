import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MotirAiBadRequestError, MotirAiUnavailableError } from '@/lib/ai/errors';
import { handOffCodeGraphIndex, readCodeGraphIndexStatus } from '@/lib/ai/motirAiClient';

// The INDEX HANDOFF and STATUS clients (MOTIR-11883 · story MOTIR-11022), against
// motir-ai's two routes (`docs/contract.md` in motir-ai). The source URL is a bearer
// secret: every refusal arm below also checks no error repeats it.

const SECRET = 'https://codeload.example.test/archive.tar.gz?token=bearer-secret-123';
const COMMIT = 'a'.repeat(40);

const COMMON = {
  coreOrganizationId: 'org_1',
  coreWorkspaceId: 'ws_1',
  coreProjectId: 'pj_1',
  repoRef: 'moooon/motir-core',
  commitSha: COMMIT,
  ref: 'main',
  sourceUrl: SECRET,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const sentBody = (fetchMock: ReturnType<typeof stubFetch>) =>
  JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

beforeEach(() => {
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('handOffCodeGraphIndex', () => {
  it.each(['first_index', 'refresh'] as const)(
    'POSTs a %s with the service token and answers the job id',
    async (kind) => {
      const fetchMock = stubFetch(() => jsonResponse({ jobId: 'job_1' }, 202));

      await expect(handOffCodeGraphIndex({ ...COMMON, kind })).resolves.toEqual({
        outcome: 'accepted',
        jobId: 'job_1',
      });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://ai.example.test/v1/code-graph/index-handoff');
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer svc-token');
      expect(sentBody(fetchMock)).toEqual({ ...COMMON, kind });
    },
  );

  it('a push also carries the previous head and the changed paths', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ jobId: 'job_2' }, 202));
    const previousCommitSha = 'b'.repeat(40);

    await handOffCodeGraphIndex({
      ...COMMON,
      kind: 'push',
      previousCommitSha,
      changedPaths: ['src/a.ts', 'src/b.ts'],
    });
    expect(sentBody(fetchMock)).toEqual({
      ...COMMON,
      kind: 'push',
      previousCommitSha,
      changedPaths: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('a first index or refresh never sends the push-only fields', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ jobId: 'job_3' }, 202));
    await handOffCodeGraphIndex({ ...COMMON, kind: 'refresh' });
    expect(sentBody(fetchMock)).not.toHaveProperty('previousCommitSha');
    expect(sentBody(fetchMock)).not.toHaveProperty('changedPaths');
  });

  it('a default-branch handoff leaves isDefaultBranch out of the body (MOTIR-12257)', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ jobId: 'job_4' }, 202));
    await handOffCodeGraphIndex({ ...COMMON, kind: 'refresh' });
    expect(sentBody(fetchMock)).not.toHaveProperty('isDefaultBranch');
  });

  it.each([false, true])('an explicit isDefaultBranch %s is sent as given', async (value) => {
    const fetchMock = stubFetch(() => jsonResponse({ jobId: 'job_5' }, 202));
    const previousCommitSha = 'b'.repeat(40);
    await handOffCodeGraphIndex({
      ...COMMON,
      ref: 'feature-x',
      kind: 'push',
      previousCommitSha,
      changedPaths: ['src/a.ts'],
      isDefaultBranch: value,
    });
    expect(sentBody(fetchMock)).toEqual({
      ...COMMON,
      ref: 'feature-x',
      kind: 'push',
      previousCommitSha,
      changedPaths: ['src/a.ts'],
      isDefaultBranch: value,
    });
  });

  it('429 rate_limited is the registration retry, not an error', async () => {
    stubFetch(() =>
      jsonResponse({ code: 'rate_limited', status: 429, title: 'retry shortly' }, 429),
    );
    await expect(handOffCodeGraphIndex({ ...COMMON, kind: 'first_index' })).resolves.toEqual({
      outcome: 'registration_in_progress',
    });
  });

  it('a 400 is the typed bad-request error and does not repeat the source URL', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'validation_failed',
          status: 400,
          title: 'invalid',
          detail: 'sourceUrl must be an https URL',
        },
        400,
      ),
    );
    const error = (await handOffCodeGraphIndex({ ...COMMON, kind: 'first_index' }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(error).toBeInstanceOf(MotirAiBadRequestError);
    expect(`${error.message} ${String(error.stack)}`).not.toContain('bearer-secret-123');
  });

  it('a 5xx refusal is the typed unavailable error and does not repeat the source URL', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'ai_job_failed',
          status: 502,
          title: 'refused',
          detail: 'code-graph service refused the index call',
        },
        502,
      ),
    );
    const error = (await handOffCodeGraphIndex({ ...COMMON, kind: 'first_index' }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(error).toBeInstanceOf(MotirAiUnavailableError);
    expect(`${error.message} ${String(error.stack)}`).not.toContain('bearer-secret-123');
  });

  it.each([[null], [{}], [{ jobId: '' }], [{ jobId: 7 }]])(
    'a 2xx with no job id (%j) is unavailable',
    async (body) => {
      stubFetch(() => jsonResponse(body, 202));
      await expect(handOffCodeGraphIndex({ ...COMMON, kind: 'first_index' })).rejects.toThrow(
        new MotirAiUnavailableError(
          'motir-ai returned no job id from POST /v1/code-graph/index-handoff',
        ),
      );
    },
  );
});

const PUBLISHED = {
  state: 'indexed',
  indexedCommit: { commit: COMMIT, publishedAt: '2026-11-22T10:00:00.000Z' },
  inProgressJob: {
    jobId: 'job_9',
    kind: 'push',
    commit: null,
    ref: null,
    state: 'queued',
    enqueuedAt: '2026-11-22T10:01:00.000Z',
    startedAt: null,
  },
  lastFailure: {
    reason: 'repository_too_large',
    commit: null,
    kind: 'first_index',
    message: 'too large',
    failedAt: '2026-11-22T09:00:00.000Z',
  },
};

describe('readCodeGraphIndexStatus', () => {
  it('GETs by organisation and repository and answers the four fields', async () => {
    const fetchMock = stubFetch(() => jsonResponse(PUBLISHED));

    await expect(
      readCodeGraphIndexStatus({ coreOrganizationId: 'org 1', repoRef: 'moooon/motir-core' }),
    ).resolves.toEqual(PUBLISHED);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://ai.example.test/v1/code-graph/index-status',
    );
    expect(parsed.searchParams.get('coreOrganizationId')).toBe('org 1');
    expect(parsed.searchParams.get('repoRef')).toBe('moooon/motir-core');
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer svc-token');
  });

  it('a never-indexed repository answers its nulls', async () => {
    const empty = {
      state: 'not_indexed',
      indexedCommit: null,
      inProgressJob: null,
      lastFailure: null,
    };
    stubFetch(() => jsonResponse(empty));
    await expect(
      readCodeGraphIndexStatus({ coreOrganizationId: 'org_1', repoRef: 'a/b' }),
    ).resolves.toEqual(empty);
  });

  it('absent object fields read as null, and only the named members are kept', async () => {
    stubFetch(() =>
      jsonResponse({
        state: 'indexed',
        indexedCommit: { ...PUBLISHED.indexedCommit, extra: 'dropped' },
      }),
    );
    await expect(
      readCodeGraphIndexStatus({ coreOrganizationId: 'org_1', repoRef: 'a/b' }),
    ).resolves.toEqual({
      state: 'indexed',
      indexedCommit: PUBLISHED.indexedCommit,
      inProgressJob: null,
      lastFailure: null,
    });
  });

  it.each([
    ['body', null],
    ['body', []],
    ['state', { ...PUBLISHED, state: 3 }],
    ['indexedCommit', { ...PUBLISHED, indexedCommit: 'abc' }],
    ['indexedCommit', { ...PUBLISHED, indexedCommit: [] }],
    ['indexedCommit.commit', { ...PUBLISHED, indexedCommit: { publishedAt: 'x' } }],
    [
      'inProgressJob.startedAt',
      { ...PUBLISHED, inProgressJob: { ...PUBLISHED.inProgressJob, startedAt: 1 } },
    ],
    [
      'lastFailure.message',
      { ...PUBLISHED, lastFailure: { ...PUBLISHED.lastFailure, message: null } },
    ],
  ])('a malformed %s is unavailable, naming the field', async (field, body) => {
    stubFetch(() => jsonResponse(body));
    await expect(
      readCodeGraphIndexStatus({ coreOrganizationId: 'org_1', repoRef: 'a/b' }),
    ).rejects.toThrow(
      new MotirAiUnavailableError(
        `motir-ai returned a malformed '${field}' from GET /v1/code-graph/index-status`,
      ),
    );
  });

  it('a refusal is the typed error', async () => {
    stubFetch(() =>
      jsonResponse(
        { code: 'validation_failed', status: 400, title: 'bad', detail: 'repoRef' },
        400,
      ),
    );
    await expect(
      readCodeGraphIndexStatus({ coreOrganizationId: 'org_1', repoRef: 'nope' }),
    ).rejects.toBeInstanceOf(MotirAiBadRequestError);
  });
});
