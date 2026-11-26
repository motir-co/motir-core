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
import { ciRunnerReconcileService, coverPartitions } from '@/lib/services/ciRunnerReconcileService';
import {
  SPOT_RERUN_RETRY_GAP_MS,
  SPOT_RERUN_RETRY_WINDOW_MS,
  requestSpotRerun,
  retryPendingSpotReruns,
} from '@/lib/services/ciSpotRerunService';
import {
  CI_SPOT_RERUN_PIN_MAX_AGE_MS,
  ciSpotRerunPinService,
  isPinnedJob,
} from '@/lib/services/ciSpotRerunPinService';
import { ciSpotSettingReader } from '@/lib/services/ciSpotSettingReader';
import { projectRunnerGroupService } from '@/lib/services/projectRunnerGroupService';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { ciSpotRerunPinRepository } from '@/lib/repositories/ciSpotRerunPinRepository';
import { CI_SPOT_SETTING_SCOPE } from '@/lib/repositories/platformCiSpotSettingRepository';
import { actionsRunsClient } from '@/lib/github/actionsRuns';
import { fleetQueueClient, type QueuedFleetJob } from '@/lib/github/fleetQueue';
import {
  MOTIR_ARM64_RUNNER_LABEL,
  MOTIR_ON_DEMAND_RUNNER_LABEL,
  MOTIR_RUNNER_LABEL,
} from '@/lib/ciFleet/config';
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

// THE ON-DEMAND PIN OF A JOB'S SECOND SPOT RE-RUN (MOTIR-11732), against real
// Postgres. A job Spot interrupted twice is re-run once more, and only an
// on-demand runner may take that re-run: the org's pin hold is written, every
// jobless Spot runner registered there is withdrawn, and only then is the re-run
// requested. While the hold is open every boot in the org is on-demand, and the
// reconcile counts the pinned job as on-demand demand. It closes on pickup, on a
// refused or expired re-run, and at 24 hours.
//
// What is real: Postgres, the intake (`recordQueuedJob`, `recordJobProgress`),
// the boot service, its supervision and settle, the re-run service and the
// reconcile. What is faked: GitHub — the token, JIT and runner endpoints at
// `fetch`, the re-run at `actionsRunsClient`, and the reconcile's queue and
// runner reads at `fleetQueueClient` — and the orchestrator (the shipped `fake`
// adapter, whose `describe` is made to report a reclaim).

const RUNNER_GROUP_ID = 5042;
const RUN_ID = '7901';
const JOB_NAME = 'build';
const OTHER_ORG = 'acme-other';
const FAST = { bootDeadlineMs: 60_000, jobTimeoutMs: 600_000, pollIntervalMs: 1 } as const;

let runnerSeq = 19_100;
let jobSeq = 64_900;
let rerunJob: MockInstance<typeof actionsRunsClient.rerunJob>;
let warn: ReturnType<typeof vi.spyOn>;
/** What happened, in order: the hold, each runner DELETE, the re-run. */
let order: string[];
/** The DELETE answer per runner id; anything unlisted is 204. */
let deleteStatus: Map<number, number>;

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

/** A `workflow_job.queued` delivery through the intake. */
async function queue(
  runAttempt: number,
  opts: { name?: string | null; runId?: string; labels?: string[] } = {},
) {
  jobSeq += 1;
  const event: NormalizedWorkflowJobEvent = {
    providerRepoId: PROVIDER_REPO_ID,
    runId: opts.runId ?? RUN_ID,
    runAttempt,
    jobId: String(jobSeq),
    jobName: opts.name === undefined ? JOB_NAME : opts.name,
    workflowName: 'CI',
    repoOwner: MOTIR_ORG,
    repoName: REPO_NAME,
    requestedLabels: opts.labels ?? [MOTIR_RUNNER_LABEL],
    queuedAt: new Date(Date.now() - 5_000),
  };
  const outcome = await ciRunnerProvisioningService.recordQueuedJob(event, INSTALLATION_ID);
  if (outcome.outcome !== 'recorded') throw new Error(`queue: ${outcome.outcome}`);
  return { intentId: outcome.intentId, job: event };
}

