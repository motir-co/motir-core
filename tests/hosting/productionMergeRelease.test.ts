// MOTIR-10031 — a merge starts a release, against real Postgres, the deploy
// port's fake and the job engine's real queue. A completed `production-image`
// run is fed through the webhook's normalizer from a GitHub-shaped fixture; the
// job is driven through its own handler with a step API that executes steps and
// records sleeps. The hosting manifest is read at the commit through the access
// service, stubbed here at that seam (the release service's suite covers it).
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeHostingControls } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { NormalizedProductionImageRun } from '@/lib/git/types';
import { parseHostingManifest } from '@/lib/hosting/manifest';
import { productionArtifactRef, productionImageRepository } from '@/lib/hosting/productionArtifact';
import { productionMergeRelease } from '@/lib/jobs/definitions/productionMergeRelease';
import { jobServices } from '@/lib/jobs/services';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import {
  IN_PROGRESS_GAVE_UP_REASON,
  MERGE_RELEASE_IN_PROGRESS_WAIT_MS,
  MERGE_RELEASE_MAX_ATTEMPTS,
  productionMergeReleaseService as service,
  type MergeReleaseRequestedData,
  type RunMergeReleaseOutcome,
} from '@/lib/services/productionMergeReleaseService';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';

const ORG = 'motir-projects';
const INSTALLATION = '556677';
const JOB = 'hosting/merge-release.requested';
const FIXTURE = 'tests/fixtures/github/workflow-run/production-image.completed.json';
const MANIFEST = parseHostingManifest(
  readFileSync('tests/fixtures/hosting/motir.hosting.json', 'utf8'),
);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SECRETISH = /postgres(ql)?:\/\/|token|secret/i;

let logged: string[];
let providerSeq = 0;

interface MotirRepo {
  projectRepositoryId: string;
  providerRepoId: string;
  appName: string;
}

function hosting() {
  return getHostingDeployPort('fly') as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  resetHostingFakes();
  vi.spyOn(hostedRepositoryAccessService, 'readManifestAt').mockResolvedValue(MANIFEST);
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => JSON.stringify(a) ?? String(a)).join(' '));
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

/** A Motir repository mirrored under Motir's installation, established, on Fly.
 *  `enabled` switches production on the way enablement records it. */
async function motirRepo(
  fx: WorkItemFixture,
  opts: { seedSource?: string; enabled?: boolean; name?: string } = {},
): Promise<MotirRepo> {
  providerSeq += 1;
  const name = opts.name ?? `shop-${providerSeq}`;
  const providerRepoId = String(880000 + providerSeq);
  const installation = await adminDb.githubInstallation.upsert({
    where: { installationId: INSTALLATION },
    update: {},
    create: {
      installationId: INSTALLATION,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      accountLogin: ORG,
      accountType: 'Organization',
    },
  });
  const githubRepo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: providerRepoId,
      owner: ORG,
      name,
      defaultBranch: 'main',
    },
  });
  const row = await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: githubRepo.id,
    name,
    role: 'web',
  });
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: {
      state: 'created',
      seedSource: opts.seedSource ?? 'nextjs-prisma-fly-starter',
      hostingTarget: 'fly',
    },
  });
  const appName = `mh-${row.id}`;
  if (opts.enabled ?? true) {
    const app = await hostedApplicationService.ensureApplication(row.id);
    await adminDb.hostedApplication.update({
      where: { id: app.id },
      data: { productionAppName: appName, productionEnabledAt: new Date() },
    });
  }
  return { projectRepositoryId: row.id, providerRepoId, appName };
}

/** The fixture run, re-pointed at a repository and changed field by field. */
function delivery(
  repo: MotirRepo,
  overrides: Partial<{
    action: string;
    name: string;
    event: string;
    head_branch: string;
    head_sha: string;
    conclusion: string;
    id: number;
    run_attempt: number;
  }> = {},
): Record<string, unknown> {
  const body = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    action: string;
    workflow_run: Record<string, unknown>;
    repository: Record<string, unknown>;
  };
  const { action, ...run } = overrides;
  if (action) body.action = action;
  Object.assign(body.workflow_run, { head_sha: SHA_A }, run);
  body.repository['id'] = Number(repo.providerRepoId);
  return body;
}

