// MOTIR-10032 — a production config change redeploys the live release, against
// real Postgres, the deploy port's and database port's fakes, and the job
// engine's real queue (which is where the debounce coalesces a burst). Values
// are saved through `environmentConfigService`, which emits the event; the job is
// driven through its own handler with a step API that executes steps and
// records sleeps. The hosting manifest is stubbed at the access-service seam.
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostingTarget } from '@/generated/prisma/client';
import { OrchestratorApiError, type FakeHostingControls } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { HostingManifest } from '@/lib/hosting/manifest';
import { productionConfigRedeploy } from '@/lib/jobs/definitions/productionConfigRedeploy';
import { jobServices } from '@/lib/jobs/services';
import type { EnvironmentConfigChangedData } from '@/lib/jobs/types';
import { resetDatabaseFakes } from '@/lib/orchestrator/database';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { environmentConfigService } from '@/lib/services/environmentConfigService';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import {
  CONFIG_REDEPLOY_MAX_ATTEMPTS,
  CONFIG_REDEPLOY_SETTLE_MS,
  productionConfigRedeployService as service,
  type RunProductionRedeployOutcome,
} from '@/lib/services/productionConfigRedeployService';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

const JOB = 'hosting/production-config-redeploy';
const KEY = 'ef'.repeat(32);
const SHA = 'c'.repeat(40);
const SECRETISH = /postgres(ql)?:\/\/|shh-|leaked/;
const MANIFEST: HostingManifest = {
  schemaVersion: 1,
  targets: ['fly'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'postgres', migrateCommand: 'node migrate.js deploy' },
};

let logged: string[];

function hosting() {
  return getHostingDeployPort('fly') as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('ENVIRONMENT_CONFIG_ENCRYPTION_KEY', KEY);
  resetHostingFakes();
  resetDatabaseFakes();
  vi.spyOn(hostedRepositoryAccessService, 'readManifestAt').mockResolvedValue(MANIFEST);
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function workspace(identifier = 'ACME'): Promise<WorkItemFixture> {
  return makeWorkItemFixture({ name: identifier, identifier });
}

async function repo(
  fx: WorkItemFixture,
  opts: { role?: 'web' | 'api'; seedSource?: string; target?: HostingTarget } = {},
): Promise<string> {
  const role = opts.role ?? 'web';
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role, name: `repo-${role}` },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: {
      seedSource: opts.seedSource ?? 'initialised',
      state: 'created',
      hostingTarget: opts.target ?? 'fly',
    },
  });
  return row.id;
}

/** Put a commit live the way a merge does. */
async function goLive(projectRepositoryId: string, sha = SHA) {
  const release = await productionReleaseService.deployProductionRelease({
    projectRepositoryId,
    commitSha: sha,
    artifactRef: `registry.fly.io/mh-${projectRepositoryId}:${sha}`,
    cause: 'merge',
  });
  expect(release.state).toBe('live');
  return release;
}

async function save(
  fx: WorkItemFixture,
  projectRepositoryId: string,
  name: string,
  value: string,
  environment: 'production' | 'preview' | 'release' = 'production',
  isSecret = false,
) {
  await environmentConfigService.set(
    projectRepositoryId,
    environment,
    { name, value, isSecret },
    fx.ctx,
  );
}

async function queued(): Promise<EnvironmentConfigChangedData[]> {
  const runs = await adminDb.jobQueueRun.findMany({
    where: { jobId: JOB },
    orderBy: { createdAt: 'asc' },
  });
  const events = await adminDb.jobEvent.findMany({
    where: { id: { in: runs.map((r) => r.eventId!) } },
  });
  return runs.map(
    (r) => events.find((e) => e.id === r.eventId)!.data as unknown as EnvironmentConfigChangedData,
  );
}

/** Drive the job's own handler: steps execute, sleeps are recorded. */
async function runJob(data: EnvironmentConfigChangedData) {
  const slept: number[] = [];
  const ctx = {
    event: { name: 'environment.config.changed', data },
    attempt: 0,
    runId: 'run_test',
    step: {
      run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
      sleep: async (_id: string, ms: number | string) => {
        slept.push(Number(ms));
      },
    },
  };
  const result = await (
    productionConfigRedeploy.handler as unknown as (
      c: typeof ctx,
      s: typeof jobServices,
    ) => Promise<RunProductionRedeployOutcome | { outcome: 'ignored_environment' }>
  )(ctx, jobServices);
  return { result, slept };
}

async function releasesOf(projectRepositoryId: string) {
  return adminDb.hostedRelease.findMany({
    where: { application: { projectRepositoryId } },
    orderBy: { createdAt: 'asc' },
  });
}

