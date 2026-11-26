import { generateKeyPairSync } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { fakeOrchestrator, type ContainerHandle, type ContainerStatus } from '@motir/orchestrator';
import { db } from '@/lib/db';
import {
  ciRunnerBootService,
  INITIAL_POLL_STATE,
  type SupervisionSession,
} from '@/lib/services/ciRunnerBootService';
import { ciRunnerProvisioningService } from '@/lib/services/ciRunnerProvisioningService';
import {
  MAX_SPOT_RERUNS,
  SPOT_RERUN_RETRY_GAP_MS,
  SPOT_RERUN_RETRY_WINDOW_MS,
  planSpotRerun,
  requestSpotRerun,
  retryPendingSpotReruns,
} from '@/lib/services/ciSpotRerunService';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { CI_SPOT_SETTING_SCOPE } from '@/lib/repositories/platformCiSpotSettingRepository';
import { ActionsRunsError, actionsRunsClient } from '@/lib/github/actionsRuns';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withSystemContext } from '@/lib/workspaces/context';
import type { NormalizedWorkflowJobEvent } from '@/lib/git/types';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  INSTALLATION_ID,
  MOTIR_ORG,
  PROVIDER_REPO_ID,
  REPO_NAME,
  seedSiblingWorkspaceRepo,
} from '../helpers/siblingWorkspaceRepo';

// A CI RUNNER EC2 RECLAIMED FOR SPOT (MOTIR-11728), against real Postgres: the
// supervisor settles it `spot_interrupted` (intent `completed`), never as a pass
// or a boot failure; the job the runner TOOK is re-run once, a second time with
// the re-run's intent booted on-demand, and never a third time; and a re-run
// GitHub refuses for a reason that may clear is retried on the reconcile pass.
//
// What is real: Postgres, the intake (`recordQueuedJob`, `recordJobProgress`),
// the whole boot service and its settle. What is faked: GitHub — the token and
// JIT endpoints at `fetch`, the re-run at `actionsRunsClient` — and the
// orchestrator (the shipped `fake` adapter, whose `describe` is made to report a
// reclaim).

const RUNNER_GROUP_ID = 5042;
const RUN_ID = '7901';
const JOB_NAME = 'build';
const FAST = { bootDeadlineMs: 60_000, jobTimeoutMs: 600_000, pollIntervalMs: 1 } as const;

let runnerSeq = 9_100;
let jobSeq = 44_900;
let rerunJob: MockInstance<typeof actionsRunsClient.rerunJob>;
let warn: ReturnType<typeof vi.spyOn>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function seedTenant() {
  const fx = await seedSiblingWorkspaceRepo();
  await adminDb.project.update({
    where: { id: fx.linkProjectId },
    data: {
      runnerGroupId: RUNNER_GROUP_ID,
      runnerGroupName: `motir-project-${fx.linkProjectId}`,
      runnerGroupSyncedAt: new Date(),
    },
  });
  return fx;
}

async function spotSetting(enabled: boolean): Promise<void> {
  await adminDb.platformCiSpotSetting.upsert({
    where: { scope: CI_SPOT_SETTING_SCOPE },
    create: {
      scope: CI_SPOT_SETTING_SCOPE,
      enabled,
      instanceTypes: ['m6i.large'],
      lastReason: 'test',
    },
    update: { enabled, instanceTypes: ['m6i.large'] },
  });
}

/** A `workflow_job.queued` delivery of the job, at `runAttempt`, through the intake. */
async function queue(runAttempt: number, name: string | null = JOB_NAME) {
  jobSeq += 1;
  const event: NormalizedWorkflowJobEvent = {
    providerRepoId: PROVIDER_REPO_ID,
    runId: RUN_ID,
    runAttempt,
    jobId: String(jobSeq),
    jobName: name,
    workflowName: 'CI',
    repoOwner: MOTIR_ORG,
    repoName: REPO_NAME,
    requestedLabels: [MOTIR_RUNNER_LABEL],
    queuedAt: new Date(Date.now() - 5_000),
  };
  const outcome = await ciRunnerProvisioningService.recordQueuedJob(event, INSTALLATION_ID);
  if (outcome.outcome !== 'recorded') throw new Error(`queue: ${outcome.outcome}`);
  return { intentId: outcome.intentId, job: event };
}

