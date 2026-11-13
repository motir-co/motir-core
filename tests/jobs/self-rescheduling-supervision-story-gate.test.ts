import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { JobWorker, POOL_SIZE } from '@/lib/jobs/engine/worker';
import { engineJob } from '@/lib/jobs/engine/registry';
// ⚠️ IMPORTED FOR ITS SIDE EFFECT. `defineJob` registers at MODULE EVALUATION,
// so a file that only asks the registry finds an empty one — and
// `executeWithLedger` then throws `UnknownEngineJobError` for a job that is
// perfectly well defined. This file drives the REAL registered handler, so it
// has to be the thing that evaluates them.
import '@/lib/jobs/registry';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import {
  codeGraphIndexDispatchService,
  INDEX_ADMISSION_BUDGETS,
  INDEX_FLEET_TIME_BUDGETS,
} from '@/lib/services/codeGraphIndexDispatchService';
import { FLEET_TIME_BUDGETS } from '@/lib/services/ciRunnerBootService';
import { SUB_HOURLY_CADENCE } from '@/lib/jobs/schedules';
import { fakeOrchestrator } from '@motir/orchestrator';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  INDEX_REPO_REF,
  indexEventFor,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// ═══════════════════════════════════════════════════════════════════════════
// STORY GATE — a supervision is a SELF-RESCHEDULING RUN (MOTIR-3778 · MOTIR-3831)
// ═══════════════════════════════════════════════════════════════════════════
//
// The story's vitest gate, run after every code card in it. It is deliberately
// NOT a second copy of the per-card suites: those assert each card's own
// behaviour, and this asserts the SEAMS BETWEEN THEM and the ARCHITECTURE
// GUARDS a coverage percentage cannot see.
//
// §1 · THE SEAMS — one card's real output through the next card's real consumer,
//      against a real Postgres, the real registered job, the real ledger and the
//      REAL WORKER. Nothing in §1 stubs a step, a store or a settle: what is
//      under test is precisely the composition the unit suites take apart.
//
// §2 · THE GUARDS — properties that survive no amount of coverage: no timing
//      constant in the driver, the budgets byte-identical, §14.1's refusal
//      intact, one composition per fleet, the cron on the cluster, and the
//      tenancy predicate biting.
//
// ⚠️ THE ORDERING ASSERTIONS ARE PINNED ON AUTHORITATIVE SIGNALS, NEVER ON A
// CLOCK — a released row, a recorded provider call, a `job_run` row. The
// repository's flake rule one altitude up says the same thing about a browser:
// waiting on a signal is what makes a test mean the same under CI load as it
// does on an idle box.

const SUPERVISION_SOURCES = [
  'lib/jobs/supervision/driver.ts',
  'lib/jobs/supervision/inProcessSteps.ts',
];

/**
 * Millisecond budgets, so a whole supervision is a handful of real passes.
 *
 * ⚠️ MUTABLE, and read by the ONE spy `beforeEach` installs, so a test can
 * re-point a budget mid-supervision without spying a spy — which is how a
 * second `vi.spyOn` on the same method ends up calling itself.
 */