function normalize(body: Record<string, unknown>): NormalizedProductionImageRun {
  const run = getGitProvider('github').parseProductionImageRunEvent!(body);
  if (!run) throw new Error('fixture did not normalize');
  return run;
}

async function hear(body: Record<string, unknown>) {
  return service.handleProductionImageRun(normalize(body), INSTALLATION);
}

async function queued(): Promise<MergeReleaseRequestedData[]> {
  const runs = await adminDb.jobQueueRun.findMany({
    where: { jobId: JOB },
    orderBy: { createdAt: 'asc' },
  });
  const events = await adminDb.jobEvent.findMany({
    where: { id: { in: runs.map((r) => r.eventId!) } },
  });
  return runs.map(
    (r) => events.find((e) => e.id === r.eventId)!.data as unknown as MergeReleaseRequestedData,
  );
}

/** Drive the job's own handler: steps execute, sleeps are recorded. */
async function runJob(data: MergeReleaseRequestedData) {
  const slept: number[] = [];
  const ctx = {
    event: { name: JOB, data },
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
    productionMergeRelease.handler as unknown as (
      c: typeof ctx,
      s: typeof jobServices,
    ) => Promise<RunMergeReleaseOutcome>
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
  const app = await adminDb.hostedApplication.findUniqueOrThrow({
    where: { projectRepositoryId },
    select: { currentReleaseId: true, previousReleaseId: true },
  });
  return app;
}

describe('productionArtifactRef', () => {
  it('is the image repository enablement writes, tagged with the commit', () => {
    expect(productionImageRepository('mh-abc')).toBe('registry.fly.io/mh-abc');
    expect(productionArtifactRef('mh-abc', SHA_A)).toBe(`registry.fly.io/mh-abc:${SHA_A}`);
  });
});

describe('a completed production-image run for a push to main', () => {
  it('releases exactly that commit, live, with the image the run pushed', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const deploy = vi.spyOn(productionReleaseService, 'deployProductionRelease');

    expect(await hear(delivery(repo))).toEqual({
      outcome: 'enqueued',
      projectRepositoryIds: [repo.projectRepositoryId],
    });
    const [job] = await queued();
    expect(job).toEqual({
      workspaceId: fx.workspaceId,
      projectRepositoryId: repo.projectRepositoryId,
      headSha: SHA_A,
      commitSubject: 'Show the delivery estimate on the basket',
      pullRequestNumber: 48,
      conclusion: 'success',
      runId: '9182736450',
      runAttempt: 1,
      idempotencyKey: `9182736450:1:${repo.projectRepositoryId}`,
    });

    const { result, slept } = await runJob(job!);

    expect(result).toMatchObject({ outcome: 'released', state: 'live' });
    expect(slept).toEqual([]);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledWith({
      projectRepositoryId: repo.projectRepositoryId,
      commitSha: SHA_A,
      artifactRef: `registry.fly.io/${repo.appName}:${SHA_A}`,
      cause: 'merge',
      commitSubject: 'Show the delivery estimate on the basket',
      pullRequestNumber: 48,
    });
    const [release] = await releasesOf(repo.projectRepositoryId);
    expect(release).toMatchObject({
      commitSha: SHA_A,
      state: 'live',
      cause: 'merge',
      artifactRef: `registry.fly.io/${repo.appName}:${SHA_A}`,
      commitSubject: 'Show the delivery estimate on the basket',
      pullRequestNumber: 48,
      requestedById: null,
    });
    expect((await pointers(repo.projectRepositoryId)).currentReleaseId).toBe(release!.id);
    expect(logged.join('\n')).not.toMatch(SECRETISH);
  });

  it.each(['failure', 'timed_out'])(
    'records a failed build (%s) without deploying or moving a pointer',
    async (conclusion) => {
      const fx = await workspace();
      const repo = await motirRepo(fx);
      const first = await runJob((await hearAndTake(repo, { head_sha: SHA_A })).data);
      expect(first.result.outcome).toBe('released');
      const before = await pointers(repo.projectRepositoryId);
      const deploysBefore = hosting().calls.filter((c) => c.operation === 'deploy').length;

      const { data } = await hearAndTake(repo, { head_sha: SHA_B, conclusion, id: 42 });
      const { result } = await runJob(data);

      expect(result.outcome).toBe('build_failed_recorded');
      const failed = (await releasesOf(repo.projectRepositoryId)).find(
        (r) => r.commitSha === SHA_B,
      );
      expect(failed).toMatchObject({
        state: 'failed',
        failureReason: `build ${conclusion}`,
        commitSubject: 'Show the delivery estimate on the basket',
        pullRequestNumber: 48,
      });
      expect(await pointers(repo.projectRepositoryId)).toEqual(before);
      expect(hosting().calls.filter((c) => c.operation === 'deploy')).toHaveLength(deploysBefore);
    },
  );

  it.each(['cancelled', 'skipped', 'neutral'])(
    'creates no release for a %s run',
    async (conclusion) => {
      const fx = await workspace();
      const repo = await motirRepo(fx);
      const { data } = await hearAndTake(repo, { conclusion });

      expect((await runJob(data)).result).toEqual({ outcome: 'ignored' });
      expect(await releasesOf(repo.projectRepositoryId)).toEqual([]);
    },
  );

  it('releases nothing when production was switched off after the webhook', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const { data } = await hearAndTake(repo);
    await adminDb.hostedApplication.update({
      where: { projectRepositoryId: repo.projectRepositoryId },
      data: { productionEnabledAt: null },
    });

    expect((await runJob(data)).result).toEqual({ outcome: 'ignored' });
    expect(await releasesOf(repo.projectRepositoryId)).toEqual([]);
  });
});