/** Boot an intent to a supervised container. */
async function boot(
  intentId: string,
  behaviour: 'start' | 'never_start' = 'start',
): Promise<SupervisionSession> {
  fakeOrchestrator.setBootBehaviour(behaviour);
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

/** The provider's `describe` reports every container reclaimed. */
function reclaimed() {
  return vi.spyOn(fakeOrchestrator, 'describe').mockImplementation(
    async (handle: ContainerHandle): Promise<ContainerStatus> => ({
      handleId: handle.id,
      exists: false,
      state: 'destroyed',
      terminal: true,
      createdAt: handle.createdAt,
      startedAt: new Date(Date.now() - 1_000),
      stoppedAt: null,
      exitCode: null,
      reclaimed: true,
    }),
  );
}

/** One poll to a terminal verdict, then the settle. */
async function superviseToEnd(session: SupervisionSession) {
  const verdict = await ciRunnerBootService.pollOnce(session, INITIAL_POLL_STATE, FAST);
  if (!verdict.done) throw new Error('expected a terminal verdict');
  const outcome = await ciRunnerBootService.settleSupervision(session, verdict, FAST);
  return { verdict, outcome };
}

/** The session's runner is reclaimed by Spot while working its taken job. Its
 *  own de-registration at teardown is left out of {@link order}: only the
 *  sweep's removals are what the pin is about. */
async function interrupted(session: SupervisionSession) {
  const spy = reclaimed();
  await superviseToEnd(session);
  spy.mockRestore();
  order = order.filter((o) => o !== `removeRunner:${session.githubRunnerId}`);
}

const read = (id: string) =>
  adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id } });

const lastCapacity = () => fakeOrchestrator.specs.at(-1)?.capacity ?? 'on_demand';

/**
 * Attempt 1 of the job is interrupted (re-run once, count 1), and attempt 2 is
 * booted Spot and has taken the job — the runner whose reclaim leads to the
 * SECOND, pinned re-run. Answers attempt 2's session and row.
 */
async function secondAttemptRunning() {
  const first = await queue(1);
  const s1 = await boot(first.intentId);
  await takes(s1, first.job);
  await interrupted(s1);
  const second = await queue(2);
  const s2 = await boot(second.intentId);
  expect(lastCapacity()).toBe('spot');
  await takes(s2, second.job);
  return { session: s2, intentId: second.intentId, job: second.job };
}

/** An idle registered Spot runner of the same org: another job's runner, booted
 *  and running, which has taken nothing. */
async function idleSpotRunner() {
  const other = await queue(1, { name: 'lint', runId: '8800' });
  const session = await boot(other.intentId);
  expect(lastCapacity()).toBe('spot');
  return { session, intentId: other.intentId };
}

/** An open hold for `sourceIntentId`, written straight through the repository. */
async function openHold(
  sourceIntentId: string,
  opts: { repoOwner?: string; runAttempt?: number; openedAt?: Date } = {},
) {
  return withSystemContext((tx) =>
    ciSpotRerunPinRepository.open(
      {
        sourceIntentId,
        repoOwner: opts.repoOwner ?? MOTIR_ORG,
        repoName: REPO_NAME,
        runId: RUN_ID,
        runAttempt: opts.runAttempt ?? 2,
        jobName: JOB_NAME,
      },
      opts.openedAt ?? new Date(),
      tx,
    ),
  );
}

/** The interrupted attempt's intent, settled: it stands for no runner. */
async function settledSource() {
  const source = await queue(2);
  await adminDb.ciRunnerProvisioningIntent.update({
    where: { id: source.intentId },
    data: { status: 'completed', teardownReason: 'spot_interrupted', settledAt: new Date() },
  });
  return source;
}

const pinsOf = () => adminDb.ciSpotRerunPin.findMany({ orderBy: { openedAt: 'asc' } });

const deletes = () => order.filter((o) => o.startsWith('removeRunner:'));

function logged(): string {
  return JSON.stringify(warn.mock.calls);
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.platformCiSpotSetting.deleteMany();
  fakeOrchestrator.reset();
  order = [];
  deleteStatus = new Map();
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
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
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
      const runner = href.match(/\/actions\/runners\/(\d+)$/);
      if (runner && init?.method === 'DELETE') {
        const id = Number(runner[1]);
        order.push(`removeRunner:${id}`);
        const status = deleteStatus.get(id) ?? 204;
        return status === 204
          ? new Response(null, { status })
          : json(status, { message: 'Runner is still running a job' });
      }
      if (runner) return json(200, { id: Number(runner[1]), busy: false, status: 'online' });
      return new Response(null, { status: 204 });
    }),
  );
  // The shipped fake reports no capacity; report what the launch asked for, as
  // the EC2 adapter does when Spot is granted, so `capacity` is recorded.
  const provision = fakeOrchestrator.provision.bind(fakeOrchestrator);
  vi.spyOn(fakeOrchestrator, 'provision').mockImplementation(async (spec) => ({
    ...(await provision(spec)),
    capacity: spec.capacity === 'spot' ? 'spot' : 'on_demand',
  }));
  rerunJob = vi.spyOn(actionsRunsClient, 'rerunJob').mockImplementation(async () => {
    order.push('rerun');
    return true;
  });
  const open = ciSpotRerunPinRepository.open.bind(ciSpotRerunPinRepository);
  vi.spyOn(ciSpotRerunPinRepository, 'open').mockImplementation(async (...args) => {
    const pin = await open(...args);
    order.push('hold');
    return pin;
  });
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

