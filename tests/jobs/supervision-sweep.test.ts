import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import {
  supervisionSweepService,
  SUPERVISION_STALL_GRACE_MS,
  WORST_LEGITIMATE_GAP_MS,
} from '@/lib/services/supervisionSweepService';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { ciRunnerBootService, FLEET_TIME_BUDGETS } from '@/lib/services/ciRunnerBootService';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
// Imported for its SIDE EFFECT as well as its value: `defineJob` registers at
// module evaluation, so a test that only asks the registry finds nothing unless
// something has evaluated the definition.
import { supervisionSweep } from '@/lib/jobs/definitions/supervisionSweep';
import { SUB_HOURLY_CADENCE } from '@/lib/jobs/schedules';
import { IDLE_MAX_MS, LEASE_MS, retryBackoffMs } from '@/lib/jobs/engine/worker';
import { FLEET_CONTAINER_SIZE } from '@motir/orchestrator';
import { fakeOrchestrator } from '@motir/orchestrator';
import { fakeOrchestratorForShard, resetShardFakes } from '@/lib/orchestrator';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { hostedRunChargeService } from '@/lib/services/hostedRunChargeService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import {
  hostedAgentBootStepId,
  type HostedAgentSession,
} from '@/lib/services/hostedAgentContainerService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// THE ABANDONED-SUPERVISION SWEEP (Story MOTIR-3778 · Subtask MOTIR-3830),
// against a real Postgres.
//
// The state it owns is one this story CREATES. While a supervision was a loop
// inside one run, a `finally` covered every way out of it; a chain of passes can
// simply stop, and then a container keeps running with nothing watching it. What
// is left without this is the 70-minute fleet reaper, whose resolver is
// CI-intent-shaped: for an index container it logs "no attributable intent",
// writes no usage row, and releases no admission slot.
//
// ⚠️ THE CRITERION THAT MATTERS IS THE NEGATIVE. Sweeping a DEAD supervision
// late costs some minutes of container; sweeping a LIVE one destroys a machine a
// customer's CI job is running in. So the assertions are weighted that way, and
// the grace window is asserted as an INEQUALITY against the arithmetic that sets
// it rather than as a number somebody liked the look of.

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function makeRun(state: 'pending' | 'running' | 'failed' = 'failed'): Promise<JobQueueRun> {
  seq += 1;
  const user = await usersService.createUser({
    email: `sweep-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Sweep ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Sweep WS ${seq}`,
    ownerUserId: user.id,
  });
  return adminDb.jobQueueRun.create({
    data: {
      jobId: 'system.code-graph-index',
      eventName: 'code-graph/index.requested',
      workspaceId: workspace.id,
      runAt: new Date(Date.now() - 60 * 60_000),
      maxAttempts: 3,
      state,
    },
  });
}

const INDEX_SESSION = (subject: string) => ({
  handle: {
    provider: 'fake',
    id: `c-${subject}`,
    region: 'ams',
    createdAt: new Date().toISOString(),
  },
  bootedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
  credentialExpiresAt: new Date().toISOString(),
  runId: 'r',
  dispatchId: 'd',
  repoRef: 'moooon-B-V/motir-core',
  slotRef: `slot-${subject}`,
  attribution: {
    orgId: 'org-1',
    workspaceId: 'ws-1',
    projectId: subject,
    repoFullName: 'moooon-B-V/motir-core',
  },
});

const RUNNER_SESSION = (subject: string) => ({
  intentId: subject,
  handle: {
    provider: 'fake',
    id: `c-${subject}`,
    region: 'ams',
    createdAt: new Date().toISOString(),
  },
  githubRunnerId: 7,
  bootedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
  queuedAt: new Date(Date.now() - 41 * 60_000).toISOString(),
  attribution: {
    orgId: 'org-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    repoFullName: 'moooon-B-V/motir-core',
    workflowJobId: 99,
  },
});