/** Boot an intent to a running container and hand back its session. */
async function boot(intentId: string): Promise<SupervisionSession> {
  fakeOrchestrator.setBootBehaviour('start');
  const result = await ciRunnerBootService.bootIntent(intentId, FAST);
  if (result.phase !== 'supervising') {
    throw new Error(`boot: ${JSON.stringify(result.outcome)}`);
  }
  return result.session;
}

/** GitHub reports the session's runner IN PROGRESS on `job`. */
async function takes(session: SupervisionSession, job: NormalizedWorkflowJobEvent) {
  await ciRunnerProvisioningService.recordJobProgress({
    action: 'in_progress',
    runId: job.runId,
    runAttempt: job.runAttempt,
    jobId: job.jobId,
    jobName: job.jobName,
    runnerId: session.githubRunnerId,
    repoOwner: job.repoOwner,
    repoName: job.repoName,
    requestedLabels: job.requestedLabels,
    completedAt: null,
    conclusion: null,
  });
}

/** GitHub reports `job` COMPLETED with `conclusion` on the session's runner. */
async function completes(
  session: SupervisionSession,
  job: NormalizedWorkflowJobEvent,
  conclusion: string | null,
) {
  await ciRunnerProvisioningService.recordJobProgress({
    action: 'completed',
    runId: job.runId,
    runAttempt: job.runAttempt,
    jobId: job.jobId,
    jobName: job.jobName,
    runnerId: session.githubRunnerId,
    repoOwner: job.repoOwner,
    repoName: job.repoName,
    requestedLabels: job.requestedLabels,
    completedAt: new Date(),
    conclusion,
  });
}

/** The provider's next `describe` reports the container ended — reclaimed or not. */
function containerEnds(opts: { reclaimed: boolean; started: boolean }) {
  vi.spyOn(fakeOrchestrator, 'describe').mockImplementation(
    async (handle: ContainerHandle): Promise<ContainerStatus> => ({
      handleId: handle.id,
      exists: false,
      state: 'destroyed',
      terminal: true,
      createdAt: handle.createdAt,
      startedAt: opts.started ? new Date(Date.now() - 1_000) : null,
      stoppedAt: null,
      exitCode: null,
      ...(opts.reclaimed ? { reclaimed: true } : {}),
    }),
  );
}

/** One poll to the terminal verdict, then the settle. */
async function superviseToEnd(session: SupervisionSession) {
  const verdict = await ciRunnerBootService.pollOnce(session, INITIAL_POLL_STATE, FAST);
  if (!verdict.done) throw new Error('expected a terminal verdict');
  const outcome = await ciRunnerBootService.settleSupervision(session, verdict, FAST);
  return { verdict, outcome };
}

const read = (id: string) =>
  adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id } });