describe('the second re-run: hold, then withdraw every jobless Spot runner, then re-run', () => {
  it('an idle registered Spot runner is withdrawn before the re-run, and settles as an idle runner', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    const idle = await idleSpotRunner();
    order = [];

    await interrupted(second.session);

    expect(order).toEqual(['hold', `removeRunner:${idle.session.githubRunnerId}`, 'rerun']);
    expect(await read(second.intentId)).toMatchObject({
      takenJobSpotInterruptions: 2,
      rerunState: 'requested',
    });
    const [pin] = await pinsOf();
    expect(pin).toMatchObject({
      sourceIntentId: second.intentId,
      targetOrg: MOTIR_ORG,
      runId: RUN_ID,
      runAttempt: 2,
      jobName: JOB_NAME,
      closedAt: null,
    });
    expect((await read(idle.intentId)).runnerWithdrawnAt).not.toBeNull();

    // Its supervision retires it at the next poll, as an idle runner, without
    // asking GitHub again.
    order = [];
    const { verdict } = await superviseToEnd(idle.session);
    expect(verdict).toMatchObject({ done: true, reason: 'runner_idle', runnerRemoved: true });
    expect(await read(idle.intentId)).toMatchObject({
      status: 'completed',
      teardownReason: 'runner_idle',
    });
    expect(deletes()).toEqual([]);
  });

  it('a minted runner whose machine is still starting is withdrawn the same way', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    // A machine still booting: created, never started.
    const starting = await queue(1, { name: 'lint', runId: '8801' });
    const startingSession = await boot(starting.intentId, 'never_start');
    // …and a runner minted and recorded with its launch not made yet.
    const launching = await queue(1, { name: 'test', runId: '8802' });
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: launching.intentId },
      data: { status: 'provisioning', githubRunnerId: 77_001, runnerName: 'motir-runner-77001' },
    });
    order = [];

    await interrupted(second.session);

    expect(order).toEqual([
      'hold',
      `removeRunner:${startingSession.githubRunnerId}`,
      'removeRunner:77001',
      'rerun',
    ]);
    expect((await read(starting.intentId)).runnerWithdrawnAt).not.toBeNull();
    expect((await read(launching.intentId)).runnerWithdrawnAt).not.toBeNull();

    const { verdict } = await superviseToEnd(startingSession);
    expect(verdict).toMatchObject({ done: true, reason: 'runner_idle' });
  });

  it('a removal refused because the runner went busy leaves it alone, and the re-run is still requested', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    const busy = await idleSpotRunner();
    deleteStatus.set(busy.session.githubRunnerId!, 422);
    order = [];

    await interrupted(second.session);

    expect(order).toEqual(['hold', `removeRunner:${busy.session.githubRunnerId}`, 'rerun']);
    expect((await read(busy.intentId)).runnerWithdrawnAt).toBeNull();
    expect((await read(second.intentId)).rerunState).toBe('requested');
  });

  it('a removal that failed otherwise holds the re-run back; the retry sweeps again and asks', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    const stuck = await idleSpotRunner();
    deleteStatus.set(stuck.session.githubRunnerId!, 500);
    order = [];

    await interrupted(second.session);

    expect(order).toEqual(['hold', `removeRunner:${stuck.session.githubRunnerId}`]);
    expect(rerunJob).not.toHaveBeenCalledWith(expect.anything(), second.job.jobId, RUN_ID);
    const row = await read(second.intentId);
    expect(row.rerunState).toBe('pending');
    expect((await pinsOf())[0]?.closedAt).toBeNull();
    expect(logged()).toContain('could not withdraw a Spot runner');

    deleteStatus.delete(stuck.session.githubRunnerId!);
    order = [];
    const retried = await retryPendingSpotReruns(
      new Date(row.settledAt!.getTime() + SPOT_RERUN_RETRY_GAP_MS + 1_000),
    );
    expect(retried).toMatchObject({ requested: 1 });
    // The retry finds the hold already open and does not write a second one.
    expect(order).toEqual(['hold', `removeRunner:${stuck.session.githubRunnerId}`, 'rerun']);
    expect(await pinsOf()).toHaveLength(1);
  });

  it('a runner GitHub no longer knows is not marked withdrawn, and does not hold the re-run back', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    const gone = await idleSpotRunner();
    deleteStatus.set(gone.session.githubRunnerId!, 404);

    await interrupted(second.session);

    expect((await read(gone.intentId)).runnerWithdrawnAt).toBeNull();
    expect((await read(second.intentId)).rerunState).toBe('requested');
  });

  it('a hold that cannot be written holds the re-run back', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    vi.mocked(ciSpotRerunPinRepository.open).mockRejectedValueOnce(new Error('db down'));
    order = [];

    await interrupted(second.session);

    expect(order).toEqual([]);
    expect((await read(second.intentId)).rerunState).toBe('pending');
    expect(logged()).not.toContain('pinned a second re-run');
  });

  it('a withdrawal that cannot be recorded still lets the re-run go: the runner is gone at GitHub', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    const idle = await idleSpotRunner();
    vi.spyOn(ciRunnerProvisioningIntentRepository, 'markRunnerWithdrawn').mockRejectedValueOnce(
      new Error('db down'),
    );

    await interrupted(second.session);

    expect(deletes()).toEqual([`removeRunner:${idle.session.githubRunnerId}`]);
    expect((await read(second.intentId)).rerunState).toBe('requested');
  });

  it('a Spot setting that cannot be read pins anyway', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    const idle = await idleSpotRunner();
    const realRead = ciSpotSettingReader.read.bind(ciSpotSettingReader);
    // The first read is the pin's own; the settle reads nothing else.
    vi.spyOn(ciSpotSettingReader, 'read')
      .mockRejectedValueOnce(new Error('setting unreadable'))
      .mockImplementation(realRead);

    await interrupted(second.session);

    expect(deletes()).toEqual([`removeRunner:${idle.session.githubRunnerId}`]);
    expect(await pinsOf()).toHaveLength(1);
  });

  it('a runner already on-demand, or one that has taken a job, is never withdrawn', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    const deploy = await queue(1, {
      name: 'deploy',
      runId: '8803',
      labels: [MOTIR_RUNNER_LABEL, MOTIR_ON_DEMAND_RUNNER_LABEL],
    });
    await boot(deploy.intentId);
    const working = await queue(1, { name: 'lint', runId: '8804' });
    const workingSession = await boot(working.intentId);
    await takes(workingSession, working.job);

    await interrupted(second.session);

    expect(deletes()).toEqual([]);
    expect((await read(second.intentId)).rerunState).toBe('requested');
  });

  it('an arm64 runner still launching is never withdrawn: it boots on-demand and takes no x86 job (MOTIR-11781)', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    // Minted and recorded, its launch not made yet: capacity unknown, exactly the
    // x86 runner the starting-machine case above withdraws.
    const graviton = await queue(1, {
      name: 'docker-arm64',
      runId: '8805',
      labels: [MOTIR_ARM64_RUNNER_LABEL],
    });
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: graviton.intentId },
      data: { status: 'provisioning', githubRunnerId: 77_005, runnerName: 'motir-runner-77005' },
    });

    await interrupted(second.session);

    expect(deletes()).toEqual([]);
    expect((await read(graviton.intentId)).runnerWithdrawnAt).toBeNull();
    expect((await read(second.intentId)).rerunState).toBe('requested');
  });
});