/** Hear one run for `repo` and take the job it enqueued. */
async function hearAndTake(repo: MotirRepo, overrides: Parameters<typeof delivery>[1] = {}) {
  const before = (await queued()).length;
  const heard = await hear(delivery(repo, overrides));
  const jobs = await queued();
  expect(jobs).toHaveLength(before + 1);
  return { heard, data: jobs[jobs.length - 1]! };
}

describe('the runs that produce nothing', () => {
  const silent: Array<[string, (repo: MotirRepo) => Record<string, unknown>, string]> = [
    ['another workflow', (r) => delivery(r, { name: 'CI' }), 'other_workflow'],
    ['a pull-request run', (r) => delivery(r, { event: 'pull_request' }), 'not_a_push'],
    ['another branch', (r) => delivery(r, { head_branch: 'release/x' }), 'not_default_branch'],
  ];

  it.each(silent)('ignores %s, writing nothing', async (_label, body, reason) => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const deploy = vi.spyOn(productionReleaseService, 'deployProductionRelease');
    const failed = vi.spyOn(productionReleaseService, 'recordFailedRelease');

    expect(await hear(body(repo))).toEqual({ outcome: 'ignored', reason });
    expect(await queued()).toEqual([]);
    expect(deploy).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(await releasesOf(repo.projectRepositoryId)).toEqual([]);
  });

  it('ignores an action other than completed (it never normalizes)', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    expect(
      getGitProvider('github').parseProductionImageRunEvent!(
        delivery(repo, { action: 'in_progress' }),
      ),
    ).toBeNull();
  });

  it('ignores a customer repository and writes no application or release', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx, { seedSource: 'organization', enabled: false });

    expect(await hear(delivery(repo))).toEqual({ outcome: 'ignored', reason: 'not_switched_on' });
    expect(await adminDb.hostedApplication.count()).toBe(0);
    expect(await adminDb.hostedRelease.count()).toBe(0);
    expect(await queued()).toEqual([]);
  });

  it('ignores a Motir repository with no application, or one never switched on', async () => {
    const fx = await workspace();
    const absent = await motirRepo(fx, { enabled: false });
    const off = await motirRepo(fx, { enabled: false });
    await hostedApplicationService.ensureApplication(off.projectRepositoryId);

    for (const repo of [absent, off]) {
      expect(await hear(delivery(repo))).toEqual({
        outcome: 'ignored',
        reason: 'not_switched_on',
      });
    }
    expect(await adminDb.hostedApplication.count()).toBe(1);
    expect(await adminDb.hostedRelease.count()).toBe(0);
    expect(await queued()).toEqual([]);
  });

  it('ignores an unknown installation and an unknown repository', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    expect(await service.handleProductionImageRun(normalize(delivery(repo)), '999')).toEqual({
      outcome: 'ignored',
      reason: 'unknown_installation',
    });
    const stranger = normalize({
      ...delivery(repo),
      repository: { id: 1, name: 'x', owner: { login: ORG } },
    });
    expect(await service.handleProductionImageRun(stranger, INSTALLATION)).toEqual({
      outcome: 'ignored',
      reason: 'unknown_repo',
    });
    expect(await queued()).toEqual([]);
  });
});

