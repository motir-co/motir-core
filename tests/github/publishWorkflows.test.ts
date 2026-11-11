import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishWorkflowsClient, PublishWorkflowError } from '@/lib/github/publishWorkflows';

// THE PUBLISH-WORKFLOW CLIENT of the Fleet status page (MOTIR-10886): the one
// write (start a workflow) and the reads that follow its run and fill the gap
// lines. GitHub is faked at `fetch`, routed by path, so every request's method,
// path, headers and body are pinned, and every arm of every answer.

const REPO = { owner: 'motir-co', name: 'motir-core' };
const API = 'https://api.github.com/repos/motir-co/motir-core';

type Answer = { status: number; body?: unknown; raw?: string };
let routes: Array<[RegExp, Answer | ((url: string, init: RequestInit) => Answer)]>;
const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
  for (const [pattern, answer] of routes) {
    if (pattern.test(url)) {
      const a = typeof answer === 'function' ? answer(url, init) : answer;
      const text = a.raw ?? (a.body === undefined ? '' : JSON.stringify(a.body));
      return new Response(a.status === 204 ? null : text, { status: a.status });
    }
  }
  throw new Error(`unrouted ${url}`);
});

const run = (over: Record<string, unknown> = {}) => ({
  id: 77,
  run_number: 12,
  html_url: 'https://github.com/motir-co/motir-core/actions/runs/77',
  status: 'in_progress',
  conclusion: null,
  created_at: '2026-11-10T10:00:00Z',
  updated_at: '2026-11-10T10:01:00Z',
  ...over,
});

