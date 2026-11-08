import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE RUNNER-VERSION SUPPORT PROBE (MOTIR-10706): the daily health check fails
// before GitHub stops serving the Actions runner the CI fleet is built with.
// On 2026-11-08 every AWS fleet runner was v2.336.0, GitHub answered "Runner
// version v2.336.0 is deprecated and cannot receive messages", and each VM
// powered off with its job still queued. This file pins the rule (the clock
// starts at the OLDEST release newer than the pin, 30 days, failing 14 before),
// the parse of the Dockerfile and of GitHub's release list, the probe's reads
// and every arm, and the two GitHub requests. GitHub is faked at its seams: the
// client object for the service, `fetch` for the client.

const app = vi.hoisted(() => ({ sourceRepoToken: vi.fn() }));
vi.mock('@/lib/services/runnerImageFreshnessProbeService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/runnerImageFreshnessProbeService')>()),
  sourceRepoToken: app.sourceRepoToken,
}));

const {
  compareRunnerVersions,
  judgeRunnerVersion,
  parseRunnerReleases,
  runnerVersionFromDockerfile,
  runnerVersionSentence,
  RUNNER_SUPPORT_WINDOW_DAYS,
  RUNNER_VERSION_WARN_DAYS,
} = await import('@/lib/ciFleet/runnerVersionSupport');
const { runnerVersionSupportProbeService } =
  await import('@/lib/services/runnerVersionSupportProbeService');
const { runnerVersionSourcesClient, RunnerVersionSourceError } =
  await import('@/lib/github/runnerVersionSources');
const { RunnerVersionUnsupportedError } = await import('@/lib/jobs/definitions/dailyHealthCheck');

/** Releases around the incident. v2.336.0's and v2.338.2's dates are the real
 *  ones the card cites; v2.337.0's is a fixture date between them. */
const R2336 = { version: '2.336.0', publishedAt: '2026-07-20T12:00:00Z' };
const R2337 = { version: '2.337.0', publishedAt: '2026-08-25T12:00:00Z' };
const R2338 = { version: '2.338.2', publishedAt: '2026-10-26T12:00:00Z' };
const RELEASES = [R2338, R2336, R2337];

const at = (iso: string) => new Date(iso);

/** A GitHub release row as `GET /repos/actions/runner/releases` returns it. */
function row(tag: string, published: string, extra: Record<string, unknown> = {}) {
  return { tag_name: tag, published_at: published, draft: false, prerelease: false, ...extra };
}

describe('the pin, read from the Dockerfile', () => {
  it('reads the committed pin — which is v2.338.2, the release GitHub serves (criterion 1)', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'infra/ci-runner/Dockerfile'), 'utf8');
    expect(runnerVersionFromDockerfile(dockerfile)).toBe('2.338.2');
    // The checksum the release body publishes for linux-x64, also verified by
    // downloading the tarball when the pin moved.
    expect(dockerfile).toContain(
      'ARG RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40',
    );
  });

  it('refuses a missing line or anything but an exact x.y.z', () => {
    expect(runnerVersionFromDockerfile('FROM ubuntu\n')).toBeNull();
    expect(runnerVersionFromDockerfile('ARG RUNNER_VERSION=latest\n')).toBeNull();
    expect(runnerVersionFromDockerfile('ARG RUNNER_VERSION=2.338\n')).toBeNull();
    expect(runnerVersionFromDockerfile('# ARG RUNNER_VERSION=2.338.2\n')).toBeNull();
    expect(runnerVersionFromDockerfile('ARG RUNNER_VERSION=2.338.2   \n')).toBe('2.338.2');
  });

  it('compares versions numerically, not as strings', () => {
    expect(compareRunnerVersions('2.338.2', '2.36.0')).toBeGreaterThan(0);
    expect(compareRunnerVersions('2.338.2', '2.338.10')).toBeLessThan(0);
    expect(compareRunnerVersions('2.338.2', '2.338.2')).toBe(0);
    expect(compareRunnerVersions('3.0.0', '2.999.999')).toBeGreaterThan(0);
  });
});