/** A supervision whose next poll was due `dueMinutesAgo` minutes back, with its boot memo. */
async function seedSupervision(
  run: JobQueueRun,
  opts: { kind: 'index' | 'ci-runner'; subject: string; dueMinutesAgo: number; withMemo?: boolean },
): Promise<void> {
  await withSystemContext(async (tx) => {
    await jobSupervisionRepository.open(
      {
        runId: run.id,
        subject: opts.subject,
        kind: opts.kind,
        nextPollAt: new Date(Date.now() - opts.dueMinutesAgo * 60_000),
        workspaceId: run.workspaceId,
      },
      tx,
    );
    if (opts.withMemo === false) return;
    await jobStepRepository.create(
      {
        runId: run.id,
        stepId: opts.kind === 'index' ? `index-boot:${opts.subject}` : 'boot-runner',
        kind: 'run',
        result: {
          phase: 'supervising',
          session:
            opts.kind === 'index' ? INDEX_SESSION(opts.subject) : RUNNER_SESSION(opts.subject),
        },
        workspaceId: run.workspaceId,
      },
      tx,
    );
  });
}

function readRow(runId: string, subject: string) {
  return withSystemContext((tx) =>
    jobSupervisionRepository.findByRunAndSubject(runId, subject, tx),
  );
}

/** Stub both terminal transitions so the sweep's DISPATCH is what is observed. */
function stubTerminals() {
  return {
    index: vi
      .spyOn(codeGraphIndexDispatchService, 'settleIndexContainer')
      .mockResolvedValue({ outcome: 'teardown_failed', detail: 'stub' } as never),
    runner: vi
      .spyOn(ciRunnerBootService, 'settleSupervision')
      .mockResolvedValue({ outcome: 'unknown_intent' } as never),
  };
}

describe('the grace window', () => {
  it('exceeds the worst LEGITIMATE gap between two passes — asserted as the inequality', () => {
    // The arithmetic, re-derived from the constants rather than restated: the
    // longest wait a defer names, plus the worker's idle ceiling, plus a lease
    // that must expire before a dead claimant's row is reclaimable, plus the
    // longest retry backoff a FAILED pass can be rescheduled at.
    const worst =
      FLEET_TIME_BUDGETS.maxPollIntervalMs + IDLE_MAX_MS + LEASE_MS + retryBackoffMs(99, () => 0.5);
    expect(WORST_LEGITIMATE_GAP_MS).toBeGreaterThanOrEqual(worst);
    expect(SUPERVISION_STALL_GRACE_MS).toBeGreaterThan(WORST_LEGITIMATE_GAP_MS);
    // And comfortably inside the 70-minute fleet reaper it exists to pre-empt:
    // the grace plus the gap to the next clustered tick must still beat it.
    expect(SUPERVISION_STALL_GRACE_MS + 30 * 60_000).toBeLessThan(FLEET_TIME_BUDGETS.reapAfterMs);
  });
});

describe('a chain that stopped', () => {
  it('settles an INDEX supervision through the index fleet’s own terminal transition', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    const terminals = stubTerminals();

    const result = await supervisionSweepService.sweepAbandoned();

    expect(result).toEqual({ scanned: 1, settled: 1, skipped: 0 });
    expect(terminals.index).toHaveBeenCalledTimes(1);
    expect(terminals.runner).not.toHaveBeenCalled();
    // The session came out of the BOOT MEMO — the sweep reconstructs it the way
    // a resumed pass does, without invoking the handler at all.
    expect(terminals.index.mock.calls[0]![0]).toMatchObject({ slotRef: 'slot-proj-a' });
    expect(terminals.index.mock.calls[0]![1]).toMatchObject({
      done: true,
      reason: 'job_timed_out',
      failureDetail: expect.stringContaining('abandoned'),
    });
    expect((await readRow(run.id, 'proj-a'))!.state).toBe('settled');
  });

  it('settles a CI-RUNNER supervision through the CI fleet’s own terminal transition', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, { kind: 'ci-runner', subject: 'intent-1', dueMinutesAgo: 40 });
    const terminals = stubTerminals();

    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 1,
      settled: 1,
      skipped: 0,
    });
    expect(terminals.runner).toHaveBeenCalledTimes(1);
    expect(terminals.index).not.toHaveBeenCalled();
    expect(terminals.runner.mock.calls[0]![0]).toMatchObject({ intentId: 'intent-1' });
  });

  it('sweeps a run whose queue row is GONE — the chain cannot come back at all', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    const terminals = stubTerminals();
    // Detach the row from the run first, so deleting the run does not cascade
    // the supervision away — the state under test is "the row outlived its run".
    await adminDb.$executeRawUnsafe(`DELETE FROM "job_step" WHERE "run_id" = $1`, run.id);
    await adminDb.jobQueueRun.delete({ where: { id: run.id } });

    // The supervision cascaded with its run, which is the OTHER correct answer:
    // nothing is left to sweep, and the sweep says so rather than inventing work.
    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 0,
      settled: 0,
      skipped: 0,
    });
    expect(terminals.index).not.toHaveBeenCalled();
  });
});