describe('a count-1 re-run, and Spot OFF, pin nothing', () => {
  it('a count-1 re-run opens no hold and withdraws nothing', async () => {
    await seedTenant();
    await spotSetting(true);
    const first = await queue(1);
    const s1 = await boot(first.intentId);
    await takes(s1, first.job);
    await idleSpotRunner();
    order = [];

    await interrupted(s1);

    expect(order).toEqual(['rerun']);
    expect(await pinsOf()).toEqual([]);
  });

  it('with Spot OFF the second re-run opens no hold and withdraws nothing', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    await idleSpotRunner();
    await spotSetting(false);
    order = [];

    await interrupted(second.session);

    expect(order).toEqual(['rerun']);
    expect(await pinsOf()).toEqual([]);
    const next = await queue(1, { name: 'lint', runId: '8805' });
    await boot(next.intentId);
    expect(lastCapacity()).toBe('on_demand');
  });
});

describe('while the hold is open, every boot in its org is on-demand', () => {
  it('another job’s boot in the same org is on_demand; a boot in a different org is still spot', async () => {
    const fx = await seedTenant();
    await spotSetting(true);
    const source = await queue(1);
    await openHold(source.intentId);

    const same = await queue(1, { name: 'lint', runId: '8806' });
    await boot(same.intentId);
    expect(fakeOrchestrator.specs.at(-1)).not.toHaveProperty('capacity');
    expect((await read(same.intentId)).capacity).toBe('on_demand');
    expect(logged()).toContain('an on-demand pin is open in the org');

    // A job of another org, through that org's own installation and group.
    vi.spyOn(projectRunnerGroupService, 'requireRunnerGroupIdFor').mockResolvedValue(
      RUNNER_GROUP_ID,
    );
    const elsewhere = await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.create(
        {
          workspaceId: fx.linkWorkspaceId,
          organizationId: fx.organizationId,
          projectId: fx.linkProjectId,
          githubRepoId: null,
          installationId: '55902',
          runId: '9900',
          runAttempt: 1,
          jobId: '990001',
          jobName: JOB_NAME,
          workflowName: 'CI',
          repoOwner: OTHER_ORG,
          repoName: 'web',
          requestedLabels: [MOTIR_RUNNER_LABEL],
          queuedAt: new Date(Date.now() - 5_000),
        },
        tx,
      ),
    );
    await boot(elsewhere.id);
    expect(fakeOrchestrator.specs.at(-1)?.capacity).toBe('spot');
    expect((await read(elsewhere.id)).capacity).toBe('spot');
  });

  it('the org is compared case-insensitively', async () => {
    await seedTenant();
    await spotSetting(true);
    const source = await queue(1);
    await openHold(source.intentId, { repoOwner: MOTIR_ORG.toUpperCase() });

    expect(await ciSpotRerunPinService.isTargetPinned(MOTIR_ORG, new Date())).toBe(true);
    expect(
      await ciSpotRerunPinService.isTargetPinned(` ${MOTIR_ORG.toUpperCase()} `, new Date()),
    ).toBe(true);
  });

  it('a hold opened between an intent’s creation and its mint gives an on-demand boot', async () => {
    await seedTenant();
    await spotSetting(true);
    const waiting = await queue(1, { name: 'lint', runId: '8807' });
    await openHold(waiting.intentId);

    await boot(waiting.intentId);

    expect(lastCapacity()).toBe('on_demand');
  });

  it('a hold opened after the runner is recorded, before the launch, still gives an on-demand boot', async () => {
    await seedTenant();
    await spotSetting(true);
    const racing = await queue(1, { name: 'lint', runId: '8808' });
    const record = ciRunnerProvisioningIntentRepository.recordMintedRunner.bind(
      ciRunnerProvisioningIntentRepository,
    );
    // The sweep's hold commits in the gap between the runner being recorded and
    // the launch.
    vi.spyOn(ciRunnerProvisioningIntentRepository, 'recordMintedRunner').mockImplementationOnce(
      async (...args) => {
        await record(...args);
        order.push('recorded');
        await openHold(racing.intentId);
      },
    );
    const realPinned = ciSpotRerunPinService.isTargetPinned.bind(ciSpotRerunPinService);
    vi.spyOn(ciSpotRerunPinService, 'isTargetPinned').mockImplementation(async (owner, at) => {
      order.push('read hold');
      return realPinned(owner, at);
    });

    await boot(racing.intentId);

    expect(order).toEqual(['recorded', 'hold', 'read hold']);
    expect(lastCapacity()).toBe('on_demand');
  });

  it('a hold that cannot be read gives an on-demand boot', async () => {
    await seedTenant();
    await spotSetting(true);
    vi.spyOn(ciSpotRerunPinService, 'isTargetPinned').mockRejectedValueOnce(new Error('db down'));
    const next = await queue(1, { name: 'lint', runId: '8809' });

    await boot(next.intentId);

    expect(lastCapacity()).toBe('on_demand');
    expect(logged()).toContain('the on-demand pin could not be read');
  });
});