describe('the release list', () => {
  it('keeps published v<x.y.z> releases, oldest version first', () => {
    expect(
      parseRunnerReleases([
        row('v2.338.2', R2338.publishedAt),
        row('v2.336.0', R2336.publishedAt),
        row('v2.337.0', R2337.publishedAt),
      ]),
    ).toEqual([R2336, R2337, R2338]);
  });

  it('drops drafts, pre-releases, odd tags and rows missing a field', () => {
    expect(
      parseRunnerReleases([
        row('v2.339.0', '2026-11-01T00:00:00Z', { draft: true }),
        row('v2.339.0-rc1', '2026-11-01T00:00:00Z'),
        row('v2.340.0', '2026-11-02T00:00:00Z', { prerelease: true }),
        row('v2.341.0', 'not a date'),
        { tag_name: 'v2.342.0' },
        'nonsense',
        null,
        row('v2.338.2', R2338.publishedAt),
      ]),
    ).toEqual([R2338]);
  });

  it('is null when the body is not a list', () => {
    expect(parseRunnerReleases({ message: 'Not Found' })).toBeNull();
    expect(parseRunnerReleases(null)).toBeNull();
  });
});

describe('judgeRunnerVersion — the clock starts at the oldest newer release', () => {
  it('reproduces the incident: v2.336.0 on 2026-11-08 is UNSUPPORTED, since 30 days after v2.337.0', () => {
    const verdict = judgeRunnerVersion({
      pinned: '2.336.0',
      releases: RELEASES,
      now: at('2026-11-08T15:40:00Z'),
    });
    expect(verdict).toEqual({
      verdict: 'unsupported',
      checkedAt: '2026-11-08T15:40:00.000Z',
      pinned: '2.336.0',
      latest: R2338,
      // Not v2.338.2: the 30 days began when the FIRST newer release came out.
      supersededBy: R2337,
      deadline: '2026-09-24T12:00:00.000Z',
      daysLeft: -46,
    });
  });

  it('is SUPPORTED with no deadline when the pin is the newest release', () => {
    expect(
      judgeRunnerVersion({
        pinned: '2.338.2',
        releases: RELEASES,
        now: at('2026-11-08T09:00:00Z'),
      }),
    ).toEqual({
      verdict: 'supported',
      checkedAt: '2026-11-08T09:00:00.000Z',
      pinned: '2.338.2',
      latest: R2338,
      supersededBy: null,
      deadline: null,
      daysLeft: null,
    });
  });

  it('is SUPPORTED, with the deadline, while the cut-off is more than the margin away', () => {
    // v2.337.0 is superseded on 2026-10-26, so the cut-off is 2026-11-25.
    const verdict = judgeRunnerVersion({
      pinned: '2.337.0',
      releases: RELEASES,
      now: at('2026-10-27T12:00:00Z'),
    });
    expect(verdict).toMatchObject({
      verdict: 'supported',
      supersededBy: R2338,
      deadline: '2026-11-25T12:00:00.000Z',
      daysLeft: 29,
    });
  });

  it('turns EXPIRING exactly when fewer than the margin days are left (criterion 3)', () => {
    const deadline = Date.parse(R2338.publishedAt) + RUNNER_SUPPORT_WINDOW_DAYS * 86_400_000;
    const atDaysLeft = (days: number) => new Date(deadline - days * 86_400_000);
    expect(
      judgeRunnerVersion({
        pinned: '2.337.0',
        releases: RELEASES,
        now: atDaysLeft(RUNNER_VERSION_WARN_DAYS),
      }).verdict,
    ).toBe('supported');
    const expiring = judgeRunnerVersion({
      pinned: '2.337.0',
      releases: RELEASES,
      now: new Date(atDaysLeft(RUNNER_VERSION_WARN_DAYS).getTime() + 1),
    });
    expect(expiring).toMatchObject({ verdict: 'expiring', daysLeft: RUNNER_VERSION_WARN_DAYS - 1 });
    // The last instant before the cut-off is still expiring; the cut-off itself is not.
    expect(
      judgeRunnerVersion({ pinned: '2.337.0', releases: RELEASES, now: new Date(deadline - 1) })
        .verdict,
    ).toBe('expiring');
    expect(
      judgeRunnerVersion({ pinned: '2.337.0', releases: RELEASES, now: new Date(deadline) })
        .verdict,
    ).toBe('unsupported');
  });

  it('treats a pin newer than every release (a hand-built runner) as supported', () => {
    expect(
      judgeRunnerVersion({
        pinned: '2.400.0',
        releases: RELEASES,
        now: at('2026-11-08T09:00:00Z'),
      }),
    ).toMatchObject({ verdict: 'supported', supersededBy: null, latest: R2338 });
  });

  it('refuses an empty release list rather than calling it supported', () => {
    expect(() => judgeRunnerVersion({ pinned: '2.338.2', releases: [], now: new Date() })).toThrow(
      'at least one release',
    );
  });
});