/** Every warn line, as one string — what a log reader would see. */
function logged(): string {
  return JSON.stringify(warn.mock.calls);
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.platformCiSpotSetting.deleteMany();
  fakeOrchestrator.reset();
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      const href = String(url);
      if (href.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (href.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (href.includes('generate-jitconfig')) {
        runnerSeq += 1;
        return json(201, {
          runner: { id: runnerSeq, name: `motir-runner-${runnerSeq}`, status: 'offline' },
          encoded_jit_config: 'ZW5jb2RlZC1qaXQ=',
        });
      }
      // The re-run (MOTIR-12266) reaches here only where a test restores the
      // real client; GitHub answers an accepted re-run 201.
      if (href.endsWith('/rerun')) return new Response(null, { status: 201 });
      return new Response(null, { status: 204 });
    }),
  );
  rerunJob = vi.spyOn(actionsRunsClient, 'rerunJob').mockResolvedValue(true);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.platformCiSpotSetting.deleteMany();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a reclaimed runner settles spot_interrupted — never a pass or a boot failure', () => {
  it('seen starting, with a taken job: spot_interrupted, completed, and the job is re-run once', async () => {
    await seedTenant();
    const { intentId, job } = await queue(1);
    const session = await boot(intentId);
    await takes(session, job);
    containerEnds({ reclaimed: true, started: true });

    const { verdict, outcome } = await superviseToEnd(session);

    expect(verdict).toMatchObject({ done: true, reason: 'spot_interrupted' });
    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'spot_interrupted' });
    const row = await read(intentId);
    expect(row).toMatchObject({
      status: 'completed',
      teardownReason: 'spot_interrupted',
      takenRunId: RUN_ID,
      takenRunAttempt: 1,
      takenJobId: job.jobId,
      takenJobName: JOB_NAME,
      takenJobSpotInterruptions: 1,
      rerunState: 'requested',
    });
    expect(rerunJob).toHaveBeenCalledTimes(1);
    expect(rerunJob).toHaveBeenCalledWith(
      { owner: MOTIR_ORG, repo: REPO_NAME, target: undefined },
      job.jobId,
      RUN_ID,
    );
  });

  it('never seen starting, with no taken job: spot_interrupted, completed, and no re-run', async () => {
    await seedTenant();
    const { intentId } = await queue(1);
    const session = await boot(intentId);
    containerEnds({ reclaimed: true, started: false });

    const { verdict } = await superviseToEnd(session);

    expect(verdict).toMatchObject({ done: true, reason: 'spot_interrupted' });
    const row = await read(intentId);
    expect(row).toMatchObject({
      status: 'completed',
      teardownReason: 'spot_interrupted',
      takenJobId: null,
      takenJobSpotInterruptions: null,
      rerunState: null,
    });
    expect(rerunJob).not.toHaveBeenCalled();
  });

  it('a terminal status without reclaimed still settles job_completed / provision_failed', async () => {
    await seedTenant();
    const started = await queue(1);
    const neverStarted = await queue(1);
    const s1 = await boot(started.intentId);
    const s2 = await boot(neverStarted.intentId);
    await takes(s1, started.job);

    containerEnds({ reclaimed: false, started: true });
    expect((await superviseToEnd(s1)).verdict).toMatchObject({ reason: 'job_completed' });
    vi.mocked(fakeOrchestrator.describe).mockRestore();
    containerEnds({ reclaimed: false, started: false });
    expect((await superviseToEnd(s2)).verdict).toMatchObject({ reason: 'provision_failed' });

    expect(await read(started.intentId)).toMatchObject({
      status: 'completed',
      teardownReason: 'job_completed',
      rerunState: null,
    });
    expect(await read(neverStarted.intentId)).toMatchObject({
      status: 'failed',
      teardownReason: 'provision_failed',
    });
    expect(rerunJob).not.toHaveBeenCalled();
  });
});

describe('one settle, one re-run', () => {
  it('a replayed settle step requests nothing further', async () => {
    await seedTenant();
    const { intentId, job } = await queue(1);
    const session = await boot(intentId);
    await takes(session, job);
    containerEnds({ reclaimed: true, started: true });

    const verdict = await ciRunnerBootService.pollOnce(session, INITIAL_POLL_STATE, FAST);
    if (!verdict.done) throw new Error('expected a terminal verdict');
    await ciRunnerBootService.settleSupervision(session, verdict, FAST);
    await ciRunnerBootService.settleSupervision(session, verdict, FAST);

    expect(rerunJob).toHaveBeenCalledTimes(1);
    expect((await read(intentId)).rerunState).toBe('requested');
  });

  it('an intent an org stop settled first gets no re-run', async () => {
    await seedTenant();
    const { intentId, job } = await queue(1);
    const session = await boot(intentId);
    await takes(session, job);
    await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.settle(
        intentId,
        {
          status: 'failed',
          teardownReason: 'gate_revoked',
          settledAt: new Date(),
          failureDetail: 'admin_stop',
        },
        tx,
      ),
    );
    containerEnds({ reclaimed: true, started: true });

    await superviseToEnd(session);

    expect(rerunJob).not.toHaveBeenCalled();
    expect(await read(intentId)).toMatchObject({
      teardownReason: 'gate_revoked',
      rerunState: null,
      takenJobSpotInterruptions: null,
    });
  });
});

