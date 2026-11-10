import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { MigrateOnboardingNotFoundError } from '@/lib/migrateOnboarding/errors';
import { randomToken } from '../helpers/random';
import { organizationIdOf } from '../helpers/organizationOf';

// migrateOnboardingService.getIndexStatus — the Index step's per-repo progress
// (Story 7.15 · MOTIR-934), against a REAL Postgres (the motir-core convention).
// The service module imports the motir-ai-boundary services (aiConvention /
// aiChat / aiGeneration) which import the motir-ai client, so the client is
// mocked for the module to load — getIndexStatus itself never calls motir-ai;
// it reads resolveCodeContext (the GitHub grant mirror) + the job_run ledger.

const mocks = vi.hoisted(() => ({
  submitJob: vi.fn(async (kind: string) => ({ jobId: `job-${kind}` })),
  refreshCodeAudit: vi.fn(async () => ({ auditJobId: 'audit-1', conventionJobId: 'conv-1' })),
  getPreplanState: vi.fn(async () => ({ session: null, docs: [], catalog: null })),
}));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: mocks.submitJob,
  refreshCodeAudit: mocks.refreshCodeAudit,
  getPreplanState: mocks.getPreplanState,
  streamJob: vi.fn(),
  getJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { migrateOnboardingService } = await import('@/lib/services/migrateOnboardingService');

/** Seed ONE GitHub installation for the fixture's workspace. resolveCodeContext
 *  reads a single installation per workspace (`findFirst`), so all repos meant
 *  to be visible together MUST share one installation — call this once, then
 *  {@link seedRepo} for each repo under it. */
async function seedInstallation(fx: WorkItemFixture, account = 'acme') {
  const rand = randomToken(6);
  return adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${rand}`,
      workspaceId: fx.workspaceId,
      accountLogin: account,
      accountType: 'Organization',
    },
  });
}

/** Seed a repo under an existing installation. Returns its `owner/name` ref. The
 *  row carries its OWN `workspace_id` (MOTIR-1931) — here the installation's, since
 *  these fixtures model a workspace's own grant. */
async function seedRepo(
  inst: { id: string; workspaceId: string | null },
  owner: string,
  name: string,
  index: { indexingRunId?: string; indexRefusedAt?: Date } = {},
) {
  const rand = randomToken(6);
  if (!inst.workspaceId) throw new Error('seedRepo needs a workspace-bound installation');
  await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: inst.workspaceId,
      organizationId: await organizationIdOf(inst.workspaceId),
      repoId: `repo-${rand}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      ...(index.indexingRunId ? { indexingRunId: index.indexingRunId } : {}),
      ...(index.indexRefusedAt
        ? {
            indexRefusedAt: index.indexRefusedAt,
            indexRefusedSizeBytes: BigInt(5),
            indexRefusedCapBytes: BigInt(4),
          }
        : {}),
    },
  });
  return `${owner}/${name}`;
}