describe('the DLQ sentence', () => {
  it('names the pin, the release that started the clock, the cut-off and the steps, past the window', () => {
    const verdict = judgeRunnerVersion({
      pinned: '2.336.0',
      releases: RELEASES,
      now: at('2026-11-08T09:00:00Z'),
    });
    if (verdict.verdict !== 'unsupported') throw new Error('expected unsupported');
    const message = new RunnerVersionUnsupportedError(verdict).message;
    expect(message).toBe(runnerVersionSentence(verdict));
    expect(message).toContain(
      "v2.336.0 (RUNNER_VERSION in infra/ci-runner/Dockerfile on the default branch), is past GitHub's support window since 2026-09-24: v2.337.0 came out 2026-08-25",
    );
    expect(message).toContain('"is deprecated and cannot receive messages"');
    expect(message).toContain('Set RUNNER_VERSION and RUNNER_SHA256 to v2.338.2');
    expect(message).toContain('https://github.com/actions/runner/releases/tag/v2.338.2');
    expect(message).toContain('release runner-v<next> and ci-runner-ami-v<next>');
    expect(message).toContain('MOTIR_RUNNER_IMAGE and MOTIR_AWS_RUNNER_AMI_ID');
  });

  it('counts the days left while expiring, singular on the last day', () => {
    const deadline = Date.parse(R2338.publishedAt) + RUNNER_SUPPORT_WINDOW_DAYS * 86_400_000;
    const at13 = judgeRunnerVersion({
      pinned: '2.337.0',
      releases: RELEASES,
      now: new Date(deadline - 13.5 * 86_400_000),
    });
    const at1 = judgeRunnerVersion({
      pinned: '2.337.0',
      releases: RELEASES,
      now: new Date(deadline - 1.5 * 86_400_000),
    });
    if (at13.verdict !== 'expiring' || at1.verdict !== 'expiring')
      throw new Error('expected expiring');
    expect(runnerVersionSentence(at13)).toContain(
      "leaves GitHub's support window in 13 days, on 2026-11-25",
    );
    expect(runnerVersionSentence(at1)).toContain(
      "leaves GitHub's support window in 1 day, on 2026-11-25",
    );
    expect(new RunnerVersionUnsupportedError(at1).name).toBe('RunnerVersionUnsupportedError');
  });
});