describe('a LIVE supervision is never swept', () => {
  it('leaves a row whose next poll is inside the grace window', async () => {
    const run = await makeRun('pending');
    // Deferred to the far end of the backoff, well inside the window.
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 1 });
    const terminals = stubTerminals();

    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 0,
      settled: 0,
      skipped: 0,
    });
    expect(terminals.index).not.toHaveBeenCalled();
    expect((await readRow(run.id, 'proj-a'))!.state).toBe('watching');
  });

  it('leaves a row whose owning run is RUNNING — a pass is in flight right now', async () => {
    const run = await makeRun('running');
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    const terminals = stubTerminals();

    // The candidate is FOUND — its last poll instant is long past — and then
    // declined, which is exactly the two-facts check: `next_poll_at` says the
    // chain should have come back, the queue row says it still can.
    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 1,
      settled: 0,
      skipped: 1,
    });
    expect(terminals.index).not.toHaveBeenCalled();
    expect((await readRow(run.id, 'proj-a'))!.state).toBe('watching');
  });

  it('leaves a row whose owning run is PENDING and due in the future', async () => {
    const run = await makeRun('pending');
    await adminDb.jobQueueRun.update({
      where: { id: run.id },
      data: { runAt: new Date(Date.now() + 60_000) },
    });
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    const terminals = stubTerminals();

    expect(await supervisionSweepService.sweepAbandoned()).toMatchObject({
      settled: 0,
      skipped: 1,
    });
    expect(terminals.index).not.toHaveBeenCalled();
  });

  it('leaves a row already SETTLING — a live pass is mid-teardown', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    await withSystemContext((tx) =>
      jobSupervisionRepository.markState(run.id, 'proj-a', 'settling', tx),
    );
    const terminals = stubTerminals();

    // `listStalled` filters on `watching`, so it is not even a candidate — which
    // is what stops the sweep entering a teardown the driver is performing.
    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 0,
      settled: 0,
      skipped: 0,
    });
    expect(terminals.index).not.toHaveBeenCalled();
  });
});

describe('idempotence and concurrency', () => {
  it('two overlapping ticks settle each stalled supervision ONCE, not twice', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    const terminals = stubTerminals();

    const [a, b] = await Promise.all([
      supervisionSweepService.sweepAbandoned(),
      supervisionSweepService.sweepAbandoned(),
    ]);

    // ⚠️ `teardown`'s own idempotence is NOT what is relied on. An idempotent
    // destroy does not make a second USAGE row disappear, so the claim is a
    // locked compare-and-set and exactly one tick wins it.
    expect(terminals.index).toHaveBeenCalledTimes(1);
    expect([a.settled, b.settled].sort()).toEqual([0, 1]);
  });

  it('a second tick after a settled one finds nothing', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    stubTerminals();

    expect((await supervisionSweepService.sweepAbandoned()).settled).toBe(1);
    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 0,
      settled: 0,
      skipped: 0,
    });
  });

  it('drops a row with NO boot memo rather than inventing a teardown', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, {
      kind: 'index',
      subject: 'proj-a',
      dueMinutesAgo: 40,
      withMemo: false,
    });
    const terminals = stubTerminals();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await supervisionSweepService.sweepAbandoned();

    // Nothing was ever provisioned under this row, so there is no container to
    // tear down. Stop tracking it; do not fabricate a settle.
    expect(terminals.index).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, settled: 0, skipped: 1 });
    expect((await readRow(run.id, 'proj-a'))!.state).toBe('settled');
    expect(warn).toHaveBeenCalled();
  });
});

