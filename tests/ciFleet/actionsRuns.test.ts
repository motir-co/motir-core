import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsRunsError, actionsRunsClient } from '@/lib/github/actionsRuns';
import { mintInstallationToken } from '@/lib/github/appAuth';

// The Actions-RUNS host boundary (Story MOTIR-6906 · MOTIR-6908) — the module
// `fleetStopService` drives, covered on the wire: the endpoint, the verb, and what
// each status means. `fetch` is stubbed and `mintInstallationToken` mocked, the
// convention `actionsPermissions.test.ts` established (a real mint needs a
// private key the test env has no business carrying).

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({ token: 'ghs_test', expiresAt: new Date() })),
}));

vi.mock('@/lib/github/repoProvisioning', () => ({
  provisioningAuth: vi.fn(async () => ({
    org: 'motir-projects',
    installationId: '42',
    token: 'ghs_provisioning',
  })),
}));

const REPO = { installationId: '42', owner: 'motir-projects', repo: 'acme-web' };

let fetchMock: ReturnType<typeof vi.fn>;

function runs(...ids: number[]): Response {
  return new Response(
    JSON.stringify({ workflow_runs: ids.map((id) => ({ id, status: 'queued' })) }),
    { status: 200 },
  );
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('actionsRunsClient.listActiveRuns', () => {
  it('asks for in_progress AND queued runs, and returns both', async () => {
    fetchMock.mockResolvedValueOnce(runs(1, 2)).mockResolvedValueOnce(runs(3));

    const active = await actionsRunsClient.listActiveRuns(REPO);

    expect(active.map((r) => r.id)).toEqual([1, 2, 3]);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      'https://api.github.com/repos/motir-projects/acme-web/actions/runs?status=in_progress&per_page=100',
      'https://api.github.com/repos/motir-projects/acme-web/actions/runs?status=queued&per_page=100',
    ]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer ghs_test');
  });

  it('answers an empty list for a repository that is gone (404)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await actionsRunsClient.listActiveRuns(REPO)).toEqual([]);
  });

  it('tolerates a body with no workflow_runs', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    expect(await actionsRunsClient.listActiveRuns(REPO)).toEqual([]);
  });

  it('raises the typed error on a refusal, with GitHub’s message and nothing else', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
        status: 403,
      }),
    );
    const err = await actionsRunsClient.listActiveRuns(REPO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionsRunsError);
    expect((err as ActionsRunsError).status).toBe(403);
    expect((err as ActionsRunsError).message).toContain('Resource not accessible by integration');
  });

  it('raises the typed error, with no status, when GitHub cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const err = await actionsRunsClient.listActiveRuns(REPO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionsRunsError);
    expect((err as ActionsRunsError).status).toBeNull();
    expect((err as ActionsRunsError).message).toContain('ECONNRESET');
  });
});

describe('actionsRunsClient.cancelRun', () => {
  it('POSTs to the run’s cancel endpoint and answers true on 202', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));

    expect(await actionsRunsClient.cancelRun(REPO, 77)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/motir-projects/acme-web/actions/runs/77/cancel');
    expect(init.method).toBe('POST');
  });

  it('answers false when there is nothing left to cancel (409 finished, 404 gone)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 409 }));
    expect(await actionsRunsClient.cancelRun(REPO, 1)).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await actionsRunsClient.cancelRun(REPO, 2)).toBe(false);
  });

  it('raises the typed error on any other status, even with an unreadable body', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 500 }));
    const err = await actionsRunsClient.cancelRun(REPO, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionsRunsError);
    expect((err as ActionsRunsError).status).toBe(500);
  });
});

describe('the provisioning token', () => {
  it('is minted as the PROVISIONING app, and a failed mint is the typed error', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await actionsRunsClient.cancelRun(REPO, 1);
    expect(mintInstallationToken).toHaveBeenCalledWith('42', 'provisioning');

    vi.mocked(mintInstallationToken).mockRejectedValueOnce(new Error('app not configured'));
    const err = await actionsRunsClient.cancelRun(REPO, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionsRunsError);
    expect((err as ActionsRunsError).message).toContain('app not configured');
  });
});