describe('redelivery and re-runs', () => {
  it('starts one release for a delivery received twice, and a new one for a re-run', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);

    await hear(delivery(repo));
    await hear(delivery(repo));
    expect(await queued()).toHaveLength(1);
    await runJob((await queued())[0]!);

    await hear(delivery(repo, { run_attempt: 2 }));
    const jobs = await queued();
    expect(jobs.map((j) => j.idempotencyKey)).toEqual([
      `9182736450:1:${repo.projectRepositoryId}`,
      `9182736450:2:${repo.projectRepositoryId}`,
    ]);
    expect((await runJob(jobs[1]!)).result.outcome).toBe('released');

    const releases = await releasesOf(repo.projectRepositoryId);
    expect(releases.map((r) => [r.commitSha, r.state])).toEqual([
      [SHA_A, 'replaced'],
      [SHA_A, 'live'],
    ]);
  });
});

describe('another release in flight', () => {
  async function inFlight(repo: MotirRepo) {
    const app = await hostedApplicationService.ensureApplication(repo.projectRepositoryId);
    return hostedApplicationService.createRelease({
      applicationId: app.id,
      commitSha: SHA_B,
      cause: 'merge',
    });
  }

  it('waits and retries without touching the port, then gives up with a failed release', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    await inFlight(repo);
    const { data } = await hearAndTake(repo);
    const deploy = vi.spyOn(productionReleaseService, 'deployProductionRelease');

    const { result, slept } = await runJob(data);

    expect(slept).toEqual(
      Array.from(
        { length: MERGE_RELEASE_MAX_ATTEMPTS - 1 },
        () => MERGE_RELEASE_IN_PROGRESS_WAIT_MS,
      ),
    );
    expect(deploy).toHaveBeenCalledTimes(MERGE_RELEASE_MAX_ATTEMPTS);
    expect(hosting().calls).toEqual([]);
    expect(result.outcome).toBe('gave_up_in_progress');
    const mine = (await releasesOf(repo.projectRepositoryId)).find((r) => r.commitSha === SHA_A);
    expect(mine).toMatchObject({ state: 'failed', failureReason: IN_PROGRESS_GAVE_UP_REASON });
  });

  it('defers a try that is not the last, and releases once the other release ends', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const other = await inFlight(repo);
    const input = {
      projectRepositoryId: repo.projectRepositoryId,
      headSha: SHA_A,
      conclusion: 'success',
    };

    expect(await service.runMergeRelease({ ...input, attempt: 0 })).toEqual({
      outcome: 'deferred_in_progress',
    });
    await hostedApplicationService.transitionRelease(other.id, 'building', 'failed', {
      failureReason: 'build failure',
    });

    expect(await service.runMergeRelease({ ...input, attempt: 1 })).toMatchObject({
      outcome: 'released',
      state: 'live',
    });
  });

  it('a job whose second try finds the way clear releases after one wait', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const other = await inFlight(repo);
    const { data } = await hearAndTake(repo);
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

    const { result, slept } = await runJob(data);

    expect(slept).toEqual([MERGE_RELEASE_IN_PROGRESS_WAIT_MS]);
    expect(result).toMatchObject({ outcome: 'released', state: 'live' });
  });

  it('leaves one non-terminal release at a time for two merges delivered together', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    await hostedApplicationService.ensureApplication(repo.projectRepositoryId);
    const input = (headSha: string) => ({
      projectRepositoryId: repo.projectRepositoryId,
      headSha,
      conclusion: 'success',
      attempt: 0,
    });

    const outcomes = await Promise.all([
      service.runMergeRelease(input(SHA_A)),
      service.runMergeRelease(input(SHA_B)),
    ]);

    const released = outcomes.filter((o) => o.outcome === 'released');
    expect(released.length).toBeGreaterThanOrEqual(1);
    for (const o of outcomes) expect(['released', 'deferred_in_progress']).toContain(o.outcome);
    const states = (await releasesOf(repo.projectRepositoryId)).map((r) => r.state);
    expect(states.filter((s) => s === 'building' || s === 'releasing')).toEqual([]);
    expect(states.filter((s) => s === 'live')).toHaveLength(1);
  });

  it('passes an error that is not an in-flight refusal through', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    vi.spyOn(productionReleaseService, 'deployProductionRelease').mockRejectedValue(
      new Error('boom'),
    );
    await expect(
      service.runMergeRelease({
        projectRepositoryId: repo.projectRepositoryId,
        headSha: SHA_A,
        conclusion: 'success',
        attempt: 0,
      }),
    ).rejects.toThrow('boom');
  });
});

