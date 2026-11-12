import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { EcrImageRead, EcrImagesReader } from '@/lib/awsServices/ecrImagesReader';
import type { FleetPublishRecordDTO, IndexerImageReadDTO } from '@/lib/dto/fleetStatusImages';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import type { PlatformRole } from '@/generated/prisma/client';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE FLEET STATUS PAGE'S INDEXER ROW (MOTIR-10986; design MOTIR-10987) against
// a real Postgres, so the `fleet.image.publish` audit row is real. ECR is faked
// at the reader the service takes (`lib/awsServices/ecrImagesReader.ts`), motir-ai
// and motir-core's GitHub at the publish-workflow client, and the pin at its
// environment variable, so every part of the row — the pin, the newest release,
// the history — and every arm of a press is pinned on its own.

const ecr = vi.hoisted(() => ({ listImages: vi.fn() }));
vi.mock('@/lib/awsServices/ecrImagesReader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/awsServices/ecrImagesReader')>()),
  createEcrImagesReader: () => ({ listImages: ecr.listImages }),
}));

const probe = vi.hoisted(() => ({ token: vi.fn() }));
vi.mock('@/lib/services/runnerImageFreshnessProbeService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/runnerImageFreshnessProbeService')>()),
  sourceRepoToken: probe.token,
}));

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
  INDEXER_INPUTS,
  PUBLISH_WORKFLOWS,
} = await import('@/lib/services/fleetStatusImagesService');
const { publishWorkflowsClient, PublishWorkflowError } =
  await import('@/lib/github/publishWorkflows');

const NOW = new Date('2026-11-12T12:00:00Z');
const REPO = '944842271421.dkr.ecr.us-east-1.amazonaws.com/motir/indexer';
const D050 = `sha256:${'2f'.repeat(32)}`;
const D051 = `sha256:${'e0'.repeat(32)}`;
const D049 = `sha256:${'49'.repeat(32)}`;
const C050 = '6593d89d76a7da34b76588c1b54ba3007bea4186';
const C051 = 'b984f606eca59691f1771ff32c163f2b48ce4132';
const MOTIR_AI = { owner: 'motir-co', name: 'motir-ai' };
const MOTIR_CORE = { owner: 'motir-co', name: 'motir-core' };
const ENV = process.env.MOTIR_INDEXER_IMAGE;

let ecrImages: EcrImageRead[];

function ecrListing(): EcrImageRead[] {
  return [
    { digest: D049, tags: ['indexer-0.4.9'], pushedAt: '2026-10-20T00:00:00.000Z' },
    { digest: D050, tags: ['indexer-0.5.0', 'latest'], pushedAt: '2026-10-30T10:00:00.000Z' },
    { digest: D051, tags: ['indexer-0.5.1'], pushedAt: '2026-11-11T10:00:00.000Z' },
    { digest: `sha256:${'00'.repeat(32)}`, tags: [], pushedAt: null },
  ];
}

const workflowRun = (over: Record<string, unknown> = {}) => ({
  id: 77,
  runNumber: 41,
  htmlUrl: 'https://github.com/motir-co/motir-core/actions/runs/77',
  status: 'completed',
  conclusion: 'success',
  createdAt: '2026-11-12T11:00:00Z',
  updatedAt: '2026-11-12T11:05:00Z',
  ...over,
});

const record = (over: Partial<FleetPublishRecordDTO> = {}): FleetPublishRecordDTO => ({
  actorEmail: 'ops@example.test',
  at: '2026-11-12T11:00:00.000Z',
  from: `indexer-v0.5.0 (${D050})`,
  to: `indexer-v0.5.1 (${D051})`,
  target: D051,
  runId: 77,
  runUrl: 'https://github.com/motir-co/motir-core/actions/runs/77',
  runNumber: 41,
  ...over,
});

const change = (sha: string, date: string, paths: string[]) => ({
  sha,
  committedAt: date,
  subject: `change ${sha}`,
  paths,
});

