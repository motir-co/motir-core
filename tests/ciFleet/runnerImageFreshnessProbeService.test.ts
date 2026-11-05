import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE RUNNER-IMAGE FRESHNESS PROBE (MOTIR-10393): the daily health check fails
// when a merged change to a file the runner image is built from has not reached
// the image `MOTIR_RUNNER_IMAGE` pins. The registry and GitHub are faked at their
// seams — `readImageLabels` / `listImageTags` and the commit-history client —
// and this file pins the build commit's two sources, the commit-relation rule,
// every arm, and the error's sentence. The client's HTTP is pinned in
// `repoCommitHistory.test.ts`.

const registry = vi.hoisted(() => ({
  readImageLabels: vi.fn(),
  listImageTags: vi.fn(),
}));
vi.mock('@motir/orchestrator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@motir/orchestrator')>()),
  readImageLabels: registry.readImageLabels,
  listImageTags: registry.listImageTags,
}));
const app = vi.hoisted(() => ({
  getOrgInstallation: vi.fn(),
  mintInstallationToken: vi.fn(),
}));
vi.mock('@/lib/github/orgInstallation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/orgInstallation')>()),
  getOrgInstallation: app.getOrgInstallation,
}));
vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: app.mintInstallationToken,
}));

const { RunnerImageStaleError } = await import('@/lib/jobs/definitions/dailyHealthCheck');
const { runnerImageFreshnessProbeService, RUNNER_AMI_NOT_READ_REASON, unreleasedChanges } =
  await import('@/lib/services/runnerImageFreshnessProbeService');
const { repoCommitHistoryClient, RepoCommitHistoryError } =
  await import('@/lib/github/repoCommitHistory');
const { GithubAppTokenError } = await import('@/lib/github/appAuth');
const { OrgInstallationReadError } = await import('@/lib/github/orgInstallation');

const NOW = new Date('2026-11-05T09:00:00Z');
const REPO = 'ghcr.io/motir-co/motir-ci-runner';
const PINNED = `${REPO}@sha256:${'46'.repeat(32)}`;
const PLATFORM_DIGEST = `sha256:${'aa'.repeat(32)}`;
const BUILD = '4a9cb14b54e2366d2a30ad19ac4b924dddca6d31';
const DOCKERFILE_CHANGE = 'a4e83f13c8a344fd306993b997c9c361c29aa3e4';
const SCRIPT_CHANGE = 'c22cba55d5ece36c13e01d22c2656f03e7cb33cc';

function labelsRead(labels: Record<string, string>, digest: string | null = PLATFORM_DIGEST) {
  return { ok: true as const, reference: PINNED, digest, labels };
}

type Newest = { sha: string; committedAt: string; subject: string } | null;

/** GitHub: the newest commit per input path, and each commit's relation to BUILD. */
function github(
  newest: Record<string, Newest>,
  relation: Record<string, 'ahead' | 'behind' | 'identical' | 'diverged'>,
) {
  const touching = vi
    .spyOn(repoCommitHistoryClient, 'newestTouching')
    .mockImplementation(async (_repo, path) => newest[path] ?? null);
  const compare = vi
    .spyOn(repoCommitHistoryClient, 'relation')
    .mockImplementation(async (_repo, _base, head) => relation[head] ?? 'behind');
  return { touching, compare };
}

const dockerfileChange = {
  sha: DOCKERFILE_CHANGE,
  committedAt: '2026-11-03T12:00:00Z',
  subject: 'MOTIR-10293 Add the AWS CLI to the runner images',
};

beforeEach(() => {
  vi.stubEnv('MOTIR_RUNNER_IMAGE', PINNED);
  vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', '');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  registry.readImageLabels.mockReset();
  registry.listImageTags.mockReset();
  app.getOrgInstallation.mockReset();
  app.mintInstallationToken.mockReset();
});