describe('the reconcile counts the pinned job as on-demand demand', () => {
  const NOW = () => new Date();

  /** GitHub's queue: attempt 3 of the pinned job, queued well past the grace. */
  function pinnedJobQueued(): QueuedFleetJob {
    const job: QueuedFleetJob = {
      runId: RUN_ID,
      runAttempt: 3,
      jobId: '777003',
      jobName: JOB_NAME,
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: REPO_NAME,
      labels: [MOTIR_RUNNER_LABEL],
      createdAt: new Date(Date.now() - 10 * 60_000),
    };
    vi.spyOn(fleetQueueClient, 'listQueuedFleetJobs').mockResolvedValue({
      jobs: [job],
      skippedRuns: [],
    });
    return job;
  }

  function idleRunners(ids: number[]) {
    vi.spyOn(fleetQueueClient, 'listFleetRunners').mockResolvedValue(
      ids.map((id) => ({
        id,
        name: `r${id}`,
        online: true,
        busy: false,
        labels: [MOTIR_RUNNER_LABEL],
      })),
    );
  }

  it('an idle Spot runner does not cover the pinned job: an on-demand intent is minted for it', async () => {
    await seedTenant();
    await spotSetting(true);
    const source = await settledSource();
    await openHold(source.intentId);
    const idle = await queue(1, { name: 'lint', runId: '8810' });
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: idle.intentId },
      data: { status: 'running', githubRunnerId: 66_001, capacity: 'spot' },
    });
    const job = pinnedJobQueued();
    idleRunners([66_001]);

    const outcome = await ciRunnerReconcileService.reconcile({ now: NOW });

    expect(outcome.orgs[0]).toMatchObject({ queued: 1, idleRunners: 1, added: 1 });
    const minted = await adminDb.ciRunnerProvisioningIntent.findFirstOrThrow({
      where: { jobId: job.jobId },
    });
    expect(logged()).toContain('a job pinned to on-demand is queued');
    await boot(minted.id);
    expect(lastCapacity()).toBe('on_demand');
  });

  it('an idle runner on an on-demand machine covers it, and nothing is minted', async () => {
    await seedTenant();
    await spotSetting(true);
    const source = await settledSource();
    await openHold(source.intentId);
    const idle = await queue(1, { name: 'lint', runId: '8811' });
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: idle.intentId },
      data: { status: 'running', githubRunnerId: 66_002, capacity: 'on_demand' },
    });
    pinnedJobQueued();
    idleRunners([66_002]);

    const outcome = await ciRunnerReconcileService.reconcile({ now: NOW });

    expect(outcome.orgs[0]).toMatchObject({ added: 0 });
  });

  it('a pending intent covers it, since it boots under the hold — a Spot-booted one does not', async () => {
    await seedTenant();
    await spotSetting(true);
    const source = await settledSource();
    await openHold(source.intentId);
    const booted = await queue(1, { name: 'lint', runId: '8812' });
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: booted.intentId },
      data: { status: 'provisioning', capacity: 'spot', jobPickedUpAt: new Date() },
    });
    pinnedJobQueued();
    idleRunners([]);

    expect((await ciRunnerReconcileService.reconcile({ now: NOW })).orgs[0]).toMatchObject({
      awaiting: 1,
      added: 1,
    });
    // The intent it minted is pending, not Spot: the next pass counts it.
    expect((await ciRunnerReconcileService.reconcile({ now: NOW })).orgs[0]).toMatchObject({
      added: 0,
    });
  });

  it('pins that cannot be read leave the reconcile counting as before', async () => {
    await seedTenant();
    const source = await settledSource();
    await openHold(source.intentId);
    vi.spyOn(ciSpotRerunPinService, 'listOpenForOrg').mockRejectedValueOnce(new Error('db down'));
    pinnedJobQueued();
    idleRunners([66_003]);

    const outcome = await ciRunnerReconcileService.reconcile({ now: NOW });

    expect(outcome.orgs[0]).toMatchObject({ added: 0 });
    expect(logged()).not.toContain('a job pinned to on-demand is queued');
  });
});