describe('the count crosses the re-run, then forces on-demand, then stops', () => {
  it('count 1 → re-run; count 2 → re-run booted on-demand; a third reclaim → no re-run, warned', async () => {
    await seedTenant();
    await spotSetting(true);

    // Attempt 1: booted Spot, reclaimed mid-job.
    const first = await queue(1);
    const s1 = await boot(first.intentId);
    expect(fakeOrchestrator.specs.at(-1)?.capacity).toBe('spot');
    await takes(s1, first.job);
    containerEnds({ reclaimed: true, started: true });
    await superviseToEnd(s1);
    vi.mocked(fakeOrchestrator.describe).mockRestore();
    expect(rerunJob).toHaveBeenCalledTimes(1);

    // Attempt 2: the re-run's queued delivery carries count 1 — still Spot.
    const second = await queue(2);
    expect((await read(second.intentId)).spotInterruptionCount).toBe(1);
    const s2 = await boot(second.intentId);
    expect(fakeOrchestrator.specs.at(-1)?.capacity).toBe('spot');
    await takes(s2, second.job);
    containerEnds({ reclaimed: true, started: true });
    await superviseToEnd(s2);
    vi.mocked(fakeOrchestrator.describe).mockRestore();
    expect(await read(second.intentId)).toMatchObject({
      takenJobSpotInterruptions: 2,
      rerunState: 'requested',
    });
    expect(rerunJob).toHaveBeenCalledTimes(2);
    expect(rerunJob).toHaveBeenLastCalledWith(expect.anything(), second.job.jobId, RUN_ID);

    // Attempt 3: count 2 — booted on-demand although the Spot setting is on.
    const third = await queue(3);
    expect((await read(third.intentId)).spotInterruptionCount).toBe(2);
    const s3 = await boot(third.intentId);
    expect(fakeOrchestrator.specs.at(-1)).not.toHaveProperty('capacity');
    expect((await read(third.intentId)).capacity).toBe('on_demand');

    // A third interruption of the same job (a Spot runner took it): recorded, not re-run.
    await takes(s3, third.job);
    containerEnds({ reclaimed: true, started: true });
    await superviseToEnd(s3);

    expect(rerunJob).toHaveBeenCalledTimes(MAX_SPOT_RERUNS);
    expect(await read(third.intentId)).toMatchObject({
      teardownReason: 'spot_interrupted',
      takenJobSpotInterruptions: 3,
      rerunState: 'capped',
    });
    expect(logged()).toContain('a third time');
    expect(logged()).toContain(third.job.jobId);
    expect(logged()).toContain(JOB_NAME);
  });

  it('a later attempt of a job whose re-run was never asked carries nothing', async () => {
    await seedTenant();
    const first = await queue(1);
    const s1 = await boot(first.intentId);
    containerEnds({ reclaimed: true, started: true }); // took no job
    await superviseToEnd(s1);

    const second = await queue(2);
    expect((await read(second.intentId)).spotInterruptionCount).toBe(0);
  });
});