function makeSpies() {
  return {
    activeRuns: vi.spyOn(publishWorkflowsClient, 'activeRuns').mockResolvedValue([]),
    run: vi.spyOn(publishWorkflowsClient, 'run').mockResolvedValue(workflowRun()),
    failureDetail: vi
      .spyOn(publishWorkflowsClient, 'failureDetail')
      .mockResolvedValue('the merge queue dropped the pin pull request'),
    tagsWithPrefix: vi.spyOn(publishWorkflowsClient, 'tagsWithPrefix').mockResolvedValue([
      { name: 'indexer-v0.5.0', commit: `tag:${'d9'.repeat(20)}` },
      { name: 'indexer-v0.5.1', commit: C051 },
    ]),
    peel: vi
      .spyOn(publishWorkflowsClient, 'peel')
      .mockImplementation(async (_repo, commit) => (commit.startsWith('tag:') ? C050 : commit)),
    pathCommitsBetween: vi
      .spyOn(publishWorkflowsClient, 'pathCommitsBetween')
      .mockImplementation(async (_repo, base) =>
        base === C050
          ? [
              change('4ef049f', '2026-11-10T00:00:00Z', ['src/indexer']),
              change('bf7117b', '2026-11-09T00:00:00Z', ['infra/indexer']),
            ]
          : [],
      ),
    mergedFromBranchAt: vi
      .spyOn(publishWorkflowsClient, 'mergedFromBranchAt')
      .mockResolvedValue(null),
    dispatch: vi
      .spyOn(publishWorkflowsClient, 'dispatch')
      .mockResolvedValue(
        workflowRun({ id: 88, runNumber: 42, status: 'queued', conclusion: null }),
      ),
  };
}

let gh: ReturnType<typeof makeSpies>;
const reader: EcrImagesReader = { listImages: (repo) => ecr.listImages(repo) };

async function principal(role: PlatformRole): Promise<PlatformPrincipal> {
  const user = await createTestUser();
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role };
}

async function read(rec: FleetPublishRecordDTO | null = null): Promise<IndexerImageReadDTO> {
  const row = await service.readIndexer(rec, NOW, reader);
  if (row.status !== 'read') throw new Error(`row is ${row.status}`);
  return row;
}

