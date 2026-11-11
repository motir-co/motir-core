import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { FleetPublishRecordDTO } from '@/lib/dto/fleetStatusImages';
import type { RunnerImageFreshnessVerdictDTO } from '@/lib/dto/runnerImageFreshness';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import type { PlatformRole } from '@/generated/prisma/client';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE FLEET STATUS PAGE'S IMAGES SERVICE (MOTIR-10886; design MOTIR-10885)
// against a real Postgres: the `fleet.status.read` / `fleet.image.publish` audit
// chain is real. The registry (`@motir/orchestrator`), this deployment's pins
// (`@/lib/orchestrator`), the runner freshness probe and GitHub are faked at
// their seams, so every arm of the three rows, of a press's progress, of
// Publish latest and of the poll is pinned. The client's HTTP is pinned in
// `tests/github/publishWorkflows.test.ts`.

const registry = vi.hoisted(() => ({
  readImageCreated: vi.fn(),
  readImageLabels: vi.fn(),
  listImageTags: vi.fn(),
}));
vi.mock('@motir/orchestrator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@motir/orchestrator')>()),
  readImageCreated: registry.readImageCreated,
  readImageLabels: registry.readImageLabels,
  listImageTags: registry.listImageTags,
}));

const env = vi.hoisted(() => ({
  provider: 'aws' as string,
  hostedConfigured: true,
  hostedPin: '' as string | Error,
  runnerPin: null as string | null,
}));
vi.mock('@/lib/orchestrator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestrator')>()),
  selectedOrchestratorProvider: () => env.provider,
  isHostedAgentConfigured: () => env.hostedConfigured,
  hostedAgentImage: () => {
    if (env.hostedPin instanceof Error) throw env.hostedPin;
    return env.hostedPin;
  },
  configuredFleetRunnerImage: () => env.runnerPin,
}));

const probe = vi.hoisted(() => ({ check: vi.fn(), token: vi.fn() }));
vi.mock('@/lib/services/runnerImageFreshnessProbeService', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/runnerImageFreshnessProbeService')>();
  return {
    ...actual,
    runnerImageFreshnessProbeService: { check: probe.check },
    sourceRepoToken: probe.token,
  };
});

let currentPrincipal: PlatformPrincipal;
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return {
    ...actual,
    requirePlatformStaff: async (minimum: PlatformRole = 'support') => {
      if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
        const { NotPlatformStaffError: Refused } = await import('@/lib/platform/errors');
        throw new Refused();
      }
      return currentPrincipal;
    },
  };
});

const {
  fleetStatusImagesService: service,
  SANDBOX_IMAGE_IDS,
  PUBLISH_REASON,
} = await import('@/lib/services/fleetStatusImagesService');
const { publishWorkflowsClient, PublishWorkflowError } =
  await import('@/lib/github/publishWorkflows');
const { repoCommitHistoryClient, RepoCommitHistoryError } =
  await import('@/lib/github/repoCommitHistory');
const { imageCatalogSeam } = await import('@/lib/agentInstances/imageCatalog');
const { agentInstanceRepository } = await import('@/lib/repositories/agentInstanceRepository');
const { withPlatformWrite } = await import('@/lib/platform/context');

const NOW = new Date('2026-11-10T12:00:00Z');
const HOSTED = 'ghcr.io/motir-co/motir-hosted-agent';
const RUNNER = 'ghcr.io/motir-co/motir-ci-runner';
const PIN = `sha256:${'46'.repeat(32)}`;
const NEW = `sha256:${'9f'.repeat(32)}`;
const MID = `sha256:${'5a'.repeat(32)}`;
const PIN_COMMIT = '4a9cb14b54e2366d2a30ad19ac4b924dddca6d31';
const NEW_COMMIT = 'c22cba55d5ece36c13e01d22c2656f03e7cb33cc';
const LABEL = 'org.opencontainers.image.revision';

type Image = { digest: string | null; createdAt: string | null; commit?: string | null };
let images: Record<string, Image | 'fail'>;

function created(ref: string) {
  const image = images[ref];
  if (!image || image === 'fail') {
    return { ok: false, reason: 'unreachable', detail: `no ${ref}` };
  }
  return { ok: true, reference: ref, digest: image.digest, createdAt: image.createdAt };
}

function labels(ref: string) {
  const image = images[ref];
  if (!image || image === 'fail') {
    return { ok: false, reason: 'unreachable', detail: `no ${ref}` };
  }
  return {
    ok: true,
    reference: ref,
    digest: image.digest,
    labels: image.commit ? { [LABEL]: image.commit } : {},
  };
}

function probeCurrent(): RunnerImageFreshnessVerdictDTO {
  return {
    verdict: 'current',
    checkedAt: NOW.toISOString(),
    build: { image: `${RUNNER}@${PIN}`, commit: PIN_COMMIT, source: 'label' },
    ami: { state: 'unset' },
  };
}