describe('reading the session back out of the boot memo', () => {
  // ⚠️ EVERY ARM OF THIS READ IS A REFUSAL, and each has to answer null rather
  // than hand the terminal transition a half-shaped object. The sweep is the one
  // caller that reconstructs a session WITHOUT the handler having run, so a
  // memo it cannot make sense of has no second source to fall back on.
  const rowFor = (runId: string, kind: 'index' | 'ci-runner', subject: string) =>
    ({ runId, kind, subject }) as never;

  it('answers null for a SLEEP checkpoint — a sleep memo carries no result at all', async () => {
    const run = await makeRun('failed');
    await withSystemContext((tx) =>
      jobStepRepository.create(
        {
          runId: run.id,
          stepId: 'index-boot:p1',
          kind: 'sleep',
          sleepUntil: new Date(),
          workspaceId: run.workspaceId,
        },
        tx,
      ),
    );
    expect(await supervisionSweepService.readSession(rowFor(run.id, 'index', 'p1'))).toBeNull();
  });

  it('answers null for a TERMINAL boot — nothing was provisioned to tear down', async () => {
    const run = await makeRun('failed');
    await withSystemContext((tx) =>
      jobStepRepository.create(
        {
          runId: run.id,
          stepId: 'index-boot:p1',
          kind: 'run',
          result: { phase: 'terminal', outcome: { outcome: 'provision_failed', detail: 'x' } },
          workspaceId: run.workspaceId,
        },
        tx,
      ),
    );
    expect(await supervisionSweepService.readSession(rowFor(run.id, 'index', 'p1'))).toBeNull();
  });

  it('answers null when the memo is absent, and when its result is null', async () => {
    const run = await makeRun('failed');
    expect(await supervisionSweepService.readSession(rowFor(run.id, 'index', 'p1'))).toBeNull();
    await withSystemContext((tx) =>
      jobStepRepository.create(
        { runId: run.id, stepId: 'boot-runner', kind: 'run', workspaceId: run.workspaceId },
        tx,
      ),
    );
    expect(
      await supervisionSweepService.readSession(rowFor(run.id, 'ci-runner', 'i-1')),
    ).toBeNull();
  });

  it('a run row that no longer exists is not live', async () => {
    // The `!run` arm, reached by asking about a run id nothing owns — which is
    // what a supervision row outliving its run would look like if the cascade
    // were ever relaxed.
    expect(
      await supervisionSweepService.runIsStillLive(
        { runId: 'run-that-never-was' } as never,
        new Date(),
      ),
    ).toBe(false);
  });

  it('carries the OBSERVED start through to both terminal transitions', async () => {
    // The other side of the `startedAt` branch: a container the provider DID
    // report running before the chain stopped. The observation is the row's, so
    // the settle carries it — and the CI arm re-derives `bootLatencyMs` from it
    // and the memoized `queuedAt`, which is why neither is a column (§16.2).
    const observed = new Date(Date.now() - 39 * 60_000);
    const indexRun = await makeRun('failed');
    await seedSupervision(indexRun, { kind: 'index', subject: 'proj-s', dueMinutesAgo: 40 });
    const ciRun = await makeRun('failed');
    await seedSupervision(ciRun, { kind: 'ci-runner', subject: 'intent-s', dueMinutesAgo: 40 });
    for (const [run, subject] of [
      [indexRun, 'proj-s'],
      [ciRun, 'intent-s'],
    ] as const) {
      await withSystemContext((tx) =>
        jobSupervisionRepository.advance(
          run.id,
          subject,
          { startedAt: observed, consecutiveReadFailures: 0, nextPollAt: run.runAt },
          tx,
        ),
      );
    }
    const terminals = stubTerminals();

    expect((await supervisionSweepService.sweepAbandoned()).settled).toBe(2);
    expect(terminals.index.mock.calls[0]![1]).toMatchObject({
      startedAt: observed.toISOString(),
    });
    const runnerVerdict = terminals.runner.mock.calls[0]![1] as {
      startedAt: string | null;
      bootLatencyMs: number | null;
    };
    expect(runnerVerdict.startedAt).toBe(observed.toISOString());
    // `startedAt − queuedAt`, and the fixture's session queued a minute before
    // it booted, so the latency is positive and derived rather than stored.
    expect(runnerVerdict.bootLatencyMs).toBeGreaterThan(0);
  });

  it('settles a CI supervision whose container was never OBSERVED to start', async () => {
    // `startedAt` null is the branch where `bootLatencyMs` cannot be derived —
    // the container was booted and the provider never reported it running.
    const run = await makeRun('failed');
    await seedSupervision(run, { kind: 'ci-runner', subject: 'intent-2', dueMinutesAgo: 40 });
    const terminals = stubTerminals();

    expect((await supervisionSweepService.sweepAbandoned()).settled).toBe(1);
    expect(terminals.runner.mock.calls[0]![1]).toMatchObject({
      startedAt: null,
      bootLatencyMs: null,
    });
  });
});