describe('runnerImageFreshnessProbeService.check', () => {
  it('is not_applicable with no runner image pinned, and reads nothing', async () => {
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    expect(await runnerImageFreshnessProbeService.check({ now: NOW })).toEqual({
      verdict: 'not_applicable',
      checkedAt: NOW.toISOString(),
      reason: 'runner_image_unset',
      ami: { state: 'unset' },
    });
    expect(registry.readImageLabels).not.toHaveBeenCalled();
  });

  it('is STALE when the newest change to an input is ahead of the build commit (criterion 1)', async () => {
    registry.readImageLabels.mockResolvedValue(
      labelsRead({ 'org.opencontainers.image.revision': BUILD }),
    );
    const { compare } = github(
      {
        'infra/ci-runner/Dockerfile': dockerfileChange,
        'infra/ci-runner/entrypoint.sh': { ...dockerfileChange },
      },
      { [DOCKERFILE_CHANGE]: 'ahead' },
    );

    const verdict = await runnerImageFreshnessProbeService.check({ now: NOW });

    expect(verdict).toEqual({
      verdict: 'stale',
      checkedAt: NOW.toISOString(),
      build: { image: PINNED, commit: BUILD, source: 'label' },
      unreleased: [
        {
          commit: DOCKERFILE_CHANGE,
          committedAt: '2026-11-03T12:00:00Z',
          subject: 'MOTIR-10293 Add the AWS CLI to the runner images',
          paths: ['infra/ci-runner/Dockerfile', 'infra/ci-runner/entrypoint.sh'],
          relation: 'ahead',
        },
      ],
      ami: { state: 'unset' },
    });
    // One commit touching two inputs is compared once.
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenCalledWith(
      { owner: 'motir-co', name: 'motir-core' },
      BUILD,
      DOCKERFILE_CHANGE,
      null,
    );
  });

  it('names the pinned image, both commits and the release step in the error (criterion 1)', async () => {
    registry.readImageLabels.mockResolvedValue(
      labelsRead({ 'org.opencontainers.image.revision': BUILD }),
    );
    github(
      {
        'infra/ci-runner/Dockerfile': dockerfileChange,
        'infra/ci-runner/job-started.sh': {
          sha: SCRIPT_CHANGE,
          committedAt: '2026-11-04T08:00:00Z',
          subject: 'fix the job hook',
        },
      },
      { [DOCKERFILE_CHANGE]: 'ahead', [SCRIPT_CHANGE]: 'diverged' },
    );
    const verdict = await runnerImageFreshnessProbeService.check({ now: NOW });
    if (verdict.verdict !== 'stale') throw new Error(`expected stale, got ${verdict.verdict}`);

    // Newest change first.
    expect(verdict.unreleased.map((c) => c.commit)).toEqual([SCRIPT_CHANGE, DOCKERFILE_CHANGE]);
    const error = new RunnerImageStaleError(verdict);
    expect(error.name).toBe('RunnerImageStaleError');
    expect(error.message).toContain(
      `The pinned runner image ${PINNED} was built from 4a9cb14b54e2`,
    );
    expect(error.message).toContain('org.opencontainers.image.revision label');
    expect(error.message).toContain(
      'a4e83f13c8a3 (2026-11-03T12:00:00Z, "MOTIR-10293 Add the AWS CLI to the runner images", changes infra/ci-runner/Dockerfile)',
    );
    expect(error.message).toContain('the image was built from a branch without it');
    expect(error.message).toContain(
      `git tag runner-v<next> ${SCRIPT_CHANGE} && git push origin runner-v<next>`,
    );
    expect(error.message).toContain('.github/workflows/release-runner-image.yml');
    expect(error.message).toContain('set MOTIR_RUNNER_IMAGE to the digest');
  });

  it('is CURRENT when the build contains the newest change to every input (criterion 2)', async () => {
    registry.readImageLabels.mockResolvedValue(
      labelsRead({ 'org.opencontainers.image.revision': DOCKERFILE_CHANGE.toUpperCase() }),
    );
    github(
      { 'infra/ci-runner/Dockerfile': dockerfileChange, 'infra/ci-runner/entrypoint.sh': null },
      { [DOCKERFILE_CHANGE]: 'identical' },
    );
    expect(await runnerImageFreshnessProbeService.check({ now: NOW })).toEqual({
      verdict: 'current',
      checkedAt: NOW.toISOString(),
      build: { image: PINNED, commit: DOCKERFILE_CHANGE, source: 'label' },
      ami: { state: 'unset' },
    });
  });

  it('asks only of the image inputs, so a commit touching none of them cannot fail it (criterion 3)', async () => {
    registry.readImageLabels.mockResolvedValue(
      labelsRead({ 'org.opencontainers.image.revision': BUILD }),
    );
    // The newest commit to each input is older than the build (behind); a later
    // commit that only edited smoke/ or the README is never one of these.
    const { touching } = github(
      { 'infra/ci-runner/Dockerfile': { ...dockerfileChange, sha: SCRIPT_CHANGE } },
      { [SCRIPT_CHANGE]: 'behind' },
    );
    expect(await runnerImageFreshnessProbeService.check({ now: NOW })).toMatchObject({
      verdict: 'current',
    });
    expect(touching.mock.calls.map((c) => c[1])).toEqual([
      'infra/ci-runner/Dockerfile',
      'infra/ci-runner/entrypoint.sh',
      'infra/ci-runner/start-dockerd.sh',
      'infra/ci-runner/job-started.sh',
      'infra/ci-runner/smoke/list-tools.sh',
    ]);
  });

  it('finds the build commit from the sha- tag with the same bytes on an unlabelled image', async () => {
    registry.readImageLabels.mockImplementation(async (ref: string) => {
      if (ref === PINNED) return labelsRead({ 'co.motir.ci-runner.tools': 'git' });
      if (ref === `${REPO}:sha-${BUILD}`) return labelsRead({});
      return labelsRead({}, `sha256:${'bb'.repeat(32)}`);
    });
    registry.listImageTags.mockResolvedValue({
      ok: true,
      registry: 'ghcr.io',
      repository: 'motir-co/motir-ci-runner',
      tags: ['0.2.3', `sha-${SCRIPT_CHANGE}`, '0.2.4', `sha-${BUILD}`],
    });
    github({ 'infra/ci-runner/Dockerfile': dockerfileChange }, { [DOCKERFILE_CHANGE]: 'ahead' });

    const verdict = await runnerImageFreshnessProbeService.check({ now: NOW });

    expect(registry.listImageTags).toHaveBeenCalledWith(REPO);
    expect(verdict).toMatchObject({
      verdict: 'stale',
      build: { image: PINNED, commit: BUILD, source: 'sha_tag' },
    });
    if (verdict.verdict !== 'stale') throw new Error('expected stale');
    expect(new RunnerImageStaleError(verdict).message).toContain(
      '(read from its sha- registry tag)',
    );
  });

  describe('could not tell — indeterminate, never current (criterion 4)', () => {
    it('when the pinned image registry entry cannot be read', async () => {
      registry.readImageLabels.mockResolvedValue({
        ok: false,
        reference: PINNED,
        reason: 'unreachable',
        detail: 'the registry could not be reached: ECONNRESET',
      });
      const touching = vi.spyOn(repoCommitHistoryClient, 'newestTouching');
      expect(await runnerImageFreshnessProbeService.check({ now: NOW })).toEqual({
        verdict: 'indeterminate',
        checkedAt: NOW.toISOString(),
        image: PINNED,
        phase: 'registry',
        detail:
          "the pinned image's registry entry could not be read (unreachable: the registry could not be reached: ECONNRESET)",
        ami: { state: 'unset' },
      });
      expect(touching).not.toHaveBeenCalled();
    });

    it('when an unlabelled image matches no sha- tag', async () => {
      registry.readImageLabels.mockImplementation(async (ref: string) =>
        ref === PINNED ? labelsRead({}) : labelsRead({}, `sha256:${'bb'.repeat(32)}`),
      );
      registry.listImageTags.mockResolvedValue({
        ok: true,
        registry: 'ghcr.io',
        repository: 'motir-co/motir-ci-runner',
        tags: ['0.2.4', `sha-${BUILD}`],
      });
      expect(await runnerImageFreshnessProbeService.check({ now: NOW })).toMatchObject({
        verdict: 'indeterminate',
        phase: 'build_commit',
        detail: expect.stringContaining(`none of the 1 sha- tags in ${REPO} resolves to it`),
      });
    });

    it('when the tag list cannot be read', async () => {
      registry.readImageLabels.mockResolvedValue(labelsRead({}));
      registry.listImageTags.mockResolvedValue({
        ok: false,
        reason: 'refused',
        detail: 'the registry refused the tag list (HTTP 500)',
      });
      expect(await runnerImageFreshnessProbeService.check({ now: NOW })).toMatchObject({
        verdict: 'indeterminate',
        phase: 'build_commit',
        detail: expect.stringContaining("the registry's tag list could not be read (refused"),
      });
    });

    it('when the registry names no digest to match against', async () => {
      registry.readImageLabels.mockResolvedValue(labelsRead({}, null));
      expect(await runnerImageFreshnessProbeService.check({ now: NOW })).toMatchObject({
        verdict: 'indeterminate',
        phase: 'build_commit',
        detail: expect.stringContaining('named no digest'),
      });
      expect(registry.listImageTags).not.toHaveBeenCalled();
    });

    it('when GitHub refuses the history read', async () => {
      registry.readImageLabels.mockResolvedValue(
        labelsRead({ 'org.opencontainers.image.revision': BUILD }),
      );
      vi.spyOn(repoCommitHistoryClient, 'newestTouching').mockResolvedValue(dockerfileChange);
      vi.spyOn(repoCommitHistoryClient, 'relation').mockRejectedValue(
        new RepoCommitHistoryError(404, 'No common ancestor between'),
      );
      expect(await runnerImageFreshnessProbeService.check({ now: NOW })).toMatchObject({
        verdict: 'indeterminate',
        phase: 'github',
        detail: expect.stringContaining(
          `motir-co/motir-core's history could not be read against ${BUILD}`,
        ),
      });
    });

    it('rethrows anything that is not a GitHub refusal', async () => {
      registry.readImageLabels.mockResolvedValue(
        labelsRead({ 'org.opencontainers.image.revision': BUILD }),
      );
      vi.spyOn(repoCommitHistoryClient, 'newestTouching').mockRejectedValue(new TypeError('bug'));
      await expect(runnerImageFreshnessProbeService.check({ now: NOW })).rejects.toThrow('bug');
    });
  });

  it('records the AMI as not read, with why, whenever one is pinned (criterion 5)', async () => {
    vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', 'ami-0123456789abcdef0');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    expect(await runnerImageFreshnessProbeService.check({ now: NOW })).toMatchObject({
      ami: {
        state: 'not_read',
        amiId: 'ami-0123456789abcdef0',
        reason: RUNNER_AMI_NOT_READ_REASON,
      },
    });
    expect(RUNNER_AMI_NOT_READ_REASON).toContain('ec2:DescribeImages');
  });

  describe('the GitHub token', () => {
    beforeEach(() => {
      vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
      vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', 'a-key');
      registry.readImageLabels.mockResolvedValue(
        labelsRead({ 'org.opencontainers.image.revision': BUILD }),
      );
    });

    const installation = {
      id: '77',
      permissions: {},
      events: [],
      repositorySelection: 'all' as const,
      suspendedAt: null,
    };

    it("is the provisioning App's installation token on the source repository's owner", async () => {
      app.getOrgInstallation.mockResolvedValue(installation);
      app.mintInstallationToken.mockResolvedValue({
        token: 'ghs_install',
        expiresAt: new Date('2026-11-05T10:00:00Z'),
      });
      const { touching } = github({}, {});
      await runnerImageFreshnessProbeService.check({ now: NOW });
      expect(app.getOrgInstallation).toHaveBeenCalledWith('motir-co', 'provisioning');
      expect(app.mintInstallationToken).toHaveBeenCalledWith('77', 'provisioning');
      expect(touching.mock.calls[0]![2]).toBe('ghs_install');
    });

    it('is anonymous when the App is not installed, suspended, or refuses', async () => {
      const getInstallation = app.getOrgInstallation;
      const { touching } = github({}, {});

      getInstallation.mockResolvedValueOnce(null);
      await runnerImageFreshnessProbeService.check({ now: NOW });
      getInstallation.mockResolvedValueOnce({
        ...installation,
        suspendedAt: '2026-11-01T00:00:00Z',
      });
      await runnerImageFreshnessProbeService.check({ now: NOW });
      getInstallation.mockRejectedValueOnce(new OrgInstallationReadError(502, 'bad'));
      await runnerImageFreshnessProbeService.check({ now: NOW });
      getInstallation.mockResolvedValueOnce(installation);
      app.mintInstallationToken.mockRejectedValueOnce(new GithubAppTokenError('refused', 401));
      await runnerImageFreshnessProbeService.check({ now: NOW });

      const tokens = touching.mock.calls.filter((c) => c[1] === 'infra/ci-runner/Dockerfile');
      expect(tokens.map((c) => c[2])).toEqual([null, null, null, null]);
    });

    it('rethrows an unexpected failure while minting', async () => {
      app.getOrgInstallation.mockRejectedValue(new TypeError('boom'));
      await expect(runnerImageFreshnessProbeService.check({ now: NOW })).rejects.toThrow('boom');
    });
  });
});

describe('unreleasedChanges', () => {
  it('skips an input no commit ever touched and a commit already judged contained', async () => {
    const { compare } = github(
      {
        a: dockerfileChange,
        b: dockerfileChange,
        c: null,
      },
      { [DOCKERFILE_CHANGE]: 'behind' },
    );
    expect(
      await unreleasedChanges({ owner: 'o', name: 'n' }, BUILD, ['a', 'b', 'c'], null),
    ).toEqual([]);
    expect(compare).toHaveBeenCalledTimes(1);
  });
});