// A CROSS-REPOSITORY TAKE (MOTIR-12266). Fleet runners are org-level, so the
// runner an intent was booted for in repository A may take a queued job of
// repository B. A Spot reclaim then re-runs job B IN B — the re-run's URL, the
// count carried to B's next attempt and the on-demand pin all name B. Here the
// re-run goes through the REAL `actionsRunsClient` to the stubbed `fetch`, so
// the assertion is on the URL GitHub would have been sent.
describe('a runner booted for one repository that took another’s job', () => {
  const B_REPO = 'sibling-api';
  const B_PROVIDER_REPO_ID = '99903';
  const B_RUN_ID = '8802';
  const B_JOB_NAME = 'Coverage (group c)';

  /** Connect repository B beside A — same installation, same org, same project. */
  async function seedRepoB(fx: Awaited<ReturnType<typeof seedTenant>>) {
    const a = await adminDb.githubRepo.findUniqueOrThrow({ where: { id: fx.githubRepoId } });
    const b = await adminDb.githubRepo.create({
      data: {
        installationId: a.installationId,
        workspaceId: a.workspaceId,
        organizationId: a.organizationId,
        repoId: B_PROVIDER_REPO_ID,
        owner: MOTIR_ORG,
        name: B_REPO,
        defaultBranch: 'main',
      },
    });
    const link = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: fx.projectRepoId } });
    await adminDb.projectRepo.create({
      data: {
        workspaceId: link.workspaceId,
        projectId: link.projectId,
        role: 'api',
        name: B_REPO,
        seedSource: link.seedSource,
        position: 'a1',
        githubRepoId: b.id,
      },
    });
  }

  /** A `workflow_job.queued` delivery of B's job, at `runAttempt`. */
  async function queueB(runAttempt: number) {
    jobSeq += 1;
    const event: NormalizedWorkflowJobEvent = {
      providerRepoId: B_PROVIDER_REPO_ID,
      runId: B_RUN_ID,
      runAttempt,
      jobId: String(jobSeq),
      jobName: B_JOB_NAME,
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: B_REPO,
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(Date.now() - 5_000),
    };
    const outcome = await ciRunnerProvisioningService.recordQueuedJob(event, INSTALLATION_ID);
    if (outcome.outcome !== 'recorded') throw new Error(`queueB: ${outcome.outcome}`);
    return { intentId: outcome.intentId, job: event };
  }

  /** Every re-run POST the real client sent, by URL. */
  function rerunUrls(): string[] {
    return vi
      .mocked(fetch)
      .mock.calls.map(([url]) => String(url))
      .filter((href) => href.endsWith('/rerun'));
  }

  /** A's runner takes B's job, and Spot reclaims it mid-job. */
  async function aTakesBAndIsReclaimed(bJob: NormalizedWorkflowJobEvent) {
    const a = await queue(1);
    const session = await boot(a.intentId);
    await takes(session, bJob);
    containerEnds({ reclaimed: true, started: true });
    await superviseToEnd(session);
    vi.mocked(fakeOrchestrator.describe).mockRestore();
    return a;
  }

  it('records the taken job’s repository and re-runs job B in repository B', async () => {
    const fx = await seedTenant();
    await seedRepoB(fx);
    rerunJob.mockRestore();

    const b = await queueB(1);
    const a = await aTakesBAndIsReclaimed(b.job);

    expect(await read(a.intentId)).toMatchObject({
      repoName: REPO_NAME,
      takenRepoOwner: MOTIR_ORG,
      takenRepoName: B_REPO,
      takenRunId: B_RUN_ID,
      takenJobId: b.job.jobId,
      teardownReason: 'spot_interrupted',
      takenJobSpotInterruptions: 1,
      rerunState: 'requested',
    });
    expect(rerunUrls()).toEqual([
      `https://api.github.com/repos/${MOTIR_ORG}/${B_REPO}/actions/jobs/${b.job.jobId}/rerun`,
    ]);
    expect(logged()).toContain(`${MOTIR_ORG}/${B_REPO}`);
  });

  it('carries the count to B’s next attempt and pins B’s second re-run to on-demand', async () => {
    const fx = await seedTenant();
    await seedRepoB(fx);
    await spotSetting(true);

    // Attempt 1 of B's job, taken by A's runner and reclaimed.
    const b1 = await queueB(1);
    await aTakesBAndIsReclaimed(b1.job);
    expect(rerunJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ owner: MOTIR_ORG, repo: B_REPO }),
      b1.job.jobId,
      B_RUN_ID,
    );

    // Attempt 2's queued delivery — from B — carries the count A's row holds.
    const b2 = await queueB(2);
    expect((await read(b2.intentId)).spotInterruptionCount).toBe(1);

    // A runner booted for A takes attempt 2 and is reclaimed too: the second
    // re-run is counted 2 and pinned on B's job.
    const a2 = await aTakesBAndIsReclaimed(b2.job);
    expect(await read(a2.intentId)).toMatchObject({
      takenRepoName: B_REPO,
      takenJobSpotInterruptions: 2,
      rerunState: 'requested',
    });
    expect(rerunJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ owner: MOTIR_ORG, repo: B_REPO }),
      b2.job.jobId,
      B_RUN_ID,
    );
    const pin = await adminDb.ciSpotRerunPin.findFirstOrThrow({
      where: { sourceIntentId: a2.intentId },
    });
    expect(pin).toMatchObject({ repoName: B_REPO, runId: B_RUN_ID, jobName: B_JOB_NAME });

    // Attempt 3 from B boots on-demand, and B's in-progress delivery closes the pin.
    const b3 = await queueB(3);
    expect((await read(b3.intentId)).spotInterruptionCount).toBe(2);
    const s3 = await boot(b3.intentId);
    expect((await read(b3.intentId)).capacity).toBe('on_demand');
    await takes(s3, b3.job);
    expect(
      (await adminDb.ciSpotRerunPin.findUniqueOrThrow({ where: { id: pin.id } })).closedAt,
    ).not.toBeNull();
  });

  it('a row written before the taken repository existed is re-run in its own repository', async () => {
    await seedTenant();
    const a = await queue(1);
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: a.intentId },
      data: {
        takenRunId: RUN_ID,
        takenRunAttempt: 1,
        takenJobId: a.job.jobId,
        takenJobName: JOB_NAME,
      },
    });
    const row = await read(a.intentId);
    expect(row.takenRepoName).toBeNull();
    expect(await requestSpotRerun(row)).toBe('requested');
    expect(rerunJob).toHaveBeenCalledWith(
      expect.objectContaining({ owner: MOTIR_ORG, repo: REPO_NAME }),
      a.job.jobId,
      RUN_ID,
    );
  });
});