describe('the hold closes, and boots go back to the setting', () => {
  it('on pickup: a runner taking the re-run closes it', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    await interrupted(second.session);
    const third = await queue(3);
    const s3 = await boot(third.intentId);
    expect(lastCapacity()).toBe('on_demand');

    await takes(s3, third.job);

    expect((await pinsOf())[0]).toMatchObject({ closeReason: 'picked_up' });
    expect((await pinsOf())[0]?.closedAt).not.toBeNull();
    const after = await queue(1, { name: 'lint', runId: '8813' });
    await boot(after.intentId);
    expect(lastCapacity()).toBe('spot');
  });

  it('on pickup the delivery never reported: the reconcile closes it from the runner’s record', async () => {
    await seedTenant();
    const source = await queue(2);
    await openHold(source.intentId);
    const taker = await queue(3);
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: taker.intentId },
      data: {
        takenRunId: RUN_ID,
        takenRunAttempt: 3,
        takenJobId: taker.job.jobId,
        takenJobName: JOB_NAME,
      },
    });

    expect(await ciSpotRerunPinService.closeSettledPins(new Date())).toEqual({
      pickedUp: 1,
      agedOut: 0,
    });
    expect((await pinsOf())[0]).toMatchObject({ closeReason: 'picked_up' });
  });

  it('on a re-run refused for good', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    rerunJob.mockResolvedValueOnce({ refused: true, status: 403, mayClear: false });

    await interrupted(second.session);

    expect((await read(second.intentId)).rerunState).toBe('refused');
    expect((await pinsOf())[0]).toMatchObject({ closeReason: 'rerun_refused' });
    const after = await queue(1, { name: 'lint', runId: '8814' });
    await boot(after.intentId);
    expect(lastCapacity()).toBe('spot');
  });

  it('on a re-run that expired', async () => {
    await seedTenant();
    await spotSetting(true);
    const second = await secondAttemptRunning();
    rerunJob.mockResolvedValueOnce({ refused: true, status: 409, mayClear: true });
    await interrupted(second.session);
    const row = await read(second.intentId);
    expect(row.rerunState).toBe('pending');

    await retryPendingSpotReruns(new Date(row.settledAt!.getTime() + SPOT_RERUN_RETRY_WINDOW_MS));

    expect((await read(second.intentId)).rerunState).toBe('expired');
    expect((await pinsOf())[0]).toMatchObject({ closeReason: 'rerun_expired' });
  });

  it('at 24 hours: no longer read as open, and closed aged_out by the reconcile pass', async () => {
    await seedTenant();
    await spotSetting(true);
    const source = await queue(2);
    const openedAt = new Date(Date.now() - CI_SPOT_RERUN_PIN_MAX_AGE_MS - 1_000);
    await openHold(source.intentId, { openedAt });

    expect(await ciSpotRerunPinService.isTargetPinned(MOTIR_ORG, new Date())).toBe(false);
    const after = await queue(1, { name: 'lint', runId: '8815' });
    await boot(after.intentId);
    expect(lastCapacity()).toBe('spot');

    vi.spyOn(fleetQueueClient, 'listQueuedFleetJobs').mockResolvedValue({
      jobs: [],
      skippedRuns: [],
    });
    vi.spyOn(fleetQueueClient, 'listFleetRunners').mockResolvedValue([]);
    await ciRunnerReconcileService.reconcile({ now: () => new Date() });
    expect((await pinsOf())[0]).toMatchObject({ closeReason: 'aged_out' });
  });

  it('a hold still open and not picked up stays open on the reconcile pass', async () => {
    await seedTenant();
    const source = await queue(2);
    await openHold(source.intentId);

    expect(await ciSpotRerunPinService.closeSettledPins(new Date())).toEqual({
      pickedUp: 0,
      agedOut: 0,
    });
    expect((await pinsOf())[0]?.closedAt).toBeNull();
  });
});