beforeEach(async () => {
  await truncateAuthTables();
  currentPrincipal = await principal('superadmin');
  process.env.MOTIR_INDEXER_IMAGE = `${REPO}@${D050}`;
  ecrImages = ecrListing();
  ecr.listImages.mockReset();
  ecr.listImages.mockImplementation(async () => ecrImages);
  probe.token.mockResolvedValue('tok');
  gh = makeSpies();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ENV === undefined) delete process.env.MOTIR_INDEXER_IMAGE;
  else process.env.MOTIR_INDEXER_IMAGE = ENV;
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('who may read the indexer row', () => {
  it.each(['support', 'operator'] as const)('a %s is refused', async (role) => {
    currentPrincipal = await principal(role);
    await expect(service.readIndexer(null, NOW, reader)).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    await expect(service.publish(currentPrincipal, 'indexer')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
  });
});

describe('the indexer row', () => {
  it('reads ECR in the registry the pin names', async () => {
    await read();
    expect(ecr.listImages).toHaveBeenCalledWith(
      expect.objectContaining({
        registryId: '944842271421',
        region: 'us-east-1',
        repositoryName: 'motir/indexer',
      }),
    );
    expect(PUBLISH_WORKFLOWS.indexer).toBe('indexer-image-pin.yml');
    expect(INDEXER_INPUTS).toEqual([
      'src/indexer',
      'infra/indexer',
      'package.json',
      'pnpm-lock.yaml',
    ]);
  });

  it('behind: the pinned and newest releases, their motir-ai commits, the gap and the pin target', async () => {
    gh.pathCommitsBetween.mockImplementation(async (_repo, base) =>
      base === C050 ? [change('4ef049f', '2026-11-10T00:00:00Z', ['src/indexer'])] : [],
    );
    const row = await read();
    expect(row.pinned).toEqual({
      state: 'read',
      value: {
        digest: D050,
        commit: C050,
        createdAt: '2026-10-30T10:00:00.000Z',
        version: '0.5.0',
      },
    });
    expect(row.newest).toEqual({
      state: 'read',
      value: {
        digest: D051,
        commit: C051,
        createdAt: '2026-11-11T10:00:00.000Z',
        version: '0.5.1',
      },
    });
    expect(row).toMatchObject({
      behind: true,
      releasesBetween: ['indexer-v0.5.1'],
      daysBehind: 12,
      indexerCommits: 1,
      compareUrl: 'https://github.com/motir-co/motir-ai/compare/indexer-v0.5.0...indexer-v0.5.1',
      history: { state: 'read' },
      unreleased: [],
      nextTag: 'indexer-v0.5.2',
    });
    expect(row.publish.target).toEqual({
      workflow: 'indexer-image-pin.yml',
      ref: 'main',
      inputs: { pin_reference: `${REPO}@${D051}`, pin_version: '0.5.1' },
      from: `indexer-v0.5.0 (${D050})`,
      to: `indexer-v0.5.1 (${D051})`,
      target: D051,
    });
    expect(row.publish.blocked).toBeNull();
    expect(gh.pathCommitsBetween).toHaveBeenCalledWith(MOTIR_AI, C050, C051, INDEXER_INPUTS, 'tok');
    expect(gh.pathCommitsBetween).toHaveBeenCalledWith(
      MOTIR_AI,
      C051,
      'main',
      INDEXER_INPUTS,
      'tok',
    );
    expect(gh.tagsWithPrefix).toHaveBeenCalledWith(MOTIR_AI, 'indexer-v', 'tok');
    expect(gh.activeRuns).toHaveBeenCalledWith(MOTIR_CORE, 'indexer-image-pin.yml', 'tok');
  });

  it('up to date: the same bytes, nothing to publish, and Publish latest held', async () => {
    process.env.MOTIR_INDEXER_IMAGE = `${REPO}@${D051}`;
    const row = await read();
    expect(row).toMatchObject({
      behind: false,
      releasesBetween: [],
      daysBehind: null,
      indexerCommits: null,
      compareUrl: null,
      unreleased: [],
    });
    expect(row.publish).toMatchObject({ target: null, blocked: 'up_to_date' });
    expect(gh.pathCommitsBetween).toHaveBeenCalledTimes(1);
  });

  it('release needed: merged changes after the newest release, no target', async () => {
    process.env.MOTIR_INDEXER_IMAGE = `${REPO}@${D051}`;
    gh.pathCommitsBetween.mockResolvedValue([
      change('aaa1111', '2026-11-12T00:00:00Z', ['src/indexer', 'package.json']),
    ]);
    const row = await read();
    expect(row.unreleased).toEqual([
      {
        commit: 'aaa1111',
        committedAt: '2026-11-12T00:00:00Z',
        subject: 'change aaa1111',
        paths: ['src/indexer', 'package.json'],
        relation: 'ahead',
      },
    ]);
    expect(row.publish).toMatchObject({ target: null, blocked: 'release_needed' });
  });

  it('behind and with unreleased changes: still a publish, and the changes still need a release', async () => {
    gh.pathCommitsBetween.mockResolvedValue([
      change('aaa1111', '2026-11-12T00:00:00Z', ['src/indexer']),
    ]);
    const row = await read();
    expect(row.behind).toBe(true);
    expect(row.unreleased).toHaveLength(1);
    expect(row.publish.blocked).toBeNull();
  });

  it('pinned bytes no release tag names: no version, no commit, the releases between unknown', async () => {
    process.env.MOTIR_INDEXER_IMAGE = `${REPO}@sha256:${'00'.repeat(32)}`;
    const row = await read();
    expect(row.pinned).toMatchObject({
      state: 'read',
      value: { version: null, commit: null, createdAt: null },
    });
    expect(row).toMatchObject({
      behind: true,
      releasesBetween: null,
      daysBehind: null,
      compareUrl: null,
    });
    expect(row.publish.target?.from).toBe(`sha256:${'00'.repeat(32)}`);
    // A pin no ECR image holds reads the same: shown by digest, never a release.
    process.env.MOTIR_INDEXER_IMAGE = `${REPO}@sha256:${'11'.repeat(32)}`;
    expect((await read()).pinned).toMatchObject({ state: 'read', value: { version: null } });
  });

  it('a release with no motir-ai git tag has no commit, so no compare by commit and no history read', async () => {
    gh.tagsWithPrefix.mockResolvedValue([]);
    const row = await read();
    expect(row.pinned).toMatchObject({ value: { commit: null } });
    expect(row.newest).toMatchObject({ state: 'read', value: { commit: null } });
    expect(row).toMatchObject({
      compareUrl: 'https://github.com/motir-co/motir-ai/compare/indexer-v0.5.0...indexer-v0.5.1',
      indexerCommits: null,
    });
    expect(gh.pathCommitsBetween).not.toHaveBeenCalled();
  });

  it('a pinned digest with no release and commits on neither side has no compare at all', async () => {
    process.env.MOTIR_INDEXER_IMAGE = `${REPO}@sha256:${'00'.repeat(32)}`;
    gh.tagsWithPrefix.mockResolvedValue([]);
    expect((await read()).compareUrl).toBeNull();
    gh.tagsWithPrefix.mockResolvedValue([{ name: 'indexer-v0.5.1', commit: C051 }]);
    // The pin has no commit, so the compare cannot be by commit either.
    expect((await read()).compareUrl).toBeNull();
  });

  it('ECR not answering: the pin and the newest release are Not read (AWS), and Publish latest is off', async () => {
    ecr.listImages.mockRejectedValue(new Error('AccessDeniedException'));
    const row = await read();
    expect(row.pinned).toEqual({
      state: 'not_read',
      source: 'aws',
      detail: `${REPO}: AccessDeniedException`,
    });
    expect(row.newest).toMatchObject({ state: 'not_read', source: 'aws' });
    expect(row).toMatchObject({ behind: false, nextTag: null, unreleased: [] });
    expect(row.publish).toMatchObject({ target: null, blocked: 'not_read' });
    ecr.listImages.mockRejectedValue('a string');
    expect((await read()).pinned).toMatchObject({ detail: `${REPO}: a string` });
  });

  it('a pin that is not an ECR reference is Not read without asking ECR', async () => {
    process.env.MOTIR_INDEXER_IMAGE = `registry.fly.io/motir-indexer@${D050}`;
    const row = await read();
    expect(row.pinned).toEqual({
      state: 'not_read',
      source: 'aws',
      detail: `registry.fly.io/motir-indexer@${D050} is not an ECR reference by digest`,
    });
    expect(ecr.listImages).not.toHaveBeenCalled();
  });

  it('an ECR repository with no release tag leaves the newest release Not read (AWS)', async () => {
    ecrImages = [{ digest: D050, tags: ['latest'], pushedAt: null }];
    const row = await read();
    expect(row.pinned).toMatchObject({ state: 'read', value: { version: null } });
    expect(row.newest).toEqual({
      state: 'not_read',
      source: 'aws',
      detail: `${REPO} holds no indexer-* release tag`,
    });
  });

  it('motir-ai’s tags not answering leave the newest release Not read (GitHub); the pin still reads', async () => {
    gh.tagsWithPrefix.mockRejectedValue(new PublishWorkflowError(502, 'Bad gateway'));
    const row = await read();
    expect(row.pinned).toMatchObject({ state: 'read', value: { version: '0.5.0', commit: null } });
    expect(row.newest).toMatchObject({ state: 'not_read', source: 'github' });
    expect(row.publish.blocked).toBe('not_read');
  });

  it('a tag peel GitHub refuses leaves the newest release Not read (GitHub)', async () => {
    gh.peel.mockRejectedValue(new PublishWorkflowError(404, 'Not Found'));
    const row = await read();
    expect(row.newest).toMatchObject({ state: 'not_read', source: 'github' });
    gh.peel.mockRejectedValue(new TypeError('a bug'));
    await expect(read()).rejects.toBeInstanceOf(TypeError);
  });

  it('an error that is no read’s failure is not swallowed', async () => {
    gh.tagsWithPrefix.mockRejectedValue(new TypeError('a bug'));
    await expect(read()).rejects.toBeInstanceOf(TypeError);
    gh.tagsWithPrefix.mockResolvedValue([]);
    gh.pathCommitsBetween.mockRejectedValue(new TypeError('a bug'));
    gh.tagsWithPrefix.mockResolvedValue([{ name: 'indexer-v0.5.1', commit: C051 }]);
    await expect(read()).rejects.toBeInstanceOf(TypeError);
  });

  it('the history not answering leaves only its part Not read; the compare and its target stand', async () => {
    gh.pathCommitsBetween.mockRejectedValue(new PublishWorkflowError(503, 'unavailable'));
    const row = await read();
    expect(row.history).toMatchObject({ state: 'not_read', source: 'github' });
    expect(row).toMatchObject({ behind: true, indexerCommits: null, unreleased: [] });
    expect(row.publish.target?.target).toBe(D051);
  });

  it('the active-run read failing is the whole row Not read (GitHub)', async () => {
    gh.activeRuns.mockRejectedValue(new PublishWorkflowError(500, 'boom'));
    expect(await service.readIndexer(null, NOW, reader)).toMatchObject({
      status: 'not_read',
      source: 'github',
    });
  });

  it('no pin is unset: this install does not index', async () => {
    process.env.MOTIR_INDEXER_IMAGE = '  ';
    expect(await service.readIndexer(null, NOW, reader)).toEqual({
      status: 'unset',
      variable: 'MOTIR_INDEXER_IMAGE',
    });
    delete process.env.MOTIR_INDEXER_IMAGE;
    expect(await service.readIndexer(null, NOW, reader)).toMatchObject({ status: 'unset' });
  });
});

describe('the indexer press’s two stages', () => {
  it('a run still going is the first stage: the pin pull request queued', async () => {
    gh.run.mockResolvedValue(workflowRun({ status: 'in_progress', conclusion: null }));
    expect((await read(record())).publish.progress).toEqual({
      state: 'running',
      startedAt: record().at,
      stage: 'queued',
    });
  });

  it('a successful run is queued until its pull request merges after the press, then rolling', async () => {
    expect((await read(record())).publish.progress).toMatchObject({ stage: 'queued' });
    gh.mergedFromBranchAt.mockResolvedValue('2026-11-10T00:00:00Z');
    expect((await read(record())).publish.progress).toMatchObject({ stage: 'queued' });
    gh.mergedFromBranchAt.mockResolvedValue('2026-11-12T11:20:00Z');
    const row = await read(record());
    expect(row.publish.progress).toMatchObject({ state: 'running', stage: 'rolling' });
    expect(row.publish.blocked).toBe('running');
    expect(gh.mergedFromBranchAt).toHaveBeenCalledWith(
      MOTIR_CORE,
      'chore/indexer-image-pin',
      'tok',
    );
  });

  it('a merge read GitHub refuses leaves the band on its first stage; another error is not swallowed', async () => {
    gh.mergedFromBranchAt.mockRejectedValue(new PublishWorkflowError(500, 'boom'));
    expect((await read(record())).publish.progress).toMatchObject({ stage: 'queued' });
    gh.mergedFromBranchAt.mockRejectedValue(new TypeError('a bug'));
    await expect(read(record())).rejects.toBeInstanceOf(TypeError);
  });

  it('published once the pin reaches the target; failed with the run’s words', async () => {
    process.env.MOTIR_INDEXER_IMAGE = `${REPO}@${D051}`;
    expect((await read(record())).publish.progress).toEqual({
      state: 'done',
      endedAt: '2026-11-12T11:05:00Z',
    });
    process.env.MOTIR_INDEXER_IMAGE = `${REPO}@${D050}`;
    gh.run.mockResolvedValue(workflowRun({ conclusion: 'failure' }));
    expect((await read(record())).publish.progress).toEqual({
      state: 'failed',
      endedAt: '2026-11-12T11:05:00Z',
      error: 'the merge queue dropped the pin pull request',
    });
  });
});

describe('Publish latest on the indexer', () => {
  it('dispatches the pin workflow with the newest release’s reference, and records one press', async () => {
    expect(await service.publish(currentPrincipal, 'indexer')).toEqual({
      outcome: 'dispatched',
      runUrl: 'https://github.com/motir-co/motir-core/actions/runs/77',
      runNumber: 42,
    });
    expect(gh.dispatch).toHaveBeenCalledWith(
      MOTIR_CORE,
      'indexer-image-pin.yml',
      'main',
      { pin_reference: `${REPO}@${D051}`, pin_version: '0.5.1' },
      'tok',
    );
    const rows = await adminDb.platformAuditLog.findMany({
      where: { action: 'fleet.image.publish' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetId: 'fleet_image.indexer',
      targetLabel: 'indexer',
      metadata: expect.objectContaining({ image: 'indexer', runId: 88, target: D051 }),
    });
    expect((await service.publishRecords(currentPrincipal)).indexer).toMatchObject({
      runId: 88,
      to: `indexer-v0.5.1 (${D051})`,
    });
  });

  it('refused, recording nothing, when up to date, already running, not read or unset', async () => {
    process.env.MOTIR_INDEXER_IMAGE = `${REPO}@${D051}`;
    expect(await service.publish(currentPrincipal, 'indexer')).toEqual({
      outcome: 'refused',
      reason: 'up_to_date',
    });
    process.env.MOTIR_INDEXER_IMAGE = `${REPO}@${D050}`;
    gh.activeRuns.mockResolvedValueOnce([workflowRun({ status: 'queued' })]);
    expect(await service.publish(currentPrincipal, 'indexer')).toEqual({
      outcome: 'refused',
      reason: 'running',
    });
    ecr.listImages.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await service.publish(currentPrincipal, 'indexer')).toEqual({
      outcome: 'refused',
      reason: 'not_read',
    });
    delete process.env.MOTIR_INDEXER_IMAGE;
    expect(await service.publish(currentPrincipal, 'indexer')).toEqual({
      outcome: 'refused',
      reason: 'unset',
    });
    expect(gh.dispatch).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count({ where: { action: 'fleet.image.publish' } })).toBe(
      0,
    );
  });
});

describe('publishEnded on the indexer', () => {
  it('a successful pin run has ended only once this process pins the target', async () => {
    expect(await service.publishEnded('indexer', 77, D051)).toBe(false);
    process.env.MOTIR_INDEXER_IMAGE = `${REPO}@${D051}`;
    expect(await service.publishEnded('indexer', 77, D051)).toBe(true);
    delete process.env.MOTIR_INDEXER_IMAGE;
    expect(await service.publishEnded('indexer', 77, D051)).toBe(false);
  });
});