async function pointers(projectRepositoryId: string) {
  return adminDb.hostedApplication.findUniqueOrThrow({
    where: { projectRepositoryId },
    select: { currentReleaseId: true, previousReleaseId: true },
  });
}

describe('a production config change', () => {
  it('redeploys the live commit and image with the newly resolved environment', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await save(fx, id, 'FEATURE_X', 'off');
    const first = await goLive(id);
    await save(fx, id, 'FEATURE_X', 'on');
    await save(fx, id, 'API_SECRET', 'shh-1', 'production', true);

    const [event] = await queued();
    const { result, slept } = await runJob(event!);

    expect(result.outcome).toBe('redeployed');
    expect(slept).toEqual([]);
    const [old, redeploy] = await releasesOf(id);
    expect(old).toMatchObject({ id: first.id, state: 'replaced' });
    expect(redeploy).toMatchObject({
      commitSha: SHA,
      artifactRef: first.artifactRef,
      cause: 'config_change',
      state: 'live',
    });
    expect(await pointers(id)).toEqual({
      currentReleaseId: redeploy!.id,
      previousReleaseId: first.id,
    });
    const env = hosting().app(`mh-${id}`)!.live!.env;
    expect(env['FEATURE_X']).toBe('on');
    expect(env['API_SECRET']).toBe('shh-1');
    expect(env['DATABASE_URL']).toMatch(/-pooler\.fake\.invalid/);
    expect(logged.join('\n')).not.toMatch(SECRETISH);
  });

  it('coalesces a burst of five saves into one run and one release carrying the last value', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await goLive(id);
    for (let i = 1; i <= 5; i++) await save(fx, id, 'GREETING', `hello-${i}`);

    const runs = await queued();
    expect(runs).toHaveLength(1);
    const { result } = await runJob(runs[0]!);

    expect(result.outcome).toBe('redeployed');
    const releases = await releasesOf(id);
    expect(releases.filter((r) => r.cause === 'config_change')).toHaveLength(1);
    expect(hosting().app(`mh-${id}`)!.live!.env['GREETING']).toBe('hello-5');
  });

  it('starts nothing for a preview or release change', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await goLive(id);
    await save(fx, id, 'GREETING', 'preview', 'preview');
    await save(fx, id, 'GREETING', 'release', 'release');
    const deploy = vi.spyOn(productionReleaseService, 'deployProductionRelease');

    const runs = await queued();
    expect(runs.map((r) => r.environment).sort()).toEqual(['preview', 'release']);
    for (const run of runs) {
      expect((await runJob(run)).result).toEqual({ outcome: 'ignored_environment' });
    }
    expect(deploy).not.toHaveBeenCalled();
    expect(await releasesOf(id)).toHaveLength(1);
  });

  it('keeps a production burst separate from a preview save that lands inside it', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await save(fx, id, 'GREETING', 'a');
    await save(fx, id, 'GREETING', 'b', 'preview');

    expect((await queued()).map((r) => r.environment).sort()).toEqual(['preview', 'production']);
  });
});

describe('skips', () => {
  it('ends with no release for a repository with nothing live', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await save(fx, id, 'GREETING', 'hi');

    expect((await runJob((await queued())[0]!)).result).toEqual({
      outcome: 'skipped_no_live_release',
    });
    expect(await adminDb.hostedRelease.count()).toBe(0);

    await hostedApplicationService.ensureApplication(id);
    expect(await service.runProductionRedeploy({ projectRepositoryId: id, attempt: 0 })).toEqual({
      outcome: 'skipped_no_live_release',
    });
    expect(await adminDb.hostedRelease.count()).toBe(0);
  });

  it('ends with no release for a customer repository', async () => {
    const fx = await workspace();
    const id = await repo(fx, { seedSource: 'organization' });

    expect(await service.runProductionRedeploy({ projectRepositoryId: id, attempt: 0 })).toEqual({
      outcome: 'skipped_customer_repository',
    });
    expect(await adminDb.hostedRelease.count()).toBe(0);
  });

  it('ends with no release for an unknown repository', async () => {
    expect(
      await service.runProductionRedeploy({ projectRepositoryId: 'nope', attempt: 0 }),
    ).toEqual({ outcome: 'skipped_no_live_release' });
  });
});