describe('what escapes when GitHub misbehaves', () => {
  it('a non-Error rejection reads as `unknown`, from the fetch and from the mint', async () => {
    fetchMock.mockRejectedValue('socket hang up');
    const fromFetch = await actionsRunsClient.cancelRun(REPO, 1).catch((e: unknown) => e);
    expect((fromFetch as ActionsRunsError).message).toContain('unknown');

    vi.mocked(mintInstallationToken).mockRejectedValueOnce('no key');
    const fromMint = await actionsRunsClient.cancelRun(REPO, 1).catch((e: unknown) => e);
    expect((fromMint as ActionsRunsError).message).toContain('unknown');
  });

  it('a body that is not an object, or a message that is not a string, carries no detail', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('5', { status: 500 }));
    const scalar = await actionsRunsClient.cancelRun(REPO, 1).catch((e: unknown) => e);
    expect((scalar as ActionsRunsError).detail).toBe('');

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ message: 5 }), { status: 500 }),
    );
    const numeric = await actionsRunsClient.cancelRun(REPO, 1).catch((e: unknown) => e);
    expect((numeric as ActionsRunsError).detail).toBe('');
  });
});

// A job RE-RUN (MOTIR-11728): the job a Spot-reclaimed runner was working, asked
// through the installation its runner was registered through.
describe('actionsRunsClient.rerunJob', () => {
  const TARGET = { org: 'acme', installationId: '777', role: 'provisioning' as const };
  const RERUN = { owner: 'acme', repo: 'web', target: TARGET };
  const BODY_MARKER = 'BODY-MARKER-never-surfaces';

  function answer(status: number): Response {
    return new Response(JSON.stringify({ message: BODY_MARKER }), { status });
  }

  it('POSTs the job’s rerun endpoint with the target installation’s token, and answers true on 201', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));

    expect(await actionsRunsClient.rerunJob(RERUN, '9901', '7001')).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/web/actions/jobs/9901/rerun');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer ghs_test');
    expect(vi.mocked(mintInstallationToken)).toHaveBeenCalledWith('777', 'provisioning');
  });

  it('authenticates through the provisioning installation when there is no target', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));

    await actionsRunsClient.rerunJob({ ...RERUN, target: undefined }, '9901', '7001');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer ghs_provisioning',
    );
  });

  it('answers 409 as a refusal that may clear', async () => {
    fetchMock.mockResolvedValueOnce(answer(409));
    expect(await actionsRunsClient.rerunJob(RERUN, '1', '7001')).toEqual({
      refused: true,
      status: 409,
      mayClear: true,
    });
  });

  it('answers 404 and 422 as refusals for good', async () => {
    fetchMock.mockResolvedValueOnce(answer(404)).mockResolvedValueOnce(answer(422));
    expect(await actionsRunsClient.rerunJob(RERUN, '1', '7001')).toEqual({
      refused: true,
      status: 404,
      mayClear: false,
    });
    expect(await actionsRunsClient.rerunJob(RERUN, '1', '7001')).toEqual({
      refused: true,
      status: 422,
      mayClear: false,
    });
  });

  it('answers 403 on a run still in progress as a refusal that may clear', async () => {
    fetchMock
      .mockResolvedValueOnce(answer(403))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'in_progress' }), { status: 200 }),
      );

    expect(await actionsRunsClient.rerunJob(RERUN, '1', '7001')).toEqual({
      refused: true,
      status: 403,
      mayClear: true,
    });
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      'https://api.github.com/repos/acme/web/actions/runs/7001',
    );
  });

  it('answers 403 on a finished run — or one it cannot read — as a refusal for good', async () => {
    fetchMock
      .mockResolvedValueOnce(answer(403))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' }), { status: 200 }))
      .mockResolvedValueOnce(answer(403))
      .mockResolvedValueOnce(answer(404))
      .mockResolvedValueOnce(answer(403))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(answer(403))
      .mockResolvedValueOnce(new Response('not json', { status: 200 }));

    for (let i = 0; i < 4; i += 1) {
      expect(await actionsRunsClient.rerunJob(RERUN, '1', '7001')).toEqual({
        refused: true,
        status: 403,
        mayClear: false,
      });
    }
  });

  it('throws the typed error on any other status, carrying no raw body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>' + BODY_MARKER, { status: 500 }));

    const err = await actionsRunsClient.rerunJob(RERUN, '1', '7001').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ActionsRunsError);
    expect((err as ActionsRunsError).status).toBe(500);
    expect((err as ActionsRunsError).message).not.toContain(BODY_MARKER);
  });

  it('throws the typed error, with no status, when the token cannot be minted', async () => {
    vi.mocked(mintInstallationToken).mockRejectedValueOnce(new Error('mint failed'));

    const err = await actionsRunsClient.rerunJob(RERUN, '1', '7001').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ActionsRunsError);
    expect((err as ActionsRunsError).status).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