let fastBudgets: Record<string, number> = {};
function resetBudgets(): void {
  fastBudgets = {
    bootDeadlineMs: 60_000,
    indexTimeoutMs: 600_000,
    pollIntervalMs: 1,
    maxPollIntervalMs: 2,
    admissionWaitMs: 1,
    maxAdmissionWaitMs: 2,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetTarballBodyTrap();
  stubIndexFleet();
  // The budgets, and ONLY the budgets. The durable `job_supervision` store is
  // deliberately left in place — this file is the one that exercises it.
  resetBudgets();
  const real = codeGraphIndexDispatchService.advanceIndexContainer.bind(
    codeGraphIndexDispatchService,
  );
  vi.spyOn(codeGraphIndexDispatchService, 'advanceIndexContainer').mockImplementation(
    (runId, input, options) => real(runId, input, { ...fastBudgets, ...options }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

interface Live {
  runId: string;
  workspaceId: string;
  projectIds: string[];
  eventData: unknown;
  worker: JobWorker;
  outcomes: string[];
  describes: () => number;
  provisions: () => number;
}

/**
 * A REAL run of `system.code-graph-index`, claimed by a REAL worker.
 *
 * The whole engine is in the loop: `claimDueRuns` takes the row,
 * `executeWithLedger` writes the ledger around the registered handler, and the
 * worker's settle path interprets whatever the handler throws.
 */
async function liveIndexRun(projectCount = 1): Promise<Live> {
  seq += 1;
  const { workspaceId, projectIds, installationId } = await seedIndexWorkspace(
    `gate${seq}`,
    projectCount,
  );
  const event = indexEventFor({ installationId, workspaceId, eventId: `evt-gate-${seq}` });
  const jobEvent = await adminDb.jobEvent.create({
    data: { name: event.name, data: event.data as object, workspaceId },
  });
  const run = await adminDb.jobQueueRun.create({
    data: {
      jobId: 'system.code-graph-index',
      eventId: jobEvent.id,
      eventName: event.name,
      workspaceId,
      runAt: new Date(),
      maxAttempts: 3,
    },
  });

  const describeSpy = vi.spyOn(fakeOrchestrator, 'describe');
  const provisionSpy = vi.spyOn(fakeOrchestrator, 'provision');
  const outcomes: string[] = [];
  const worker = new JobWorker({
    workerId: `gate-worker-${seq}`,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    onOutcome: (_run, outcome) => outcomes.push(outcome),
    execute: async (claimed) => {
      await executeWithLedger(claimed, event.data);
    },
    onTerminalFailure: async (claimed, err) => {
      await recordEngineTerminalFailure(claimed, err, event.data);
    },
  });

  return {
    runId: run.id,
    workspaceId,
    projectIds,
    eventData: event.data,
    worker,
    outcomes,
    describes: () => describeSpy.mock.calls.length,
    provisions: () => provisionSpy.mock.calls.length,
  };
}

/** Claim and settle ONE pass. Returns whether the worker had anything to claim. */
async function onePass(live: Live): Promise<boolean> {
  const claimed = await live.worker.tick();
  await live.worker.settled();
  return claimed > 0;
}

/** Make the row due now — the queue's own clock, without waiting out a real interval. */
async function makeDue(runId: string): Promise<void> {
  await adminDb.jobQueueRun.update({ where: { id: runId }, data: { runAt: new Date() } });
}

function readQueueRow(runId: string) {
  return adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: runId } });
}

// ───────────────────────────────────────────────────────────────────────────
// §1 · THE SEAMS
// ───────────────────────────────────────────────────────────────────────────

describe('§1.1 the supervision seam — a whole run, pass by pass, through the real worker', () => {
  it('holds a worker slot only DURING a pass: pending and unclaimed between them, one describe each', async () => {
    const live = await liveIndexRun();

    // Pass 1: admit, boot, and the opening wait. No provider read.
    expect(await onePass(live)).toBe(true);
    expect(live.provisions()).toBe(1);
    expect(live.describes()).toBe(0);

    let row = await readQueueRow(live.runId);
    expect(row.state, 'the row is back in the queue between passes').toBe('pending');
    expect(row.claimedBy).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    expect(live.worker.inFlightCount, 'and the worker holds nothing').toBe(0);
    expect(live.worker.freeCapacity).toBe(POOL_SIZE);

    // Then eight polls, one per pass, with nothing else touching the provider.
    for (let n = 1; n <= 8; n += 1) {
      await makeDue(live.runId);
      const before = live.describes();
      expect(await onePass(live), `pass ${n} must be claimable`).toBe(true);
      expect(live.describes() - before, `pass ${n} performs one describe`).toBe(1);
      row = await readQueueRow(live.runId);
      expect(row.state, `pending after pass ${n}`).toBe('pending');
      expect(row.claimedBy).toBeNull();
    }

    // ⚠️ THE PROPERTY THE STORY EXISTS FOR, stated as a number.
    //   command: vitest run tests/jobs/self-rescheduling-supervision-story-gate.test.ts
    //   reads == polls == 8, LINEAR.
    // MOTIR-3763 measured the falsified `step.sleep` yield at N(N+1)/2 — 7 503
    // orchestrator reads for the ~122 polls of a thirty-minute index. Here 8
    // polls cost 8 reads; the same shape at 122 polls costs 122.
    expect(live.describes()).toBe(8);
    expect(new Set(live.outcomes)).toEqual(new Set(['deferred']));
    expect(
      (await withSystemContext((tx) =>
        jobSupervisionRepository.findByRunAndSubject(live.runId, live.projectIds[0]!, tx),
      ))!.pollNumber,
    ).toBe(8);
  });

  it('is `running` ONLY while a pass is in flight', async () => {
    const live = await liveIndexRun();
    await onePass(live);

    // Observed from INSIDE the pass, which is the only place the claimed state
    // exists — a poll of the row after the pass has settled cannot see it.
    let observed: string | null = null;
    const real = codeGraphIndexDispatchService.pollIndexContainer.bind(
      codeGraphIndexDispatchService,
    );
    vi.spyOn(codeGraphIndexDispatchService, 'pollIndexContainer').mockImplementation(
      async (session, previous, options) => {
        observed = (await readQueueRow(live.runId)).state;
        return real(session, previous, options);
      },
    );

    await makeDue(live.runId);
    await onePass(live);

    expect(observed).toBe('running');
    expect((await readQueueRow(live.runId)).state).toBe('pending');
  });
});

describe('§1.2 the ledger seam — N deferred passes and one terminal one', () => {
  it('write exactly ONE `succeeded` job_run with ONE output.repoRef, and no dead letter', async () => {
    const live = await liveIndexRun();

    // Boot, then a few polls, then let the container exit 0.
    await onePass(live);
    for (let i = 0; i < 3; i += 1) {
      await makeDue(live.runId);
      await onePass(live);
    }
    for (const id of fakeOrchestrator.liveContainerIds()) {
      fakeOrchestrator.completeJob(id, { exitCode: 0 });
    }
    await makeDue(live.runId);
    await onePass(live);

    expect((await readQueueRow(live.runId)).state).toBe('succeeded');
    const runs = await adminDb.jobRun.findMany({
      where: { functionId: 'system.code-graph-index' },
    });
    expect(runs, 'ONE ledger row for the whole supervision').toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toMatchObject({ indexed: true, repoRef: INDEX_REPO_REF });
    expect(await adminDb.jobRunDlq.count()).toBe(0);

    // The shape the enqueue gate and the onboarding wizard read
    // (`code-graph-index-fleet.md` §6): one claim, seen once.
    const claimed = await withSystemContext((tx) =>
      jobRunRepository.listSucceededCodeGraphIndexRepoRefs(live.workspaceId, tx),
    );
    expect(claimed.filter((r) => r === INDEX_REPO_REF)).toHaveLength(1);

    // And the supervision rows are gone — the table tracks LIVE supervisions.
    expect(
      await withSystemContext((tx) => jobSupervisionRepository.listByRun(live.runId, tx)),
    ).toEqual([]);
  });
});

describe('§1.3 the restart seam — a worker drained mid-supervision', () => {
  it('resumes the SAME container: no second provision, and the attempt refunded', async () => {
    const live = await liveIndexRun();
    await onePass(live);
    await makeDue(live.runId);
    await onePass(live);

    // A DRAIN is the routine case — several a day — and it releases the claim
    // and refunds the attempt. The row is already `pending` between passes, so
    // this asserts the drain finds nothing of ours stranded.
    await live.worker.shutdown();
    expect(
      await adminDb.jobQueueRun.count({ where: { state: 'running' } }),
      'no row left running with no live claimant',
    ).toBe(0);

    // A SECOND worker takes it over, exactly as another machine would.
    const second = new JobWorker({
      workerId: 'gate-worker-restarted',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      execute: async (claimed) => {
        await executeWithLedger(claimed, live.eventData);
      },
    });
    for (let i = 0; i < 3; i += 1) {
      await makeDue(live.runId);
      expect(await second.tick()).toBe(1);
      await second.settled();
    }

    // ⚠️ ONE provision across both workers. The boot replays from `job_step`
    // and the loop re-attaches — the property §13.2 records, preserved rather
    // than reimplemented.
    expect(live.provisions()).toBe(1);
    expect(fakeOrchestrator.liveContainerIds()).toHaveLength(1);
    const row = await readQueueRow(live.runId);
    expect(row.attempts, 'every suspension refunded its attempt').toBe(0);
  });
});

describe('§1.4 the teardown seam — one per exit path, and none on a defer', () => {
  it('reaches teardown on the `done` verdict, exactly once', async () => {
    const live = await liveIndexRun();
    const settle = vi.spyOn(codeGraphIndexDispatchService, 'settleIndexContainer');

    await onePass(live);
    for (let i = 0; i < 4; i += 1) {
      await makeDue(live.runId);
      await onePass(live);
    }
    // Four polls, four defers, zero teardowns — the NEGATIVE §15.4 measured.
    expect(settle).not.toHaveBeenCalled();

    for (const id of fakeOrchestrator.liveContainerIds()) {
      fakeOrchestrator.completeJob(id, { exitCode: 0 });
    }
    await makeDue(live.runId);
    await onePass(live);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('reaches teardown on the DEADLINE, measured from the memoized `bootedAt`', async () => {
    const live = await liveIndexRun();
    const settle = vi.spyOn(codeGraphIndexDispatchService, 'settleIndexContainer');
    await onePass(live);

    // Re-point the budget at a timeout the session has already outlived. The
    // clock is anchored to the SESSION, which rides the memoized boot — so the
    // next pass settles instead of polling (§13.3(a)).
    fastBudgets.indexTimeoutMs = 1;

    await makeDue(live.runId);
    await onePass(live);

    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toMatchObject({
      reason: 'job_timed_out',
      failureDetail: expect.stringContaining('deadline'),
    });
  });

  it('reaches teardown when a poll THROWS, and the run still fails', async () => {
    const live = await liveIndexRun();
    const settle = vi.spyOn(codeGraphIndexDispatchService, 'settleIndexContainer');
    await onePass(live);

    vi.spyOn(codeGraphIndexDispatchService, 'pollIndexContainer').mockRejectedValue(
      new Error('the provider went away'),
    );
    await makeDue(live.runId);
    await onePass(live);

    // Settled FIRST and the error propagated after — the arm a step reachable
    // only from the loop's two normal exits could never cover (§13.4). The
    // worker read it as a failure, not a suspension.
    expect(settle).toHaveBeenCalledTimes(1);
    expect(live.outcomes.at(-1)).toBe('retrying');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §2 · THE GUARDS
// ───────────────────────────────────────────────────────────────────────────

describe('§2.1 no timing constant lives in the driver', () => {
  it('takes its wait, its ceiling and its timeout from the caller', () => {
    // ⚠️ THE POINT IS NOT TIDINESS. A cadence with two homes is a cadence that
    // drifts, and §16.6 forbids this story moving a single value — so the
    // driver is written so that it CANNOT hold one. `waitMs`, `maxPolls` and
    // `timeoutMs` are all hooks.
    for (const path of SUPERVISION_SOURCES) {
      const code = readFileSync(path, 'utf8')
        // Strip comments: the header discusses the fleets' numbers at length,
        // and prose about a constant is not a constant.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // A duration literal is four digits or more, or any `_`-grouped number.
      expect(code, `${path} must hold no duration literal`).not.toMatch(/\b\d{4,}\b|\b\d+_\d+\b/);
    }
  });
});

describe('§2.2 the budgets are byte-identical to their pre-story values', () => {
  it('the index fleet’s, the CI fleet’s, and the admission budget', () => {
    expect(INDEX_FLEET_TIME_BUDGETS).toEqual({
      bootDeadlineMs: 120_000,
      indexTimeoutMs: 1_800_000,
      pollIntervalMs: 3_000,
      maxPollIntervalMs: 15_000,
      maxPollIterations: 500,
      maxConsecutiveReadFailures: 3,
    });
    expect(INDEX_ADMISSION_BUDGETS).toEqual({
      maxAttempts: 60,
      baseWaitMs: 5_000,
      maxWaitMs: 60_000,
    });
    expect(FLEET_TIME_BUDGETS).toEqual({
      bootDeadlineMs: 120_000,
      // ADDED by MOTIR-11230 (the idle-runner retirement), after this story; every
      // budget this story pinned is unchanged.
      idleTimeoutMs: 300_000,
      jobTimeoutMs: 3_600_000,
      pollIntervalMs: 3_000,
      maxPollIntervalMs: 30_000,
      reapAfterMs: 4_200_000,
      maxPollIterations: 2_000,
      stepWorkBudgetMs: 120_000,
      mintDeadlineMs: 15_000,
      containerCallDeadlineMs: 30_000,
    });
  });
});

describe('§2.3 §14.1’s refusal is intact', () => {
  it('`DefineJobOptions` gains no member and `claimDueRuns` gains no predicate', () => {
    // The two things §15.2's test names as deciding which side of §14.1 a change
    // is on. Two noes ⇒ untouched.
    const defineJob = readFileSync('lib/jobs/defineJob.ts', 'utf8');
    expect(defineJob).not.toMatch(/^\s*concurrency\??:/m);
    expect(defineJob).not.toMatch(/^\s*supervision\??:/m);

    const claim = readFileSync('lib/repositories/jobQueueRepository.ts', 'utf8');
    const from = claim.indexOf('async claimDueRuns');
    const statement = claim.slice(from, claim.indexOf('RETURNING', from));
    expect(statement.length, 'the claim statement must be findable').toBeGreaterThan(0);
    // The four load-bearing properties of the claim, unchanged…
    expect(statement).toMatch(/WITH due AS MATERIALIZED/);
    expect(statement).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(statement).toMatch(/ORDER BY "run_at"/);
    // …and nothing about supervision anywhere near it.
    expect(statement).not.toMatch(/supervision/i);
  });
});

describe('§2.4 exactly ONE supervision composition exists per fleet', () => {
  it('the job path and the in-process wrapper drive the same machine', () => {
    for (const path of [
      'lib/services/codeGraphIndexDispatchService.ts',
      'lib/services/ciRunnerBootService.ts',
    ]) {
      const code = readFileSync(path, 'utf8');
      // ONE call site of the shared machine per fleet — a copy-pasted second
      // composition is what MOTIR-3484 and MOTIR-3485 each spent a card
      // deleting, and it is not coming back one layer up.
      expect(code.match(/\badvanceSupervision</g) ?? [], path).toHaveLength(1);
      // And no loop left to be the second one.
      expect(code, path).not.toMatch(/for \(let iteration/);
    }
  });
});

describe('§2.5 the sweep’s cron is the sub-hourly cadence', () => {
  it('runs every 5 minutes', () => {
    const def = engineJob('system.supervision-sweep');
    expect(def).toBeDefined();
    expect(def!.cron).toBe(SUB_HOURLY_CADENCE);
  });
});

describe('§2.6 the supervision read is TENANCY-SCOPED', () => {
  it('an actor bound to one workspace sees one row out of three', async () => {
    // ⚠️ THE POPULATION AND THE VIEW MUST DIFFER, or the assertion passes
    // against a table with no policy at all.
    const live = await liveIndexRun();
    const other = await liveIndexRun();
    await withSystemContext(async (tx) => {
      await jobSupervisionRepository.open(
        {
          runId: live.runId,
          subject: 'a',
          kind: 'index',
          nextPollAt: new Date(),
          workspaceId: live.workspaceId,
        },
        tx,
      );
      await jobSupervisionRepository.open(
        {
          runId: other.runId,
          subject: 'b',
          kind: 'index',
          nextPollAt: new Date(),
          workspaceId: other.workspaceId,
        },
        tx,
      );
      await jobSupervisionRepository.open(
        {
          runId: other.runId,
          subject: 'c',
          kind: 'ci-runner',
          nextPollAt: new Date(),
          workspaceId: other.workspaceId,
        },
        tx,
      );
    });

    const scoped = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${live.workspaceId}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.jobSupervision.findMany();
    });

    expect(await adminDb.jobSupervision.count(), 'the true population').toBe(3);
    expect(
      scoped.map((r) => r.subject),
      'what the bound actor sees',
    ).toEqual(['a']);
  });
});