const workflowRun = (over: Record<string, unknown> = {}) => ({
  id: 77,
  runNumber: 12,
  htmlUrl: 'https://github.com/motir-co/motir-core/actions/runs/77',
  status: 'completed',
  conclusion: 'success',
  createdAt: '2026-11-10T11:00:00Z',
  updatedAt: '2026-11-10T11:30:00Z',
  ...over,
});

const record = (over: Partial<FleetPublishRecordDTO> = {}): FleetPublishRecordDTO => ({
  actorEmail: 'ops@example.test',
  at: '2026-11-10T11:00:00.000Z',
  from: PIN,
  to: NEW,
  target: NEW,
  runId: 77,
  runUrl: 'https://github.com/motir-co/motir-core/actions/runs/77',
  runNumber: 12,
  ...over,
});

function makeSpies() {
  return {
    activeRuns: vi.spyOn(publishWorkflowsClient, 'activeRuns').mockResolvedValue([]),
    run: vi.spyOn(publishWorkflowsClient, 'run').mockResolvedValue(workflowRun()),
    failureDetail: vi
      .spyOn(publishWorkflowsClient, 'failureDetail')
      .mockResolvedValue('the pin PR could not be opened'),
    countPathCommits: vi.spyOn(publishWorkflowsClient, 'countPathCommits').mockResolvedValue(5),
    tagsWithPrefix: vi.spyOn(publishWorkflowsClient, 'tagsWithPrefix').mockResolvedValue([
      { name: 'cli-v0.17.2', commit: PIN_COMMIT },
      { name: 'cli-v0.18.0', commit: `tag:${'ab'.repeat(20)}` },
      { name: 'cli-v-broken', commit: 'x' },
    ]),
    peel: vi.spyOn(publishWorkflowsClient, 'peel').mockResolvedValue(NEW_COMMIT),
    commitDate: vi
      .spyOn(publishWorkflowsClient, 'commitDate')
      .mockResolvedValue('2026-11-05T00:00:00Z'),
    pathExists: vi.spyOn(publishWorkflowsClient, 'pathExists').mockResolvedValue(true),
    dispatch: vi
      .spyOn(publishWorkflowsClient, 'dispatch')
      .mockResolvedValue(
        workflowRun({ id: 88, runNumber: 13, status: 'queued', conclusion: null }),
      ),
  };
}

let gh: ReturnType<typeof makeSpies>;
let registryTags: string[] | null;

async function principal(role: PlatformRole): Promise<PlatformPrincipal> {
  const user = await createTestUser();
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role };
}