describe('two Motir repositories in one project', () => {
  it("releases only the repository whose run completed, leaving the other's untouched", async () => {
    const fx = await workspace();
    const web = await motirRepo(fx);
    const api = await motirRepo(fx);
    await runJob((await hearAndTake(api, { head_sha: SHA_B, id: 7 })).data);
    const apiBefore = {
      releases: await releasesOf(api.projectRepositoryId),
      pointers: await pointers(api.projectRepositoryId),
    };

    await runJob((await hearAndTake(web)).data);

    expect((await releasesOf(web.projectRepositoryId)).map((r) => r.commitSha)).toEqual([SHA_A]);
    expect(await releasesOf(api.projectRepositoryId)).toEqual(apiBefore.releases);
    expect(await pointers(api.projectRepositoryId)).toEqual(apiBefore.pointers);
  });
});

describe('the webhook', () => {
  it('meters the run as before and also enqueues its release', async () => {
    const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const handled = vi.spyOn(service, 'handleProductionImageRun');

    const metered = vi.spyOn(githubWebhookService, 'handleWorkflowRun');

    const result = await githubWebhookService.handleEvent('workflow_run', delivery(repo));

    expect(result.event).toBe('workflow_run');
    expect(result).toEqual(await metered.mock.results[0]!.value);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(await queued()).toHaveLength(1);
  });

  it('acks a delivery whose release enqueue throws, logging ids only', async () => {
    const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
    const fx = await workspace();
    const repo = await motirRepo(fx);
    vi.spyOn(service, 'handleProductionImageRun').mockRejectedValue(
      new Error('postgresql://u:secret@h/db'),
    );

    await expect(githubWebhookService.handleProductionImageRun(delivery(repo))).resolves.toBe(
      undefined,
    );
    expect(logged.join('\n')).toContain('9182736450');
    expect(logged.join('\n')).not.toMatch(SECRETISH);
  });

  it('does nothing for a delivery that does not normalize or names no installation', async () => {
    const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const handled = vi.spyOn(service, 'handleProductionImageRun');
    const noInstallation = delivery(repo);
    delete noInstallation['installation'];

    await githubWebhookService.handleProductionImageRun(delivery(repo, { action: 'requested' }));
    await githubWebhookService.handleProductionImageRun(noInstallation);

    expect(handled).not.toHaveBeenCalled();
  });
});

describe('layering', () => {
  it('reaches the release service through its two entry points only', () => {
    const source = readFileSync('lib/services/productionMergeReleaseService.ts', 'utf8');
    const calls = [...source.matchAll(/productionReleaseService\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(calls)).toEqual(new Set(['deployProductionRelease', 'recordFailedRelease']));
    expect(source).not.toMatch(/@\/lib\/orchestrator|getHostingDeployPort|resolveEnvironment/);
    expect(source).not.toMatch(/@\/lib\/db['/]/);
    const job = readFileSync('lib/jobs/definitions/productionMergeRelease.ts', 'utf8');
    expect([...job.matchAll(/services\.(\w+)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`)).toEqual([
      'productionMergeRelease.runMergeRelease',
    ]);
  });
});