describe('a quiet tick is free', () => {
  it('performs no orchestrator call at all when nothing is stalled', async () => {
    const terminals = stubTerminals();
    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 0,
      settled: 0,
      skipped: 0,
    });
    expect(terminals.index).not.toHaveBeenCalled();
    expect(terminals.runner).not.toHaveBeenCalled();
  });
});

describe('the shape of the thing', () => {
  it('re-implements NO teardown — there is no `teardown(` in the service', () => {
    // ⚠️ ASSERTED BY READING THE FILE, because the alternative is a second
    // implementation of the one path in this system where being subtly wrong
    // costs a duplicated billed container. The sweep calls the supervisors' own
    // terminal transitions, which already destroy, meter and release.
    const source = readFileSync('lib/services/supervisionSweepService.ts', 'utf8');
    expect(source).not.toMatch(/\bteardown\(/);
    expect(source).toMatch(/settleIndexContainer\(/);
    expect(source).toMatch(/settleSupervision\(/);
  });

  it('the handler delegates to the service and returns what it counted', async () => {
    // Driven through the ENGINE registry's own handler — the raw function the
    // worker actually invokes — rather than through the ledger, which would
    // re-enter the whole bookkeeping path and test that instead of this.
    const spy = vi
      .spyOn(supervisionSweepService, 'sweepAbandoned')
      .mockResolvedValue({ scanned: 3, settled: 2, skipped: 1 });
    const repairSpy = vi
      .spyOn(supervisionSweepService, 'repairStrandedUsage')
      .mockResolvedValue({ scanned: 4, settled: 1 });
    const silentStep = {
      run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
    };

    const handler = engineJob('system.supervision-sweep')!.handler;
    const result = await handler({ step: silentStep } as never, jobServices as never);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(repairSpy).toHaveBeenCalledTimes(1);
    // The counts land on the ledger row's `output`, which is what makes a quiet
    // tick and a busy one distinguishable on the operator surface.
    expect(result).toEqual({ scanned: 3, settled: 2, skipped: 1, repairedUsage: 1 });
  });

  it('runs every 5 minutes, and declares its catch-up at the cron', () => {
    const def = engineJob('system.supervision-sweep');
    expect(def).toBeDefined();
    expect(def).toBe(supervisionSweep);
    // 15-minute grace + ≤ 5 minutes to the next tick = a 20-minute worst case,
    // against the 70-minute fleet reaper it pre-empts (MOTIR-6932).
    expect(def!.cron).toBe(SUB_HOURLY_CADENCE);
    // §11.8: the disposition is declared BESIDE the cron, never in a second list.
    expect(def!.catchUp).toBe('latest');
  });
});

describe('an abandoned hosted-agent supervision on an agent-runner account (MOTIR-9424)', () => {
  it('is torn down on that account, charged once, and ended lost_supervision', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    resetShardFakes();
    fleetShardOrchestratorService.resetCache();
    fakeOrchestrator.reset();
    const run = await makeRun('failed');
    const project = await adminDb.project.create({
      data: {
        workspaceId: run.workspaceId,
        name: 'Sweep',
        identifier: `SW${seq}`,
        slug: `sweep-${seq}`,
      },
    });
    const shard = await adminDb.fleetShard.create({
      data: {
        name: `agents-sweep-${seq}`,
        fleetKind: 'hosted_agent',
        provider: 'fly',
        state: 'active',
        githubOrg: 'motir-projects',
        githubInstallationId: '556677',
        flyOrg: 'motir',
        flyApp: `motir-agents-sweep-${seq}`,
        flyRegion: 'iad',
        credentialRef: 'FLEET_SHARD_TEST_TOKEN',
        machineLimit: 5,
      },
    });
    const dispatchRun = await adminDb.dispatchRun.create({
      data: {
        workspaceId: run.workspaceId,
        projectId: project.id,
        command: 'run',
        fleetShardId: shard.id,
      },
    });
    const workspace = await adminDb.workspace.findUniqueOrThrow({ where: { id: run.workspaceId } });
    const orgId = workspace.organizationId;
    if (orgId === null) throw new Error('the seeded workspace belongs to no organisation');
    const account = fakeOrchestratorForShard(shard.id);
    const handle = await account.provision({
      orgId,
      workspaceId: run.workspaceId,
      projectId: project.id,
      repoFullName: 'motir-projects/site',
      workload: 'hosted_agent',
      workflowJobId: null,
      image: 'motir/hosted-agent@sha256:fake',
      size: FLEET_CONTAINER_SIZE,
      env: {},
      timeoutSeconds: 3_600,
      region: 'iad',
    });
    const dispatchId = `hosted-run:${dispatchRun.id}`;
    const session: HostedAgentSession = {
      handle: {
        provider: handle.provider,
        id: handle.id,
        region: handle.region,
        createdAt: handle.createdAt.toISOString(),
        shardId: shard.id,
      },
      bootedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      dispatchId,
      runId: dispatchRun.id,
      dispatchRunId: dispatchRun.id,
      timeoutSeconds: 3_600,
      size: FLEET_CONTAINER_SIZE,
      attribution: {
        orgId,
        workspaceId: run.workspaceId,
        projectId: project.id,
        repoFullName: 'motir-projects/site',
      },
    };
    await withSystemContext(async (tx) => {
      await jobSupervisionRepository.open(
        {
          runId: run.id,
          subject: dispatchId,
          kind: 'hosted-agent',
          nextPollAt: new Date(Date.now() - 40 * 60_000),
          workspaceId: run.workspaceId,
        },
        tx,
      );
      await jobStepRepository.create(
        {
          runId: run.id,
          stepId: hostedAgentBootStepId(dispatchId),
          kind: 'run',
          result: JSON.parse(JSON.stringify({ phase: 'supervising', session })),
          workspaceId: run.workspaceId,
        },
        tx,
      );
    });
    const accountTeardown = vi.spyOn(account, 'teardown');
    const legacyTeardown = vi.spyOn(fakeOrchestrator, 'teardown');
    const charge = vi
      .spyOn(hostedRunChargeService, 'chargeMachineTime')
      .mockResolvedValue({ outcome: 'skipped' } as never);
    const end = vi.spyOn(hostedRunService, 'endHostedRun').mockResolvedValue({} as never);

    expect(await supervisionSweepService.sweepAbandoned()).toMatchObject({ settled: 1 });

    expect(accountTeardown).toHaveBeenCalledTimes(1);
    expect(accountTeardown.mock.calls[0]![1]).toBe('job_timed_out');
    expect(legacyTeardown).not.toHaveBeenCalled();
    expect(account.liveContainerIds()).toEqual([]);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledWith(dispatchRun.id);
    expect(end).toHaveBeenCalledWith(dispatchRun.id, 'lost_supervision', expect.anything());

    await adminDb.dispatchRun.deleteMany({ where: { id: dispatchRun.id } });
    await adminDb.fleetShard.deleteMany({ where: { id: shard.id } });
    vi.unstubAllEnvs();
  });
});