beforeEach(async () => {
  await truncateAuthTables();
  currentPrincipal = await principal('superadmin');
  env.provider = 'aws';
  env.hostedConfigured = true;
  env.hostedPin = `${HOSTED}@${PIN}`;
  env.runnerPin = `${RUNNER}@${PIN}`;
  images = {
    [`${HOSTED}@${PIN}`]: { digest: PIN, createdAt: '2026-11-01T00:00:00Z', commit: PIN_COMMIT },
    [`${HOSTED}:main`]: { digest: NEW, createdAt: '2026-11-04T06:00:00Z', commit: NEW_COMMIT },
    [`${RUNNER}@${PIN}`]: { digest: PIN, createdAt: '2026-11-01T00:00:00Z' },
    [`${RUNNER}:0.2.6`]: { digest: NEW, createdAt: '2026-11-06T00:00:00Z', commit: NEW_COMMIT },
    [`${RUNNER}:0.2.5`]: { digest: MID, createdAt: '2026-11-03T00:00:00Z' },
    [`${RUNNER}:0.2.4`]: { digest: PIN, createdAt: '2026-11-01T00:00:00Z' },
  };
  registry.readImageCreated.mockImplementation(async (ref: string) => created(ref));
  registry.readImageLabels.mockImplementation(async (ref: string) => labels(ref));
  registry.listImageTags.mockResolvedValue({
    ok: true,
    tags: ['0.2.4', '0.2.5', '0.2.6', `sha-${NEW_COMMIT}`, 'latest'],
  });
  probe.check.mockResolvedValue(probeCurrent());
  probe.token.mockResolvedValue('tok');

  gh = makeSpies();
  registryTags = SANDBOX_IMAGE_IDS.flatMap((id) => [`${id}-0.17.2`, `${id}-0.18.0`]);
  imageCatalogSeam.setRegistry({
    listTags: async () => registryTags,
    resolveDigest: async () => null,
  });
  vi.spyOn(agentInstanceRepository, 'countLiveByImageVersion').mockResolvedValue([
    { imageVersion: '0.17.2', count: 2 },
    { imageVersion: '0.18.0', count: 3 },
    { imageVersion: null, count: 1 },
    { imageVersion: 'custom', count: 9 },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  imageCatalogSeam.reset();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('SANDBOX_IMAGE_IDS', () => {
  it('is base, then the CI matrix’s profiles in profiles.json’s order', () => {
    const matrix = JSON.parse(
      readFileSync(join(process.cwd(), 'packages/cli/sandbox/smoke/profiles.json'), 'utf8'),
    ) as { profiles: Array<{ id: string }> };
    expect(SANDBOX_IMAGE_IDS).toEqual(['base', ...matrix.profiles.map((p) => p.id)]);
  });
});

describe('who may read', () => {
  it.each(['support', 'operator'] as const)('a %s is refused every door', async (role) => {
    currentPrincipal = await principal(role);
    for (const read of [
      () => service.publishRecords(currentPrincipal),
      () => service.readHosted(null, NOW),
      () => service.readRunner(null, NOW),
      () => service.readSandbox(null, NOW),
      () => service.publish(currentPrincipal, 'hosted'),
      () => service.publishEnded('hosted', 77, NEW),
    ]) {
      await expect(read()).rejects.toBeInstanceOf(NotPlatformStaffError);
    }
    expect(gh.dispatch).not.toHaveBeenCalled();
  });
});

describe('the hosted-agent row', () => {
  it('behind: both builds, the day gap, the packages/cli commits and the pin target', async () => {
    const row = await service.readHosted(null, NOW);
    expect(row).toMatchObject({
      status: 'read',
      pinned: { digest: PIN, commit: PIN_COMMIT, createdAt: '2026-11-01T00:00:00Z' },
      newest: { digest: NEW, commit: NEW_COMMIT },
      behind: true,
      daysBehind: 3,
      cliCommits: 5,
      compareUrl: `https://github.com/motir-co/motir-core/compare/${PIN_COMMIT}...${NEW_COMMIT}`,
      publish: {
        record: null,
        progress: { state: 'idle' },
        activeRun: false,
        blocked: null,
        target: {
          workflow: 'hosted-agent-image.yml',
          ref: 'main',
          inputs: { digest: NEW, source_commit: NEW_COMMIT },
          from: `${PIN} (4a9cb14)`,
          to: `${NEW} (c22cba5)`,
          target: NEW,
        },
      },
    });
    expect(gh.countPathCommits).toHaveBeenCalledWith(
      { owner: 'motir-co', name: 'motir-core' },
      PIN_COMMIT,
      NEW_COMMIT,
      'packages/cli',
      'tok',
    );
    expect(gh.activeRuns).toHaveBeenCalledWith(expect.anything(), 'hosted-agent-image.yml', 'tok');
  });

  it('on the newest build: no target, and Publish latest is held up to date', async () => {
    images[`${HOSTED}:main`] = { digest: PIN, createdAt: '2026-11-01T00:00:00Z' };
    const row = await service.readHosted(null, NOW);
    expect(row).toMatchObject({
      behind: false,
      daysBehind: null,
      cliCommits: null,
      compareUrl: null,
      publish: { target: null, blocked: 'up_to_date' },
    });
    expect(gh.countPathCommits).not.toHaveBeenCalled();
  });

  it('builds with no recorded commit leave the commit count and compare empty', async () => {
    images[`${HOSTED}@${PIN}`] = { digest: PIN, createdAt: null };
    images[`${HOSTED}:main`] = { digest: NEW, createdAt: '2026-11-04T00:00:00Z' };
    const row = await service.readHosted(null, NOW);
    expect(row).toMatchObject({
      daysBehind: null,
      cliCommits: null,
      compareUrl: null,
      publish: { target: { from: PIN, to: NEW, inputs: { source_commit: '' } } },
    });
  });

  it.each([
    ['the fake provider', () => (env.provider = 'fake')],
    ['no hosted agent configured', () => (env.hostedConfigured = false)],
    ['a pin that does not parse', () => (env.hostedPin = new Error('bad pin'))],
  ])('%s is unset', async (_name, arrange) => {
    arrange();
    expect(await service.readHosted(null, NOW)).toEqual({
      status: 'unset',
      variable: 'MOTIR_HOSTED_AGENT_IMAGE',
    });
  });

  it('a registry read that fails is Not read (GHCR), naming the read', async () => {
    images[`${HOSTED}:main`] = 'fail';
    expect(await service.readHosted(null, NOW)).toEqual({
      status: 'not_read',
      source: 'ghcr',
      detail: `${HOSTED}:main: unreachable: no ${HOSTED}:main`,
    });
    registry.readImageLabels.mockResolvedValueOnce({ ok: false, reason: 'denied', detail: 'x' });
    expect(await service.readHosted(null, NOW)).toMatchObject({
      status: 'not_read',
      source: 'ghcr',
    });
  });

  it(':main with no digest is Not read', async () => {
    images[`${HOSTED}:main`] = { digest: null, createdAt: null };
    expect(await service.readHosted(null, NOW)).toMatchObject({
      status: 'not_read',
      source: 'ghcr',
      detail: 'the registry named no digest for :main',
    });
  });

  it('a GitHub refusal is Not read (GitHub)', async () => {
    gh.countPathCommits.mockRejectedValueOnce(new PublishWorkflowError(500, 'boom'));
    expect(await service.readHosted(null, NOW)).toMatchObject({
      status: 'not_read',
      source: 'github',
    });
    gh.activeRuns.mockRejectedValueOnce(new PublishWorkflowError(null, 'reset'));
    expect(await service.readHosted(null, NOW)).toMatchObject({
      status: 'not_read',
      source: 'github',
      detail: 'GitHub could not be reached (reset).',
    });
  });

  it('an error that is no read’s failure is not swallowed', async () => {
    gh.countPathCommits.mockRejectedValueOnce(new TypeError('a bug'));
    await expect(service.readHosted(null, NOW)).rejects.toBeInstanceOf(TypeError);
    gh.run.mockRejectedValueOnce(new TypeError('a bug'));
    await expect(service.readHosted(record(), NOW)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('a press’s progress', () => {
  it('no press, or a press with no run, is idle', async () => {
    const row = await service.readHosted(record({ runId: null }), NOW);
    expect(row).toMatchObject({ publish: { progress: { state: 'idle' } } });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('a run GitHub will not show is idle', async () => {
    gh.run.mockRejectedValueOnce(new PublishWorkflowError(404, 'Not Found'));
    expect(await service.readHosted(record(), NOW)).toMatchObject({
      publish: { progress: { state: 'idle' }, blocked: null },
    });
  });

  it('a run not yet completed is running, and holds Publish latest', async () => {
    gh.run.mockResolvedValueOnce(workflowRun({ status: 'in_progress', conclusion: null }));
    expect(await service.readHosted(record(), NOW)).toMatchObject({
      publish: {
        progress: { state: 'running', startedAt: '2026-11-10T11:00:00.000Z' },
        blocked: 'running',
      },
    });
  });

  it('an active run of the workflow holds Publish latest whatever the press says', async () => {
    gh.activeRuns.mockResolvedValueOnce([workflowRun({ status: 'queued' })]);
    expect(await service.readHosted(null, NOW)).toMatchObject({
      publish: { activeRun: true, blocked: 'running', progress: { state: 'idle' } },
    });
  });

  it('a successful pin run whose pin has landed is done for a day, then idle', async () => {
    images[`${HOSTED}:main`] = { digest: PIN, createdAt: '2026-11-01T00:00:00Z' };
    const landed = record({ target: PIN });
    expect(await service.readHosted(landed, NOW)).toMatchObject({
      publish: { progress: { state: 'done', endedAt: '2026-11-10T11:30:00Z' } },
    });
    const later = new Date('2026-11-12T00:00:00Z');
    expect(await service.readHosted(landed, later)).toMatchObject({
      publish: { progress: { state: 'idle' } },
    });
  });

  it('a successful pin run not yet landed is publishing for six hours, then idle', async () => {
    expect(await service.readHosted(record(), NOW)).toMatchObject({
      publish: { progress: { state: 'running' }, blocked: 'running' },
    });
    expect(await service.readHosted(record(), new Date('2026-11-10T18:00:00Z'))).toMatchObject({
      publish: { progress: { state: 'idle' }, blocked: null },
    });
  });

  it('a run with no end time is timed from the press', async () => {
    gh.run.mockResolvedValueOnce(workflowRun({ updatedAt: '', conclusion: 'failure' }));
    expect(await service.readHosted(record(), NOW)).toMatchObject({
      publish: {
        progress: {
          state: 'failed',
          endedAt: '2026-11-10T11:00:00.000Z',
          error: 'the pin PR could not be opened',
        },
      },
    });
  });

  it('a failed run is failed with GitHub’s words, or none when they cannot be read', async () => {
    gh.run.mockResolvedValue(workflowRun({ conclusion: 'failure' }));
    gh.failureDetail.mockRejectedValueOnce(new PublishWorkflowError(500, ''));
    expect(await service.readHosted(record(), NOW)).toMatchObject({
      publish: { progress: { state: 'failed', error: null } },
    });
    expect(gh.failureDetail).toHaveBeenCalledWith(expect.anything(), 77, 'tok');
  });

  it('a failed run whose target has landed anyway is idle', async () => {
    images[`${HOSTED}:main`] = { digest: PIN, createdAt: '2026-11-01T00:00:00Z' };
    gh.run.mockResolvedValue(workflowRun({ conclusion: 'cancelled' }));
    expect(await service.readHosted(record({ target: PIN }), NOW)).toMatchObject({
      publish: { progress: { state: 'idle' } },
    });
  });
});

describe('the CI runner row', () => {
  it('behind by two releases: the pinned release, the releases between, and the pin target', async () => {
    const row = await service.readRunner(null, NOW);
    expect(row).toMatchObject({
      status: 'read',
      pinned: { digest: PIN, commit: PIN_COMMIT, version: '0.2.4' },
      newest: { digest: NEW, commit: NEW_COMMIT, version: '0.2.6' },
      behind: true,
      releasesBetween: ['runner-v0.2.5', 'runner-v0.2.6'],
      daysBehind: 5,
      runnerCommits: 5,
      compareUrl: 'https://github.com/motir-co/motir-core/compare/runner-v0.2.4...runner-v0.2.6',
      unreleased: [],
      nextTag: 'runner-v0.2.7',
      ami: { state: 'unset' },
      publish: {
        blocked: null,
        target: {
          workflow: 'release-runner-image.yml',
          ref: 'main',
          inputs: { pin_digest: NEW, pin_version: '0.2.6' },
          from: `runner-v0.2.4 (${PIN})`,
          to: `runner-v0.2.6 (${NEW})`,
          target: NEW,
        },
      },
    });
    expect(gh.countPathCommits).toHaveBeenCalledWith(
      expect.anything(),
      PIN_COMMIT,
      NEW_COMMIT,
      'infra/ci-runner',
      'tok',
    );
  });

  it('pinned bytes no release names: no releases between, the compare by commit', async () => {
    images[`${RUNNER}:0.2.4`] = { digest: MID, createdAt: null };
    const row = await service.readRunner(null, NOW);
    expect(row).toMatchObject({
      pinned: { version: null },
      releasesBetween: null,
      compareUrl: `https://github.com/motir-co/motir-core/compare/${PIN_COMMIT}...${NEW_COMMIT}`,
      publish: { target: { from: PIN } },
    });
  });

  it('a newest release with no recorded commit has no compare and no commit count', async () => {
    images[`${RUNNER}:0.2.4`] = { digest: MID, createdAt: null };
    images[`${RUNNER}:0.2.6`] = { digest: NEW, createdAt: '2026-11-06T00:00:00Z' };
    const row = await service.readRunner(null, NOW);
    expect(row).toMatchObject({ compareUrl: null, runnerCommits: null });
  });

  it('a pin with no digest is judged by the digest it resolves to', async () => {
    env.runnerPin = `${RUNNER}:0.2.6`;
    expect(await service.readRunner(null, NOW)).toMatchObject({
      behind: false,
      pinned: { digest: NEW, version: '0.2.6' },
      releasesBetween: [],
      daysBehind: null,
      compareUrl: null,
      publish: { target: null, blocked: 'up_to_date' },
    });
  });

  it('merged changes the newest release lacks need a release, not a publish', async () => {
    const change = (commit: string) => ({
      commit,
      committedAt: '2026-11-07T00:00:00Z',
      subject: `change ${commit}`,
      paths: ['infra/ci-runner/Dockerfile'],
      relation: 'ahead' as const,
    });
    probe.check.mockResolvedValue({
      ...probeCurrent(),
      verdict: 'stale',
      unreleased: [change('a1'), change('b2'), change('c3')],
    });
    const relation = vi
      .spyOn(repoCommitHistoryClient, 'relation')
      .mockImplementation(async (_repo, _base, head) =>
        head === 'a1' ? 'ahead' : head === 'b2' ? 'diverged' : 'behind',
      );
    const behind = await service.readRunner(null, NOW);
    expect(behind).toMatchObject({ unreleased: [{ commit: 'a1' }, { commit: 'b2' }] });
    expect(relation).toHaveBeenCalledWith(expect.anything(), NEW_COMMIT, 'a1', 'tok');

    env.runnerPin = `${RUNNER}@${NEW}`;
    images[`${RUNNER}@${NEW}`] = { digest: NEW, createdAt: '2026-11-06T00:00:00Z' };
    relation.mockClear();
    const current = await service.readRunner(null, NOW);
    expect(current).toMatchObject({
      behind: false,
      unreleased: [{ commit: 'a1' }, { commit: 'b2' }, { commit: 'c3' }],
      publish: { target: null, blocked: 'release_needed' },
    });
    expect(relation).not.toHaveBeenCalled();
  });

  it('a history refusal on the release filter is Not read (GitHub)', async () => {
    probe.check.mockResolvedValue({
      ...probeCurrent(),
      verdict: 'stale',
      unreleased: [
        { commit: 'a1', committedAt: 'x', subject: 's', paths: [], relation: 'ahead' as const },
      ],
    });
    vi.spyOn(repoCommitHistoryClient, 'relation').mockRejectedValue(
      new RepoCommitHistoryError(500, 'compare failed'),
    );
    expect(await service.readRunner(null, NOW)).toMatchObject({
      status: 'not_read',
      source: 'github',
    });
  });

  it('no pinned image, or the probe calling it not applicable, is unset', async () => {
    env.runnerPin = null;
    expect(await service.readRunner(null, NOW)).toEqual({
      status: 'unset',
      variable: 'MOTIR_RUNNER_IMAGE',
    });
    env.runnerPin = `${RUNNER}@${PIN}`;
    probe.check.mockResolvedValue({
      verdict: 'not_applicable',
      checkedAt: 'x',
      reason: 'runner_image_unset',
      ami: { state: 'unset' },
    });
    expect(await service.readRunner(null, NOW)).toMatchObject({ status: 'unset' });
  });

  it.each([
    ['github', 'github'],
    ['registry', 'ghcr'],
    ['build_commit', 'ghcr'],
  ] as const)('an indeterminate probe (%s) is Not read (%s)', async (phase, source) => {
    probe.check.mockResolvedValue({
      verdict: 'indeterminate',
      checkedAt: 'x',
      image: `${RUNNER}@${PIN}`,
      phase,
      detail: 'the read failed',
      ami: { state: 'unset' },
    });
    expect(await service.readRunner(null, NOW)).toEqual({
      status: 'not_read',
      source,
      detail: 'the read failed',
    });
  });

  it('the registry’s tag listing, an empty release list, or the pin’s read failing is Not read (GHCR)', async () => {
    registry.listImageTags.mockResolvedValueOnce({ ok: false, reason: 'denied', detail: '401' });
    expect(await service.readRunner(null, NOW)).toEqual({
      status: 'not_read',
      source: 'ghcr',
      detail: `${RUNNER}: denied: 401`,
    });
    registry.listImageTags.mockResolvedValueOnce({ ok: true, tags: ['latest'] });
    expect(await service.readRunner(null, NOW)).toMatchObject({
      detail: `${RUNNER} has no release tag`,
    });
    images[`${RUNNER}@${PIN}`] = 'fail';
    expect(await service.readRunner(null, NOW)).toMatchObject({
      status: 'not_read',
      source: 'ghcr',
      detail: `${RUNNER}@${PIN}: unreachable: no ${RUNNER}@${PIN}`,
    });
  });
});

describe('the agent-instance row', () => {
  it('every tag published: up to date, nothing to republish, and the live agents on an older release', async () => {
    const row = await service.readSandbox(null, NOW);
    expect(row).toMatchObject({
      status: 'read',
      release: {
        tag: 'cli-v0.18.0',
        version: '0.18.0',
        commit: NEW_COMMIT,
        committedAt: '2026-11-05T00:00:00Z',
      },
      previous: null,
      liveOlder: 2,
      republishable: false,
      publish: { target: null, blocked: 'up_to_date' },
    });
    if (row.status !== 'read') throw new Error('unreachable');
    expect(row.profiles).toHaveLength(9);
    expect(row.profiles[0]).toEqual({ id: 'base', tag: 'base-0.18.0', published: true });
    expect(gh.peel).toHaveBeenCalledWith(expect.anything(), `tag:${'ab'.repeat(20)}`, 'tok');
    expect(gh.pathExists).not.toHaveBeenCalled();
  });

  it('missing tags on a re-runnable release: the newest older version they fall back to, and the re-run target', async () => {
    registryTags = SANDBOX_IMAGE_IDS.flatMap((id) =>
      id === 'kimi' || id === 'goose'
        ? [`${id}-0.16.0`, `${id}-0.17.2`, `${id}-0.19.0`, `${id}-latest`]
        : [`${id}-0.18.0`],
    );
    const row = await service.readSandbox(null, NOW);
    expect(row).toMatchObject({
      previous: '0.17.2',
      republishable: true,
      publish: {
        blocked: null,
        target: {
          workflow: 'release-sandbox.yml',
          ref: 'cli-v0.18.0',
          inputs: { dry_run: 'false' },
          from: 'cli-v0.18.0: 7 of 9 tags',
          to: 'cli-v0.18.0: 9 of 9 tags',
          target: '0.18.0',
        },
      },
    });
    expect(gh.pathExists).toHaveBeenCalledWith(
      expect.anything(),
      'packages/cli/sandbox/smoke/release-set.mjs',
      'cli-v0.18.0',
      'tok',
    );
  });

  it('missing tags on a release cut before the re-run could push only its gap are not republishable', async () => {
    registryTags = ['base-0.18.0'];
    gh.pathExists.mockResolvedValueOnce(false);
    expect(await service.readSandbox(null, NOW)).toMatchObject({
      previous: null,
      republishable: false,
      publish: { target: null, blocked: 'not_republishable' },
    });
  });

  it('a press that has landed every tag is done', async () => {
    gh.run.mockResolvedValueOnce(workflowRun({ updatedAt: '2026-11-10T11:30:00Z' }));
    expect(await service.readSandbox(record({ target: '0.18.0' }), NOW)).toMatchObject({
      publish: { progress: { state: 'done' } },
    });
  });

  it('a successful re-run that left tags missing is idle, not publishing', async () => {
    registryTags = ['base-0.18.0'];
    expect(await service.readSandbox(record({ target: '0.18.0' }), NOW)).toMatchObject({
      publish: { progress: { state: 'idle' }, blocked: null },
    });
  });

  it('no cli-v release tag is Not read (GitHub); unreadable registry tags are Not read (GHCR)', async () => {
    gh.tagsWithPrefix.mockResolvedValueOnce([{ name: 'cli-vx', commit: 'x' }]);
    expect(await service.readSandbox(null, NOW)).toEqual({
      status: 'not_read',
      source: 'github',
      detail: 'no cli-v* release tag',
    });
    registryTags = null;
    expect(await service.readSandbox(null, NOW)).toEqual({
      status: 'not_read',
      source: 'ghcr',
      detail: "ghcr.io/motir-co/motir-sandbox's tags could not be read",
    });
  });
});

describe('the publish records', () => {
  it('one audited read answers the newest press of each image', async () => {
    const before = await service.publishRecords(currentPrincipal);
    expect(before).toEqual({ hosted: null, runner: null, sandbox: null });
    const reads = await adminDb.platformAuditLog.findMany({
      where: { action: 'fleet.status.read' },
    });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ targetKind: 'platform', targetId: 'fleet_image' });
  });

  it('a row whose metadata lacks a field reads it as empty', async () => {
    await withPlatformWrite(currentPrincipal, async (_tx, write) => {
      await write({
        action: 'fleet.image.publish',
        targetKind: 'platform',
        targetId: 'fleet_image.runner',
        reason: PUBLISH_REASON,
        metadata: { runId: 'not a number' },
      });
    });
    const records = await service.publishRecords(currentPrincipal);
    expect(records.runner).toMatchObject({
      actorEmail: currentPrincipal.email,
      from: '',
      to: '',
      target: '',
      runId: null,
      runUrl: null,
      runNumber: null,
    });
  });
});

describe('Publish latest', () => {
  it('dispatches the row’s target, then records the press with the run it started', async () => {
    const outcome = await service.publish(currentPrincipal, 'hosted');
    expect(outcome).toEqual({
      outcome: 'dispatched',
      runUrl: 'https://github.com/motir-co/motir-core/actions/runs/77',
      runNumber: 13,
    });
    expect(gh.dispatch).toHaveBeenCalledWith(
      { owner: 'motir-co', name: 'motir-core' },
      'hosted-agent-image.yml',
      'main',
      { digest: NEW, source_commit: NEW_COMMIT },
      'tok',
    );
    const rows = await adminDb.platformAuditLog.findMany({
      where: { action: 'fleet.image.publish' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetId: 'fleet_image.hosted',
      targetLabel: 'hosted',
      reason: PUBLISH_REASON,
      metadata: expect.objectContaining({ image: 'hosted', runId: 88, runNumber: 13, target: NEW }),
    });
    const records = await service.publishRecords(currentPrincipal);
    expect(records.hosted).toMatchObject({
      actorEmail: currentPrincipal.email,
      runId: 88,
      target: NEW,
      from: `${PIN} (4a9cb14)`,
    });
  });

  it('the runner and the sandbox dispatch their own workflow and ref', async () => {
    await service.publish(currentPrincipal, 'runner');
    expect(gh.dispatch).toHaveBeenLastCalledWith(
      expect.anything(),
      'release-runner-image.yml',
      'main',
      { pin_digest: NEW, pin_version: '0.2.6' },
      'tok',
    );
    registryTags = ['base-0.18.0'];
    await service.publish(currentPrincipal, 'sandbox');
    expect(gh.dispatch).toHaveBeenLastCalledWith(
      expect.anything(),
      'release-sandbox.yml',
      'cli-v0.18.0',
      { dry_run: 'false' },
      'tok',
    );
  });

  it('refused, recording nothing, when the row is up to date, publishing, unread or unset', async () => {
    images[`${HOSTED}:main`] = { digest: PIN, createdAt: null };
    expect(await service.publish(currentPrincipal, 'hosted')).toEqual({
      outcome: 'refused',
      reason: 'up_to_date',
    });
    images[`${HOSTED}:main`] = { digest: NEW, createdAt: null, commit: NEW_COMMIT };
    gh.activeRuns.mockResolvedValueOnce([workflowRun({ status: 'queued' })]);
    expect(await service.publish(currentPrincipal, 'hosted')).toEqual({
      outcome: 'refused',
      reason: 'running',
    });
    images[`${HOSTED}:main`] = 'fail';
    expect(await service.publish(currentPrincipal, 'hosted')).toEqual({
      outcome: 'refused',
      reason: 'not_read',
    });
    env.runnerPin = null;
    expect(await service.publish(currentPrincipal, 'runner')).toEqual({
      outcome: 'refused',
      reason: 'unset',
    });
    expect(gh.dispatch).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count({ where: { action: 'fleet.image.publish' } })).toBe(
      0,
    );
  });

  it('fails without a GitHub App installation to dispatch with', async () => {
    probe.token.mockResolvedValue(null);
    expect(await service.publish(currentPrincipal, 'hosted')).toEqual({
      outcome: 'failed',
      detail:
        'this deployment has no GitHub App installation on motir-co to start the workflow with',
    });
    expect(gh.dispatch).not.toHaveBeenCalled();
  });

  it('a refused dispatch is failed with GitHub’s words and records nothing', async () => {
    gh.dispatch.mockRejectedValueOnce(
      new PublishWorkflowError(403, 'Resource not accessible by integration'),
    );
    expect(await service.publish(currentPrincipal, 'hosted')).toEqual({
      outcome: 'failed',
      detail: 'GitHub refused the call (HTTP 403: Resource not accessible by integration).',
    });
    expect(await adminDb.platformAuditLog.count({ where: { action: 'fleet.image.publish' } })).toBe(
      0,
    );
  });

  // Review finding on #4140: the dispatch is a remote call of up to tens of
  // seconds, and `withPlatformWrite` closes its transaction after Prisma's 5 s
  // default. A dispatch that outlasts it must still leave its row.
  it('a dispatch slower than the write transaction’s timeout still records the press', async () => {
    const answer = workflowRun({ id: 88, runNumber: 13, status: 'queued', conclusion: null });
    gh.dispatch.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(answer), 5_500)),
    );
    expect(await service.publish(currentPrincipal, 'hosted')).toMatchObject({
      outcome: 'dispatched',
    });
    expect(await adminDb.platformAuditLog.count({ where: { action: 'fleet.image.publish' } })).toBe(
      1,
    );
  }, 20_000);

  it('a press GitHub started is answered as dispatched even when its row cannot be written', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const recordPress = vi
      .spyOn(service, 'recordPress')
      .mockRejectedValueOnce(new Error('the database went away'));
    expect(await service.publish(currentPrincipal, 'hosted')).toMatchObject({
      outcome: 'dispatched',
      runNumber: 13,
    });
    expect(error).toHaveBeenCalledWith('[admin] fleet image publish dispatched but not recorded', {
      image: 'hosted',
      runId: 88,
      error: 'Error',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('went away');
    recordPress.mockRestore();
    error.mockRestore();
  });

  it('an error that is not GitHub’s is not swallowed', async () => {
    gh.dispatch.mockRejectedValueOnce(new TypeError('a bug'));
    await expect(service.publish(currentPrincipal, 'hosted')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('publishEnded', () => {
  it('false while GitHub will not show the run, or it has not completed', async () => {
    gh.run.mockRejectedValueOnce(new PublishWorkflowError(404, ''));
    expect(await service.publishEnded('hosted', 77, NEW)).toBe(false);
    gh.run.mockResolvedValueOnce(workflowRun({ status: 'in_progress' }));
    expect(await service.publishEnded('hosted', 77, NEW)).toBe(false);
    gh.run.mockRejectedValueOnce(new TypeError('a bug'));
    await expect(service.publishEnded('hosted', 77, NEW)).rejects.toBeInstanceOf(TypeError);
  });

  it('true once a run failed, or the sandbox run finished', async () => {
    gh.run.mockResolvedValueOnce(workflowRun({ conclusion: 'failure' }));
    expect(await service.publishEnded('hosted', 77, NEW)).toBe(true);
    expect(await service.publishEnded('sandbox', 77, '0.18.0')).toBe(true);
  });

  it('a successful pin run has ended only once this process pins the target', async () => {
    expect(await service.publishEnded('hosted', 77, NEW)).toBe(false);
    env.hostedPin = `${HOSTED}@${NEW}`;
    expect(await service.publishEnded('hosted', 77, NEW)).toBe(true);
    env.hostedPin = new Error('unset');
    expect(await service.publishEnded('hosted', 77, NEW)).toBe(false);
    expect(await service.publishEnded('runner', 77, NEW)).toBe(false);
    env.runnerPin = `${RUNNER}@${NEW}`;
    expect(await service.publishEnded('runner', 77, NEW)).toBe(true);
    env.runnerPin = null;
    expect(await service.publishEnded('runner', 77, NEW)).toBe(false);
  });
});