describe('runnerVersionSupportProbeService.check', () => {
  const NOW = at('2026-11-08T09:00:00Z');
  const DOCKERFILE = 'FROM ubuntu\nARG RUNNER_VERSION=2.336.0\n';
  const BODY = [row('v2.338.2', R2338.publishedAt), row('v2.337.0', R2337.publishedAt)];

  beforeEach(() => {
    vi.stubEnv('MOTIR_RUNNER_IMAGE', 'ghcr.io/motir-co/motir-ci-runner@sha256:446c692d');
    vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', '');
    app.sourceRepoToken.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    app.sourceRepoToken.mockReset();
  });

  function github(file: () => Promise<string>, releases: () => Promise<unknown>) {
    return {
      file: vi.spyOn(runnerVersionSourcesClient, 'fileOnDefaultBranch').mockImplementation(file),
      releases: vi.spyOn(runnerVersionSourcesClient, 'releases').mockImplementation(releases),
    };
  }

  it('is not_applicable, reading nothing, on a deployment with no runner image and no AMI', async () => {
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    const reads = github(
      async () => DOCKERFILE,
      async () => BODY,
    );
    expect(await runnerVersionSupportProbeService.check({ now: NOW })).toEqual({
      verdict: 'not_applicable',
      checkedAt: NOW.toISOString(),
      reason: 'fleet_unset',
    });
    expect(reads.file).not.toHaveBeenCalled();
    expect(app.sourceRepoToken).not.toHaveBeenCalled();
  });

  it('runs for an AWS-only fleet (an AMI and no Fly image)', async () => {
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', 'ami-078ef45240c85b6af');
    github(
      async () => DOCKERFILE,
      async () => BODY,
    );
    expect(await runnerVersionSupportProbeService.check({ now: NOW })).toMatchObject({
      verdict: 'unsupported',
      pinned: '2.336.0',
    });
  });

  it('reads motir-core’s Dockerfile and actions/runner’s releases, and judges them', async () => {
    app.sourceRepoToken.mockResolvedValue('ghs_installation');
    const reads = github(
      async () => DOCKERFILE,
      async () => BODY,
    );
    const verdict = await runnerVersionSupportProbeService.check({ now: NOW });
    expect(verdict).toMatchObject({
      verdict: 'unsupported',
      pinned: '2.336.0',
      supersededBy: R2337,
      latest: R2338,
    });
    expect(reads.file).toHaveBeenCalledWith(
      { owner: 'motir-co', name: 'motir-core' },
      'infra/ci-runner/Dockerfile',
      'ghs_installation',
    );
    expect(reads.releases).toHaveBeenCalledWith(
      { owner: 'actions', name: 'runner' },
      'ghs_installation',
    );
    expect(app.sourceRepoToken).toHaveBeenCalledWith('motir-co');
  });

  it('falls back to an anonymous read once when the installation token is refused', async () => {
    app.sourceRepoToken.mockResolvedValue('ghs_installation');
    const file = vi
      .spyOn(runnerVersionSourcesClient, 'fileOnDefaultBranch')
      .mockImplementation(async (_repo, _path, token) => {
        if (token)
          throw new RunnerVersionSourceError(403, 'Resource not accessible by integration');
        return DOCKERFILE;
      });
    vi.spyOn(runnerVersionSourcesClient, 'releases').mockResolvedValue(BODY);
    expect(await runnerVersionSupportProbeService.check({ now: NOW })).toMatchObject({
      verdict: 'unsupported',
    });
    expect(file.mock.calls.map((c) => c[2])).toEqual(['ghs_installation', null]);
  });

  it('does not retry an anonymous read, nor a transport failure', async () => {
    app.sourceRepoToken.mockResolvedValue('ghs_installation');
    const file = vi
      .spyOn(runnerVersionSourcesClient, 'fileOnDefaultBranch')
      .mockRejectedValue(new RunnerVersionSourceError(null, 'ECONNRESET'));
    expect(await runnerVersionSupportProbeService.check({ now: NOW })).toEqual({
      verdict: 'indeterminate',
      checkedAt: NOW.toISOString(),
      phase: 'pin',
      detail:
        "infra/ci-runner/Dockerfile on motir-co/motir-core's default branch could not be read: GitHub could not be reached (ECONNRESET).",
    });
    expect(file).toHaveBeenCalledTimes(1);
  });

  it('is indeterminate at the pin when the Dockerfile carries no exact pin', async () => {
    github(
      async () => 'FROM ubuntu\nARG RUNNER_VERSION=latest\n',
      async () => BODY,
    );
    expect(await runnerVersionSupportProbeService.check({ now: NOW })).toMatchObject({
      verdict: 'indeterminate',
      phase: 'pin',
      detail: expect.stringContaining('carries no exact "ARG RUNNER_VERSION=<x.y.z>" line'),
    });
  });

  it('is indeterminate at the releases when GitHub refuses them', async () => {
    github(
      async () => DOCKERFILE,
      async () => {
        throw new RunnerVersionSourceError(403, 'API rate limit exceeded');
      },
    );
    expect(await runnerVersionSupportProbeService.check({ now: NOW })).toEqual({
      verdict: 'indeterminate',
      checkedAt: NOW.toISOString(),
      phase: 'releases',
      detail:
        "actions/runner's releases could not be read: GitHub refused the read (HTTP 403: API rate limit exceeded).",
    });
  });

  it('is indeterminate — never supported — when the list names no published release', async () => {
    github(
      async () => DOCKERFILE,
      async () => [row('v2.339.0', '2026-11-01T00:00:00Z', { prerelease: true })],
    );
    expect(await runnerVersionSupportProbeService.check({ now: NOW })).toMatchObject({
      verdict: 'indeterminate',
      phase: 'releases',
      detail: "actions/runner's release list named no published v<x.y.z> release",
    });
  });

  it('lets an unexpected error through rather than recording it as a read', async () => {
    github(
      async () => {
        throw new TypeError('bug');
      },
      async () => BODY,
    );
    await expect(runnerVersionSupportProbeService.check({ now: NOW })).rejects.toThrow('bug');
  });

  it('lets an unexpected error from the release read through too', async () => {
    github(
      async () => DOCKERFILE,
      async () => {
        throw new TypeError('release bug');
      },
    );
    await expect(runnerVersionSupportProbeService.check({ now: NOW })).rejects.toThrow(
      'release bug',
    );
  });

  it('is indeterminate when the release body is not a list', async () => {
    github(
      async () => DOCKERFILE,
      async () => ({ message: 'Moved Permanently' }),
    );
    expect(await runnerVersionSupportProbeService.check({ now: NOW })).toMatchObject({
      verdict: 'indeterminate',
      phase: 'releases',
    });
  });

  it('judges against the clock when no time is given', async () => {
    github(
      async () => DOCKERFILE,
      async () => BODY,
    );
    const before = Date.now();
    const verdict = await runnerVersionSupportProbeService.check();
    expect(Date.parse(verdict.checkedAt)).toBeGreaterThanOrEqual(before);
    expect(verdict.verdict).toBe('unsupported');
  });
});