describe('a re-run GitHub refuses', () => {
  async function reclaimedWith(
    answer: Awaited<ReturnType<typeof actionsRunsClient.rerunJob>> | Error,
  ) {
    await seedTenant();
    if (answer instanceof Error) rerunJob.mockRejectedValueOnce(answer);
    else rerunJob.mockResolvedValueOnce(answer);
    const { intentId, job } = await queue(1);
    const session = await boot(intentId);
    await takes(session, job);
    containerEnds({ reclaimed: true, started: true });
    await superviseToEnd(session);
    return read(intentId);
  }

  it('a refusal that may clear stays pending; the reconcile pass retries it after the gap and records requested', async () => {
    const row = await reclaimedWith({ refused: true, status: 409, mayClear: true });
    expect(row.rerunState).toBe('pending');
    const settledAt = row.settledAt!;

    const tooSoon = await retryPendingSpotReruns(new Date(settledAt.getTime() + 60_000));
    expect(tooSoon).toEqual({ requested: 0, refused: 0, expired: 0, pending: 0 });
    expect(rerunJob).toHaveBeenCalledTimes(1);

    rerunJob.mockResolvedValueOnce({ refused: true, status: 403, mayClear: true });
    const later = new Date(settledAt.getTime() + SPOT_RERUN_RETRY_GAP_MS + 1_000);
    expect(await retryPendingSpotReruns(later)).toMatchObject({ pending: 1 });
    expect((await read(row.id)).rerunAttemptedAt).toEqual(later);

    const accepted = await retryPendingSpotReruns(
      new Date(later.getTime() + SPOT_RERUN_RETRY_GAP_MS + 1_000),
    );
    expect(accepted).toMatchObject({ requested: 1 });
    expect(rerunJob).toHaveBeenCalledTimes(3);
    expect((await read(row.id)).rerunState).toBe('requested');
  });

  it('gives up as expired 24 hours after the interruption, without asking', async () => {
    const row = await reclaimedWith({ refused: true, status: 409, mayClear: true });

    const outcome = await retryPendingSpotReruns(
      new Date(row.settledAt!.getTime() + SPOT_RERUN_RETRY_WINDOW_MS),
    );

    expect(outcome).toMatchObject({ expired: 1 });
    expect(rerunJob).toHaveBeenCalledTimes(1);
    expect((await read(row.id)).rerunState).toBe('expired');
  });

  it.each([403, 404, 422] as const)(
    'a %s refused for good is recorded refused and never retried',
    async (status) => {
      const row = await reclaimedWith({ refused: true, status, mayClear: false });

      expect(row.rerunState).toBe('refused');
      await retryPendingSpotReruns(new Date(row.settledAt!.getTime() + 3_600_000));
      expect(rerunJob).toHaveBeenCalledTimes(1);
      expect(logged()).toContain(String(status));
    },
  );

  it('a call that fails leaves it pending, throws nowhere, and logs no GitHub body', async () => {
    const MARKER = 'GITHUB-BODY-MARKER';
    const row = await reclaimedWith(new ActionsRunsError(502, MARKER));

    expect(row).toMatchObject({ status: 'completed', rerunState: 'pending' });
    expect(logged()).toContain('502');
    expect(logged()).not.toContain(MARKER);
    expect(JSON.stringify(row)).not.toContain(MARKER);

    rerunJob.mockRejectedValueOnce(new Error(MARKER));
    const retried = await retryPendingSpotReruns(
      new Date(row.settledAt!.getTime() + SPOT_RERUN_RETRY_GAP_MS + 1_000),
    );
    expect(retried).toMatchObject({ pending: 1 });
    expect(logged()).not.toContain(MARKER);
  });

  it('two passes that listed the same re-run cannot both claim it', async () => {
    const row = await reclaimedWith({ refused: true, status: 409, mayClear: true });
    const at = new Date();

    const claims = await withSystemContext(async (tx) => [
      await ciRunnerProvisioningIntentRepository.claimRerunAttempt(
        row.id,
        row.rerunAttemptedAt,
        at,
        tx,
      ),
      await ciRunnerProvisioningIntentRepository.claimRerunAttempt(
        row.id,
        row.rerunAttemptedAt,
        at,
        tx,
      ),
    ]);

    expect(claims).toEqual([true, false]);
  });
});