beforeEach(() => {
  routes = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the transport', () => {
  it('sends the GitHub headers, the bearer token when there is one, and a timeout signal', async () => {
    routes.push([/\/actions\/runs\/77$/, { status: 200, body: run() }]);
    await publishWorkflowsClient.run(REPO, 77, 'tok');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${API}/actions/runs/77`);
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok');
    expect(headers['x-github-api-version']).toBe('2022-11-28');
    expect(headers['content-type']).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);

    await publishWorkflowsClient.run(REPO, 77, null);
    expect((fetchMock.mock.calls[1]![1].headers as Record<string, string>)['authorization']).toBe(
      undefined,
    );
  });

  it('a refusal carries the status and GitHub’s message, cut to 300 characters', async () => {
    routes.push([/runs\/1$/, { status: 403, body: { message: 'x'.repeat(400) } }]);
    const err = await publishWorkflowsClient.run(REPO, 1, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishWorkflowError);
    expect((err as PublishWorkflowError).status).toBe(403);
    expect((err as PublishWorkflowError).detail).toHaveLength(300);
    expect((err as Error).message).toMatch(/^GitHub refused the call \(HTTP 403: x+\)\.$/);
  });

  it('a refusal with no JSON body has an empty detail', async () => {
    routes.push([/runs\/1$/, { status: 502, raw: '<html>' }]);
    const err = (await publishWorkflowsClient
      .run(REPO, 1, null)
      .catch((e: unknown) => e)) as PublishWorkflowError;
    expect(err.detail).toBe('');
    expect(err.message).toBe('GitHub refused the call (HTTP 502).');
  });

  it('a transport failure is a status-null error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const err = (await publishWorkflowsClient
      .run(REPO, 1, null)
      .catch((e: unknown) => e)) as PublishWorkflowError;
    expect(err.status).toBeNull();
    expect(err.message).toBe('GitHub could not be reached (ECONNRESET).');
    fetchMock.mockRejectedValueOnce('odd');
    const odd = (await publishWorkflowsClient
      .run(REPO, 1, null)
      .catch((e: unknown) => e)) as PublishWorkflowError;
    expect(odd.detail).toBe('unknown');
  });
});

describe('the run id segment', () => {
  it.each([0, -1, 1.5, 1e21, Number.NaN])(
    'a run id GitHub could not have issued (%s) makes no request',
    async (runId) => {
      await expect(publishWorkflowsClient.run(REPO, runId, null)).rejects.toMatchObject({
        status: null,
        detail: 'the run id is not one GitHub could have issued',
      });
      await expect(publishWorkflowsClient.failureDetail(REPO, runId, null)).rejects.toMatchObject({
        status: null,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('dispatch', () => {
  it('posts ref, inputs and return_run_details, then reads the run it names', async () => {
    routes.push([
      /\/dispatches$/,
      { status: 200, body: { workflow_run_id: 77, html_url: 'https://x/77' } },
    ]);
    routes.push([/\/actions\/runs\/77$/, { status: 200, body: run() }]);
    const started = await publishWorkflowsClient.dispatch(
      REPO,
      'hosted-agent-image.yml',
      'main',
      { digest: 'sha256:aa' },
      'tok',
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${API}/actions/workflows/hosted-agent-image.yml/dispatches`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      ref: 'main',
      inputs: { digest: 'sha256:aa' },
      return_run_details: true,
    });
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(started).toMatchObject({ id: 77, runNumber: 12, status: 'in_progress' });
  });

  it('answers a queued run from the dispatch answer when the run read fails', async () => {
    routes.push([/\/dispatches$/, { status: 200, body: { workflow_run_id: 78 } }]);
    routes.push([/\/actions\/runs\/78$/, { status: 404, body: { message: 'Not Found' } }]);
    const started = await publishWorkflowsClient.dispatch(REPO, 'w.yml', 'main', {}, 'tok');
    expect(started).toMatchObject({
      id: 78,
      runNumber: null,
      status: 'queued',
      htmlUrl: 'https://github.com/motir-co/motir-core/actions/runs/78',
    });

    routes = [
      [/\/dispatches$/, { status: 200, body: { workflow_run_id: 79, html_url: 'https://x/79' } }],
      [/\/actions\/runs\/79$/, { status: 200, body: { id: 'not a number' } }],
    ];
    expect((await publishWorkflowsClient.dispatch(REPO, 'w.yml', 'main', {}, 'tok')).htmlUrl).toBe(
      'https://x/79',
    );
  });

  it('the 204 form finds the newest dispatch run created since the call', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T10:00:00Z'), toFake: ['Date', 'setTimeout'] });
    let lists = 0;
    routes.push([/\/dispatches$/, { status: 204 }]);
    routes.push([
      /\/runs\?event=workflow_dispatch&per_page=5$/,
      () => {
        lists += 1;
        return lists === 1
          ? { status: 200, body: { workflow_runs: [run({ created_at: '2026-11-09T00:00:00Z' })] } }
          : { status: 200, body: { workflow_runs: [run({ id: 90 })] } };
      },
    ]);
    const pending = publishWorkflowsClient.dispatch(REPO, 'w.yml', 'main', {}, 'tok');
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).id).toBe(90);
    expect(lists).toBe(2);
  });

  it('the 204 form gives up after five list reads', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T10:00:00Z'), toFake: ['Date', 'setTimeout'] });
    routes.push([/\/dispatches$/, { status: 204 }]);
    routes.push([/\/runs\?event=/, { status: 200, body: { workflow_runs: [] } }]);
    const pending = publishWorkflowsClient
      .dispatch(REPO, 'w.yml', 'main', {}, 'tok')
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const err = (await pending) as PublishWorkflowError;
    expect(err).toBeInstanceOf(PublishWorkflowError);
    expect(err.detail).toBe('the dispatched run did not appear in the run list');
  });

  it('a refused dispatch throws GitHub’s message', async () => {
    routes.push([
      /\/dispatches$/,
      { status: 403, body: { message: 'Resource not accessible by integration' } },
    ]);
    await expect(
      publishWorkflowsClient.dispatch(REPO, 'w.yml', 'main', {}, 'tok'),
    ).rejects.toMatchObject({ status: 403, detail: 'Resource not accessible by integration' });
  });
});

describe('run and activeRuns', () => {
  it('a run with no id or status is refused; missing optional fields read as empty', async () => {
    routes.push([/runs\/5$/, { status: 200, body: [] }]);
    await expect(publishWorkflowsClient.run(REPO, 5, null)).rejects.toMatchObject({
      detail: 'the run carried no id or status',
    });
    routes = [[/runs\/6$/, { status: 200, body: { id: 6, html_url: 'u', status: 'queued' } }]];
    expect(await publishWorkflowsClient.run(REPO, 6, null)).toEqual({
      id: 6,
      runNumber: null,
      htmlUrl: 'u',
      status: 'queued',
      conclusion: null,
      createdAt: '',
      updatedAt: '',
    });
  });

  it('activeRuns keeps the runs GitHub has not completed', async () => {
    routes.push([
      /\/actions\/workflows\/release-sandbox\.yml\/runs\?per_page=20$/,
      {
        status: 200,
        body: {
          workflow_runs: [
            run({ id: 1, status: 'completed' }),
            run({ id: 2, status: 'queued' }),
            { junk: true },
          ],
        },
      },
    ]);
    const active = await publishWorkflowsClient.activeRuns(REPO, 'release-sandbox.yml', null);
    expect(active.map((r) => r.id)).toEqual([2]);
  });

  it('a run list that is not a list is refused', async () => {
    routes.push([/\/runs\?per_page=20$/, { status: 200, body: { workflow_runs: 'no' } }]);
    await expect(publishWorkflowsClient.activeRuns(REPO, 'w.yml', null)).rejects.toMatchObject({
      detail: 'run list was not a list',
    });
  });
});