/** Seed a SUCCEEDED `system.code-graph-index` job_run for a repo. */
async function seedSucceededIndexJob(fx: WorkItemFixture, repoRef: string) {
  await adminDb.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${randomToken()}`,
      lane: 'engine',
      attempt: 0,
      status: 'succeeded',
      finishedAt: new Date(),
      output: { indexed: true, repoRef, projectsIndexed: 1 },
    },
  });
}

/** Seed a RUNNING `system.code-graph-index` job_run (no repoRef on a running
 *  row — the index job writes `output` only on success; this is the aggregate
 *  hasRunning signal). */
async function seedRunningIndexJob(fx: WorkItemFixture): Promise<string> {
  return seedIndexJobIn(fx, 'running');
}

/** Seed an index job_run in a given state, returning its id — what a repo's
 *  `indexingRunId` pointer names. A non-succeeded row carries no repoRef. */
async function seedIndexJobIn(
  fx: WorkItemFixture,
  status: 'running' | 'failed' | 'abandoned',
): Promise<string> {
  const row = await adminDb.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${randomToken()}`,
      lane: 'engine',
      attempt: 0,
      status,
      ...(status === 'running' ? {} : { finishedAt: new Date() }),
      output: {},
    },
  });
  return row.id;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('migrateOnboardingService.getIndexStatus', () => {
  it('returns an empty repo list (not allIndexed) when nothing is connected', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const status = await migrateOnboardingService.getIndexStatus(run.id, fx.ctx);
    expect(status.repos).toEqual([]);
    expect(status.total).toBe(0);
    expect(status.indexedCount).toBe(0);
    expect(status.allIndexed).toBe(false);
    expect(status.hasRunning).toBe(false);
    expect(status.failedCount).toBe(0);
  });

  it('maps each connected repo to indexed/queued and gates on all', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const inst = await seedInstallation(fx);
    const web = await seedRepo(inst, 'acme', 'web');
    const api = await seedRepo(inst, 'acme', 'api');
    await seedSucceededIndexJob(fx, web);

    const status = await migrateOnboardingService.getIndexStatus(run.id, fx.ctx);
    expect(status.total).toBe(2);
    expect(status.indexedCount).toBe(1);
    expect(status.allIndexed).toBe(false);
    expect(status.hasRunning).toBe(false);
    const webRow = status.repos.find((r) => r.repoRef === web);
    const apiRow = status.repos.find((r) => r.repoRef === api);
    expect(webRow?.status).toBe('indexed');
    expect(webRow?.provider).toBe('github');
    expect(apiRow?.status).toBe('queued');
    expect(status.failedCount).toBe(0);
  });

  it('flips allIndexed once every repo has a succeeded index run', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const inst = await seedInstallation(fx);
    const web = await seedRepo(inst, 'acme', 'web');
    const api = await seedRepo(inst, 'acme', 'api');
    await seedSucceededIndexJob(fx, web);
    await seedSucceededIndexJob(fx, api);

    const status = await migrateOnboardingService.getIndexStatus(run.id, fx.ctx);
    expect(status.indexedCount).toBe(2);
    expect(status.allIndexed).toBe(true);
    expect(status.hasRunning).toBe(false);
  });

  it('reports hasRunning when an index job is in flight (aggregate, not per-repo)', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const inst = await seedInstallation(fx);
    await seedRepo(inst, 'acme', 'web');
    await seedRunningIndexJob(fx);

    const status = await migrateOnboardingService.getIndexStatus(run.id, fx.ctx);
    expect(status.total).toBe(1);
    expect(status.allIndexed).toBe(false);
    expect(status.hasRunning).toBe(true);
    // The running row names no repo and this repo's pointer names no run — it is
    // queued, while the aggregate flag still says something is in flight.
    expect(status.repos[0]?.status).toBe('queued');
  });

  it('names all four states per repo from the pointer and the ledger (MOTIR-8768)', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const inst = await seedInstallation(fx);
    const runningId = await seedRunningIndexJob(fx);
    const failedId = await seedIndexJobIn(fx, 'failed');
    const abandonedId = await seedIndexJobIn(fx, 'abandoned');
    const indexed = await seedRepo(inst, 'acme', 'indexed');
    const indexing = await seedRepo(inst, 'acme', 'indexing', { indexingRunId: runningId });
    const failed = await seedRepo(inst, 'acme', 'failed', { indexingRunId: failedId });
    const crashed = await seedRepo(inst, 'acme', 'crashed', { indexingRunId: abandonedId });
    const tooLarge = await seedRepo(inst, 'acme', 'large', { indexRefusedAt: new Date() });
    const queued = await seedRepo(inst, 'acme', 'queued');
    await seedSucceededIndexJob(fx, indexed);

    const status = await migrateOnboardingService.getIndexStatus(run.id, fx.ctx);
    const byRef = new Map(status.repos.map((r) => [r.repoRef, r.status]));
    expect(byRef.get(indexed)).toBe('indexed');
    expect(byRef.get(indexing)).toBe('indexing');
    expect(byRef.get(failed)).toBe('failed');
    // A crashed run leaves its pointer behind; `abandoned` is failed, never indexing.
    expect(byRef.get(crashed)).toBe('failed');
    expect(byRef.get(tooLarge)).toBe('failed');
    expect(byRef.get(queued)).toBe('queued');
    expect(status.total).toBe(6);
    expect(status.indexedCount).toBe(1);
    expect(status.failedCount).toBe(3);
    expect(status.hasRunning).toBe(true);
    expect(status.allIndexed).toBe(false);
  });

  it('⚠️ a repo whose claim names a RUNNING REFRESH reads `indexing` (bug MOTIR-10821)', async () => {
    // A refresh claims the repository with its own job_run id (MOTIR-9454); the
    // running read must count it as it counts a first index. Settled refreshes
    // read exactly what they read before: failed/abandoned `failed`, succeeded
    // (with no first-index ledger row) `queued`.
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const inst = await seedInstallation(fx);
    const refreshIn = async (status: 'running' | 'succeeded' | 'failed' | 'abandoned') =>
      (
        await adminDb.jobRun.create({
          data: {
            workspaceId: fx.workspaceId,
            functionId: 'system.code-graph-refresh',
            eventName: 'system.code-graph-refresh',
            eventId: `evt-${randomToken()}`,
            lane: 'engine',
            attempt: 0,
            status,
            ...(status === 'running' ? {} : { finishedAt: new Date() }),
            output: {},
          },
        })
      ).id;
    const running = await seedRepo(inst, 'acme', 'running', {
      indexingRunId: await refreshIn('running'),
    });
    const succeeded = await seedRepo(inst, 'acme', 'succeeded', {
      indexingRunId: await refreshIn('succeeded'),
    });
    const failed = await seedRepo(inst, 'acme', 'failed', {
      indexingRunId: await refreshIn('failed'),
    });
    const abandoned = await seedRepo(inst, 'acme', 'abandoned', {
      indexingRunId: await refreshIn('abandoned'),
    });

    const status = await migrateOnboardingService.getIndexStatus(run.id, fx.ctx);
    const byRef = new Map(status.repos.map((r) => [r.repoRef, r.status]));
    expect(byRef.get(running)).toBe('indexing');
    expect(byRef.get(succeeded)).toBe('queued');
    expect(byRef.get(failed)).toBe('failed');
    expect(byRef.get(abandoned)).toBe('failed');
  });

  it('throws NotFound for a bogus run id', async () => {
    const fx = await makeWorkItemFixture();
    await expect(migrateOnboardingService.getIndexStatus('nope', fx.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingNotFoundError,
    );
  });
});