describe('the retry pass throws nowhere', () => {
  it('a list that fails answers nothing done', async () => {
    vi.spyOn(ciRunnerProvisioningIntentRepository, 'listPendingReruns').mockRejectedValueOnce(
      new Error('db down'),
    );

    expect(await retryPendingSpotReruns(new Date())).toEqual({
      requested: 0,
      refused: 0,
      expired: 0,
      pending: 0,
    });
  });

  it('a listed row with no settle instant is aged from now, and a lost claim asks nothing', async () => {
    const row = { id: 'gone', settledAt: null, rerunAttemptedAt: null } as never;
    vi.spyOn(ciRunnerProvisioningIntentRepository, 'listPendingReruns').mockResolvedValueOnce([
      row,
    ]);

    expect(await retryPendingSpotReruns(new Date())).toMatchObject({ expired: 0, pending: 0 });
    expect(rerunJob).not.toHaveBeenCalled();
  });

  it('a claim that fails, or is lost, skips the re-run without asking', async () => {
    await seedTenant();
    rerunJob.mockResolvedValueOnce({ refused: true, status: 409, mayClear: true });
    const { intentId, job } = await queue(1);
    const session = await boot(intentId);
    await takes(session, job);
    containerEnds({ reclaimed: true, started: true });
    await superviseToEnd(session);
    const later = new Date(Date.now() + SPOT_RERUN_RETRY_GAP_MS * 2);

    const claim = vi.spyOn(ciRunnerProvisioningIntentRepository, 'claimRerunAttempt');
    claim.mockRejectedValueOnce('db down');
    expect(await retryPendingSpotReruns(later)).toMatchObject({ requested: 0, pending: 0 });
    claim.mockResolvedValueOnce(false);
    expect(await retryPendingSpotReruns(later)).toMatchObject({ requested: 0, pending: 0 });

    expect(rerunJob).toHaveBeenCalledTimes(1);
  });

  it('an outcome that cannot be recorded is logged; an expiry another pass already wrote is not counted', async () => {
    await seedTenant();
    rerunJob.mockResolvedValueOnce({ refused: true, status: 409, mayClear: true });
    const { intentId, job } = await queue(1);
    const session = await boot(intentId);
    await takes(session, job);
    containerEnds({ reclaimed: true, started: true });
    await superviseToEnd(session);
    const row = await read(intentId);
    const record = vi.spyOn(ciRunnerProvisioningIntentRepository, 'recordRerunOutcome');

    record.mockResolvedValueOnce(false);
    expect(
      await retryPendingSpotReruns(new Date(row.settledAt!.getTime() + SPOT_RERUN_RETRY_WINDOW_MS)),
    ).toMatchObject({ expired: 0 });

    record.mockRejectedValueOnce(new Error('db down'));
    expect(
      await retryPendingSpotReruns(
        new Date(row.settledAt!.getTime() + SPOT_RERUN_RETRY_GAP_MS * 2),
      ),
    ).toMatchObject({ requested: 1 });
    expect((await read(intentId)).rerunState).toBe('pending');
  });
});