describe('another release in flight', () => {
  it('waits without touching the port, then gives up creating no row', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const live = await goLive(id);
    await hostedApplicationService.createRelease({
      applicationId: live.applicationId,
      commitSha: 'd'.repeat(40),
      cause: 'merge',
    });
    await save(fx, id, 'GREETING', 'hi');
    const before = (await releasesOf(id)).length;
    const callsBefore = hosting().calls.length;

    const { result, slept } = await runJob((await queued())[0]!);

    expect(result).toEqual({ outcome: 'gave_up_in_progress' });
    expect(slept).toEqual(
      Array.from({ length: CONFIG_REDEPLOY_MAX_ATTEMPTS - 1 }, () => CONFIG_REDEPLOY_SETTLE_MS),
    );
    expect(hosting().calls).toHaveLength(callsBefore);
    expect(await releasesOf(id)).toHaveLength(before);
  });

  it('redeploys on a later try once the other release ends', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const live = await goLive(id);
    const other = await hostedApplicationService.createRelease({
      applicationId: live.applicationId,
      commitSha: 'd'.repeat(40),
      cause: 'merge',
    });
    await save(fx, id, 'GREETING', 'hi');
    const real = productionReleaseService.deployProductionRelease;
    let calls = 0;
    vi.spyOn(productionReleaseService, 'deployProductionRelease').mockImplementation(
      async (input, deps) => {
        calls += 1;
        if (calls === 2) {
          await hostedApplicationService.transitionRelease(other.id, 'building', 'failed', {
            failureReason: 'build failure',
          });
        }
        return real(input, deps);
      },
    );

    const { result, slept } = await runJob((await queued())[0]!);

    expect(slept).toEqual([CONFIG_REDEPLOY_SETTLE_MS]);
    expect(result.outcome).toBe('redeployed');
  });

  it('passes an error that is not an in-flight refusal through', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await goLive(id);
    vi.spyOn(productionReleaseService, 'deployProductionRelease').mockRejectedValue(
      new Error('boom'),
    );
    await expect(
      service.runProductionRedeploy({ projectRepositoryId: id, attempt: 0 }),
    ).rejects.toThrow('boom');
  });
});

describe('a redeploy that fails', () => {
  it('is a failed release, the previous release still current, and is not retried', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const live = await goLive(id);
    await save(fx, id, 'GREETING', 'hi');
    hosting().failNext('deploy', 'upstream said postgresql://leaked@x/y');
    const deploy = vi.spyOn(productionReleaseService, 'deployProductionRelease');

    const { result, slept } = await runJob((await queued())[0]!);

    expect(result.outcome).toBe('failed_release');
    expect(slept).toEqual([]);
    expect(deploy).toHaveBeenCalledTimes(1);
    const failed = (await releasesOf(id)).find((r) => r.cause === 'config_change')!;
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).not.toMatch(SECRETISH);
    expect((await pointers(id)).currentReleaseId).toBe(live.id);
    expect(logged.join('\n')).not.toMatch(SECRETISH);
  });

  it('keeps a provider error message out of the failure reason', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await goLive(id);
    vi.spyOn(hosting(), 'deploy').mockRejectedValueOnce(
      new OrchestratorApiError('fly', 502, 'postgresql://leaked@x/y'),
    );

    const outcome = await service.runProductionRedeploy({ projectRepositoryId: id, attempt: 0 });

    expect(outcome.outcome).toBe('failed_release');
    const failed = (await releasesOf(id)).find((r) => r.cause === 'config_change')!;
    expect(failed.failureReason).toMatch(/^deploy: /);
    expect(failed.failureReason).not.toMatch(SECRETISH);
  });
});

describe('two Motir repositories in one project', () => {
  it('redeploys only the repository whose configuration changed', async () => {
    const fx = await workspace();
    const web = await repo(fx);
    const api = await repo(fx, { role: 'api' });
    await goLive(web);
    await goLive(api);
    const apiBefore = { releases: await releasesOf(api), pointers: await pointers(api) };
    await save(fx, web, 'GREETING', 'hi');

    const runs = await queued();
    expect(runs.map((r) => r.projectRepositoryId)).toEqual([web]);
    expect((await runJob(runs[0]!)).result.outcome).toBe('redeployed');

    expect(await releasesOf(api)).toEqual(apiBefore.releases);
    expect(await pointers(api)).toEqual(apiBefore.pointers);
  });
});

describe('layering', () => {
  it('starts a release only through deployProductionRelease, and the job calls one service', () => {
    const source = readFileSync('lib/services/productionConfigRedeployService.ts', 'utf8');
    expect([...source.matchAll(/productionReleaseService\.(\w+)/g)].map((m) => m[1])).toEqual([
      'deployProductionRelease',
    ]);
    expect(source).not.toMatch(/@\/lib\/db['/]|@\/lib\/orchestrator|resolveEnvironment\(/);
    const job = readFileSync('lib/jobs/definitions/productionConfigRedeploy.ts', 'utf8');
    expect(new Set([...job.matchAll(/services\.(\w+)\.\w+/g)].map((m) => m[1]))).toEqual(
      new Set(['productionConfigRedeploy']),
    );
  });
});