describe('failureDetail', () => {
  it('answers the failed jobs’ failure annotations, de-duplicated', async () => {
    routes.push([
      /\/actions\/runs\/9\/jobs\?filter=latest&per_page=100$/,
      {
        status: 200,
        body: {
          jobs: [
            { id: 1, name: 'build', conclusion: 'success' },
            { id: 2, name: 'pin', conclusion: 'failure' },
            { id: 3, name: 'deploy', conclusion: 'timed_out' },
          ],
        },
      },
    ]);
    routes.push([
      /\/check-runs\/2\/annotations/,
      {
        status: 200,
        body: [
          { annotation_level: 'warning', message: 'ignored' },
          { annotation_level: 'failure', message: 'pin PR could not be opened' },
        ],
      },
    ]);
    routes.push([
      /\/check-runs\/3\/annotations/,
      {
        status: 200,
        body: [{ annotation_level: 'failure', message: 'pin PR could not be opened' }],
      },
    ]);
    expect(await publishWorkflowsClient.failureDetail(REPO, 9, null)).toBe(
      'pin PR could not be opened',
    );
  });

  it('falls back to the failed step, or the job’s conclusion, when nothing is annotated', async () => {
    routes.push([
      /\/jobs\?/,
      {
        status: 200,
        body: {
          jobs: [
            {
              id: 4,
              name: 'pin',
              conclusion: 'failure',
              steps: [
                { name: 'checkout', conclusion: 'success' },
                { name: 'open the pin PR', conclusion: 'failure' },
              ],
            },
            { name: 'release', conclusion: 'cancelled' },
            'junk',
          ],
        },
      },
    ]);
    routes.push([/\/check-runs\/4\/annotations/, { status: 500 }]);
    expect(await publishWorkflowsClient.failureDetail(REPO, 9, null)).toBe(
      'pin: the step "open the pin PR" ended failure\nrelease: cancelled',
    );
  });

  it('null when no job failed or the job list is not a list', async () => {
    routes.push([/\/jobs\?/, { status: 200, body: { jobs: [{ conclusion: 'success' }] } }]);
    expect(await publishWorkflowsClient.failureDetail(REPO, 9, null)).toBeNull();
    routes = [[/\/jobs\?/, { status: 200, body: {} }]];
    expect(await publishWorkflowsClient.failureDetail(REPO, 9, null)).toBeNull();
  });

  it('a long detail is cut to 2000 characters', async () => {
    routes.push([
      /\/jobs\?/,
      { status: 200, body: { jobs: [{ id: 1, name: 'x', conclusion: 'failure' }] } },
    ]);
    routes.push([
      /annotations/,
      { status: 200, body: [{ annotation_level: 'failure', message: 'e'.repeat(3000) }] },
    ]);
    expect(await publishWorkflowsClient.failureDetail(REPO, 9, null)).toHaveLength(2000);
  });
});