describe('what the plan reads', () => {
  it.each(['success', 'skipped'])(
    'a taken job GitHub already reported %s is not re-run',
    async (conclusion) => {
      await seedTenant();
      const { intentId, job } = await queue(1);
      const session = await boot(intentId);
      await takes(session, job);
      await completes(session, job, conclusion);
      containerEnds({ reclaimed: true, started: true });

      await superviseToEnd(session);

      expect(rerunJob).not.toHaveBeenCalled();
      expect(await read(intentId)).toMatchObject({
        teardownReason: 'spot_interrupted',
        rerunState: null,
      });
      expect(logged()).toContain('already passed');
    },
  );

  // The usual order of a reclaim: the runner gets its shutdown signal, GitHub
  // fails the job and its `completed` delivery lands BEFORE the supervisor's
  // next poll sees the instance gone. The job is still re-run, once.
  it.each(['failure', 'cancelled', null])(
    'a taken job GitHub reported completed as %s before the settle is still re-run once',
    async (conclusion) => {
      await seedTenant();
      const { intentId, job } = await queue(1);
      const session = await boot(intentId);
      await takes(session, job);
      await completes(session, job, conclusion);
      containerEnds({ reclaimed: true, started: true });

      await superviseToEnd(session);

      expect(rerunJob).toHaveBeenCalledTimes(1);
      expect(rerunJob.mock.calls[0]![1]).toBe(job.jobId);
      expect(await read(intentId)).toMatchObject({
        teardownReason: 'spot_interrupted',
        takenJobSpotInterruptions: 1,
        rerunState: 'requested',
      });
    },
  );

  it('a job with no name is re-run with count 1, and its missing name is logged', async () => {
    await seedTenant();
    const { intentId, job } = await queue(1, null);
    const session = await boot(intentId);
    await takes(session, job);

    const plan = await withSystemContext((tx) => planSpotRerun(intentId, new Date(), tx));

    expect(plan).toMatchObject({ takenJobSpotInterruptions: 1, rerunState: 'pending' });
    expect(logged()).toContain('no name');
  });

  it('an unknown intent plans nothing', async () => {
    expect(
      await withSystemContext((tx) => planSpotRerun('missing', new Date(), tx)),
    ).toBeUndefined();
  });
});

describe('the re-run asks through the runner’s installation', () => {
  it('a job of another org is re-run through the installation its delivery arrived on', async () => {
    const answer = await requestSpotRerun({
      id: 'not-stored',
      repoOwner: 'acme',
      repoName: 'web',
      installationId: '313',
      takenRepoOwner: null,
      takenRepoName: null,
      takenRunId: '1',
      takenRunAttempt: 1,
      takenJobId: '2',
      takenJobName: 'test',
      takenJobSpotInterruptions: 1,
    });

    expect(answer).toBe('requested');
    expect(rerunJob).toHaveBeenCalledWith(
      {
        owner: 'acme',
        repo: 'web',
        target: { org: 'acme', installationId: '313', role: 'provisioning' },
      },
      '2',
      '1',
    );
  });

  it('an intent with no taken job asks nothing', async () => {
    const answer = await requestSpotRerun({
      id: 'x',
      repoOwner: 'acme',
      repoName: 'web',
      installationId: '313',
      takenRepoOwner: null,
      takenRepoName: null,
      takenRunId: null,
      takenRunAttempt: null,
      takenJobId: null,
      takenJobName: null,
      takenJobSpotInterruptions: null,
    });

    expect(answer).toBe('refused');
    expect(rerunJob).not.toHaveBeenCalled();
  });
});