describe('the closes throw nowhere', () => {
  it('a close for a refused re-run that cannot be written is logged', async () => {
    vi.spyOn(ciSpotRerunPinRepository, 'closeBySource').mockRejectedValueOnce(new Error('db down'));
    await expect(
      ciSpotRerunPinService.closePinForRerun('missing', 'rerun_refused', new Date()),
    ).resolves.toBeUndefined();
  });

  it('a pass whose pins cannot be listed closes nothing', async () => {
    vi.spyOn(ciSpotRerunPinRepository, 'listUnclosed').mockRejectedValueOnce(new Error('db down'));
    expect(await ciSpotRerunPinService.closeSettledPins(new Date())).toEqual({
      pickedUp: 0,
      agedOut: 0,
    });
  });

  it('a pin that cannot be closed is skipped, and one closed by another pass is not counted', async () => {
    await seedTenant();
    const a = await queue(2);
    const b = await queue(2, { runId: '7902' });
    const old = new Date(Date.now() - CI_SPOT_RERUN_PIN_MAX_AGE_MS - 1_000);
    await openHold(a.intentId, { openedAt: old });
    await openHold(b.intentId, { openedAt: old });
    vi.spyOn(ciSpotRerunPinRepository, 'close')
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(false);

    expect(await ciSpotRerunPinService.closeSettledPins(new Date())).toEqual({
      pickedUp: 0,
      agedOut: 0,
    });
  });
});