describe('countPathCommits', () => {
  const sha = (n: number) => `c${String(n).padStart(39, '0')}`;
  const compareBody = (
    shas: string[],
    total: number,
    date: string | null = '2026-11-01T00:00:00Z',
  ) => ({
    total_commits: total,
    merge_base_commit: date ? { commit: { committer: { date } } } : {},
    commits: shas.map((s) => ({ sha: s })),
  });

  it('counts the path’s commits that the compare also lists, skipping the base', async () => {
    routes.push([
      /\/compare\/base\.\.\.head\?per_page=100&page=1$/,
      { status: 200, body: compareBody([sha(1), sha(2), sha(3)], 3) },
    ]);
    routes.push([
      /\/commits\?sha=head&path=packages%2Fcli&per_page=100&page=1&since=2026-11-01T00%3A00%3A00Z$/,
      {
        status: 200,
        body: [{ sha: sha(1) }, { sha: sha(3) }, { sha: sha(9) }, { sha: 'base' }, {}],
      },
    ]);
    expect(
      await publishWorkflowsClient.countPathCommits(REPO, 'base', 'head', 'packages/cli', null),
    ).toBe(2);
  });

  it('zero when the compare is empty, without a path read', async () => {
    routes.push([/\/compare\//, { status: 200, body: { commits: [] } }]);
    expect(await publishWorkflowsClient.countPathCommits(REPO, 'a', 'b', 'p', null)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a compare longer than its pages counts every path commit since the merge base', async () => {
    const page = Array.from({ length: 100 }, (_, i) => sha(i));
    routes.push([/\/compare\/.*page=\d$/, { status: 200, body: compareBody(page, 1000, null) }]);
    let pathPage = 0;
    routes.push([
      /\/commits\?sha=b&path=p&per_page=100&page=\d$/,
      () => {
        pathPage += 1;
        return pathPage === 1
          ? { status: 200, body: Array.from({ length: 100 }, (_, i) => ({ sha: `p${i}` })) }
          : { status: 200, body: [{ sha: 'last' }] };
      },
    ]);
    expect(await publishWorkflowsClient.countPathCommits(REPO, 'a', 'b', 'p', null)).toBe(101);
    // three compare pages, two path pages; a merge base with no date adds no bound
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('a compare with no commit list, or a path list that is not a list, is refused', async () => {
    routes.push([/\/compare\//, { status: 200, body: {} }]);
    await expect(
      publishWorkflowsClient.countPathCommits(REPO, 'a', 'b', 'p', null),
    ).rejects.toMatchObject({
      detail: 'compare had no commits',
    });
    routes = [
      [/\/compare\//, { status: 200, body: { commits: [{ sha: 'x' }] } }],
      [/\/commits\?/, { status: 200, body: {} }],
    ];
    await expect(
      publishWorkflowsClient.countPathCommits(REPO, 'a', 'b', 'p', null),
    ).rejects.toMatchObject({
      detail: 'commit list was not a list',
    });
  });
});

describe('tags, peel, commitDate and pathExists', () => {
  it('tagsWithPrefix names each tag, marking an annotated one for peel', async () => {
    routes.push([
      /\/git\/matching-refs\/tags\/cli-v$/,
      {
        status: 200,
        body: [
          { ref: 'refs/tags/cli-v0.17.2', object: { sha: 'aaa', type: 'commit' } },
          { ref: 'refs/tags/cli-v0.18.0', object: { sha: 'bbb', type: 'tag' } },
          { ref: 'refs/tags/broken' },
        ],
      },
    ]);
    expect(await publishWorkflowsClient.tagsWithPrefix(REPO, 'cli-v', null)).toEqual([
      { name: 'cli-v0.17.2', commit: 'aaa' },
      { name: 'cli-v0.18.0', commit: 'tag:bbb' },
    ]);
    routes = [[/matching-refs/, { status: 200, body: {} }]];
    await expect(publishWorkflowsClient.tagsWithPrefix(REPO, 'cli-v', null)).rejects.toMatchObject({
      detail: 'ref list was not a list',
    });
  });

  it('peel resolves a tag object and passes a commit through', async () => {
    expect(await publishWorkflowsClient.peel(REPO, 'abc', null)).toBe('abc');
    expect(fetchMock).not.toHaveBeenCalled();
    routes.push([/\/git\/tags\/bbb$/, { status: 200, body: { object: { sha: 'ccc' } } }]);
    expect(await publishWorkflowsClient.peel(REPO, 'tag:bbb', null)).toBe('ccc');
    routes = [[/\/git\/tags\//, { status: 200, body: {} }]];
    await expect(publishWorkflowsClient.peel(REPO, 'tag:bbb', null)).rejects.toMatchObject({
      detail: 'the tag named no object',
    });
  });

  it('commitDate reads the committer date', async () => {
    routes.push([
      /\/commits\/abc$/,
      { status: 200, body: { commit: { committer: { date: '2026-11-01T00:00:00Z' } } } },
    ]);
    expect(await publishWorkflowsClient.commitDate(REPO, 'abc', null)).toBe('2026-11-01T00:00:00Z');
    routes = [[/\/commits\/abc$/, { status: 200, body: {} }]];
    await expect(publishWorkflowsClient.commitDate(REPO, 'abc', null)).rejects.toMatchObject({
      detail: 'the commit had no date',
    });
  });

  it('pathExists: 200 true, 404 false, anything else throws', async () => {
    routes.push([
      /\/contents\/packages\/cli\/sandbox\/smoke\/release-set\.mjs\?ref=cli-v0\.18\.0$/,
      { status: 200, body: {} },
    ]);
    routes.push([/ref=cli-v0\.17\.2$/, { status: 404, body: { message: 'Not Found' } }]);
    routes.push([/ref=boom$/, { status: 500 }]);
    const path = 'packages/cli/sandbox/smoke/release-set.mjs';
    expect(await publishWorkflowsClient.pathExists(REPO, path, 'cli-v0.18.0', null)).toBe(true);
    expect(await publishWorkflowsClient.pathExists(REPO, path, 'cli-v0.17.2', null)).toBe(false);
    await expect(publishWorkflowsClient.pathExists(REPO, path, 'boom', null)).rejects.toMatchObject(
      {
        status: 500,
      },
    );
  });
});