describe('runnerVersionSourcesClient — the two GitHub requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: () => Response | Promise<Response>) {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response());
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('asks for the file raw, on the default branch, with the token when there is one', async () => {
    const fetch = stubFetch(() => new Response('ARG RUNNER_VERSION=2.338.2\n', { status: 200 }));
    const text = await runnerVersionSourcesClient.fileOnDefaultBranch(
      { owner: 'motir-co', name: 'motir-core' },
      'infra/ci-runner/Dockerfile',
      'ghs_token',
    );
    expect(text).toBe('ARG RUNNER_VERSION=2.338.2\n');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      'https://api.github.com/repos/motir-co/motir-core/contents/infra/ci-runner/Dockerfile',
    );
    expect(init?.headers).toEqual({
      accept: 'application/vnd.github.raw+json',
      'user-agent': 'motir',
      authorization: 'Bearer ghs_token',
    });
  });

  it('lists the newest 100 releases anonymously when there is no token', async () => {
    const fetch = stubFetch(() => Response.json([row('v2.338.2', R2338.publishedAt)]));
    const body = await runnerVersionSourcesClient.releases(
      { owner: 'actions', name: 'runner' },
      null,
    );
    expect(body).toEqual([row('v2.338.2', R2338.publishedAt)]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/actions/runner/releases?per_page=100');
    expect(init?.headers).not.toHaveProperty('authorization');
  });

  it('throws the status and GitHub’s message on a refusal', async () => {
    stubFetch(() => Response.json({ message: 'Not Found' }, { status: 404 }));
    const read = runnerVersionSourcesClient.releases({ owner: 'actions', name: 'runner' }, null);
    await expect(read).rejects.toMatchObject({
      name: 'RunnerVersionSourceError',
      code: 'RUNNER_VERSION_SOURCE_FAILED',
      status: 404,
      message: 'GitHub refused the read (HTTP 404: Not Found).',
    });
  });

  it('throws the status alone on a refusal with no JSON body', async () => {
    stubFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(
      runnerVersionSourcesClient.fileOnDefaultBranch({ owner: 'o', name: 'r' }, 'a b/c', null),
    ).rejects.toMatchObject({ status: 502, message: 'GitHub refused the read (HTTP 502).' });
  });

  it('throws a transport failure with no status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      }),
    );
    await expect(
      runnerVersionSourcesClient.releases({ owner: 'actions', name: 'runner' }, null),
    ).rejects.toMatchObject({
      status: null,
      message: 'GitHub could not be reached (getaddrinfo ENOTFOUND api.github.com).',
    });
  });

  it('throws when the release list is not JSON', async () => {
    stubFetch(() => new Response('not json', { status: 200 }));
    await expect(
      runnerVersionSourcesClient.releases({ owner: 'actions', name: 'runner' }, null),
    ).rejects.toMatchObject({
      status: 200,
      message: 'GitHub refused the read (HTTP 200: release list was not JSON).',
    });
  });

  it('encodes each path segment, keeping the slashes', async () => {
    const fetch = stubFetch(() => new Response('', { status: 200 }));
    await runnerVersionSourcesClient.fileOnDefaultBranch(
      { owner: 'o', name: 'r' },
      'a b/c#d',
      null,
    );
    expect(fetch.mock.calls[0]![0]).toBe('https://api.github.com/repos/o/r/contents/a%20b/c%23d');
  });

  it('ignores a refusal message that is not a string', async () => {
    stubFetch(() => Response.json({ message: 42 }, { status: 500 }));
    await expect(
      runnerVersionSourcesClient.releases({ owner: 'actions', name: 'runner' }, null),
    ).rejects.toMatchObject({ status: 500, message: 'GitHub refused the read (HTTP 500).' });
  });

  it('names a transport failure that is not an Error as unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'socket hang up';
      }),
    );
    await expect(
      runnerVersionSourcesClient.releases({ owner: 'actions', name: 'runner' }, null),
    ).rejects.toMatchObject({ status: null, message: 'GitHub could not be reached (unknown).' });
  });

  it('throws when the file body cannot be read', async () => {
    const unreadable = (reason: unknown) =>
      ({
        ok: true,
        status: 200,
        text: async () => {
          throw reason;
        },
      }) as unknown as Response;
    stubFetch(() => unreadable(new Error('stream aborted')));
    await expect(
      runnerVersionSourcesClient.fileOnDefaultBranch({ owner: 'o', name: 'r' }, 'f', null),
    ).rejects.toMatchObject({ message: 'GitHub refused the read (HTTP 200: stream aborted).' });
    stubFetch(() => unreadable('gone'));
    await expect(
      runnerVersionSourcesClient.fileOnDefaultBranch({ owner: 'o', name: 'r' }, 'f', null),
    ).rejects.toMatchObject({ message: 'GitHub refused the read (HTTP 200: unreadable body).' });
  });
});