describe('the pure parts', () => {
  const pin = {
    repoOwner: 'Motir-Projects',
    repoName: 'Sibling-Web',
    runId: RUN_ID,
    runAttempt: 2,
    jobName: JOB_NAME,
  } as Parameters<typeof isPinnedJob>[1][number];
  const job = { repoOwner: MOTIR_ORG, repoName: REPO_NAME, runId: RUN_ID, jobName: JOB_NAME };

  it('isPinnedJob matches a later attempt of the same repo, run and name only', () => {
    expect(isPinnedJob({ ...job, runAttempt: 3 }, [pin])).toBe(true);
    expect(isPinnedJob({ ...job, runAttempt: 2 }, [pin])).toBe(false);
    expect(isPinnedJob({ ...job, runAttempt: 3, jobName: null }, [pin])).toBe(false);
    expect(isPinnedJob({ ...job, runAttempt: 3, jobName: 'lint' }, [pin])).toBe(false);
    expect(isPinnedJob({ ...job, runAttempt: 3, runId: '1' }, [pin])).toBe(false);
    expect(isPinnedJob({ ...job, runAttempt: 3, repoName: 'other' }, [pin])).toBe(false);
    expect(isPinnedJob({ ...job, runAttempt: 3 }, [])).toBe(false);
  });

  const none = {
    queuedOnDemand: 0,
    queuedOther: 0,
    idleOnDemand: 0,
    idleOther: 0,
    awaitingOnDemand: 0,
    awaitingOther: 0,
  };

  it('coverPartitions: a pinned job is covered only by capacity known not to be Spot', () => {
    // An idle Spot runner covers an ordinary job, never the pinned one.
    expect(coverPartitions({ ...none, queuedPinned: 1, idleOther: 1 })).toEqual({
      uncoveredOnDemand: 0,
      uncoveredOther: 0,
      uncoveredPinned: 1,
    });
    // An idle on-demand machine covers it, and is then spent.
    expect(
      coverPartitions({
        ...none,
        queuedPinned: 1,
        queuedOther: 1,
        idleOther: 1,
        idlePinnedCapable: 1,
      }),
    ).toEqual({ uncoveredOnDemand: 0, uncoveredOther: 1, uncoveredPinned: 0 });
    // The on-demand surplus covers it once the not-Spot capacity runs out.
    expect(
      coverPartitions({
        ...none,
        queuedPinned: 2,
        queuedOther: 2,
        idleOnDemand: 2,
        awaitingOther: 1,
        awaitingPinnedCapable: 1,
      }),
    ).toEqual({ uncoveredOnDemand: 0, uncoveredOther: 1, uncoveredPinned: 0 });
    // Capable counts never exceed the ordinary capacity they are part of.
    expect(
      coverPartitions({ ...none, queuedPinned: 3, idleOther: 1, idlePinnedCapable: 5 }),
    ).toEqual({ uncoveredOnDemand: 0, uncoveredOther: 0, uncoveredPinned: 2 });
  });

  it('coverPartitions with no pinned job is the formula before pins existed', () => {
    expect(coverPartitions({ ...none, queuedOther: 5, idleOther: 1, awaitingOther: 2 })).toEqual({
      uncoveredOnDemand: 0,
      uncoveredOther: 2,
      uncoveredPinned: 0,
    });
  });

  it('requestSpotRerun pins only a count-2 job with a name and an attempt', async () => {
    await spotSetting(true);
    const answer = await requestSpotRerun({
      id: 'not-stored',
      repoOwner: 'acme',
      repoName: 'web',
      installationId: '313',
      takenRepoOwner: null,
      takenRepoName: null,
      takenRunId: '1',
      takenRunAttempt: 2,
      takenJobId: '2',
      takenJobName: null,
      takenJobSpotInterruptions: 2,
    });
    expect(answer).toBe('requested');
    expect(order).toEqual(['rerun']);
  });
});
