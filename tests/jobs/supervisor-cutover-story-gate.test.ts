import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { defineJob } from '@/lib/jobs/defineJob';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { dispatchEventToEngine } from '@/lib/jobs/engine/dispatcher';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { engineJob, engineJobs } from '@/lib/jobs/engine/registry';
import { manifestSubscribers } from '@/lib/jobs/engine/manifest';
import { parseEventExpression, resolveEventExpression } from '@/lib/jobs/engine/eventExpression';
import { parseIdempotencyTemplate } from '@/lib/jobs/engine/idempotency';
import {
  INDEX_ADMISSION_BUDGETS,
  INDEX_FLEET_TIME_BUDGETS,
  indexAdmissionWaitMs,
  indexPollWaitMs,
} from '@/lib/services/codeGraphIndexDispatchService';
import { FLEET_TIME_BUDGETS, pollWaitMs } from '@/lib/services/ciRunnerBootService';
import { indexInFlightCap, orgIndexInFlightCap } from '@/lib/ciFleet/limits';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
// The REAL registry, for its side effect — every definition module evaluated, so
// the totality guards below walk the shipped set rather than a fixture.
import { jobDefinitions } from '@/lib/jobs/registry';

// THE STORY GATE for the CONTAINER-SUPERVISOR cutover
// (Story MOTIR-3417 · Subtask MOTIR-3486).
//
// It is NOT a second copy of the per-subtask units. MOTIR-3482 owns the decision,
// MOTIR-3483 owns the debounce, MOTIR-3484 and MOTIR-3485 own the two collapses
// and each ships its own coverage. This file does the three things none of those
// can:
//
//   §1 THE BRANCH TOP-UP — the arms of the story's own new code that no
//      per-subtask case reaches. Each was SORTED before it was written, per the
//      card: a coverage zero measures EXECUTION and says nothing about
//      REACHABILITY, so "nobody tested this" and "nothing can test this" produce
//      the same cell. Every arm below turned out to be reachable, so each gets a
//      test rather than an ignore — and the file therefore lists no dead arms.
//
//   §2 THE INTEGRATION SEAMS — the joins the units mock at one end. The four the
//      card names: debounce → worker, collapse → ledger, collapse → `job_step`,
//      and a worker RESTART re-attaching to the same container.
//
//   §3 THE GUARDS A PERCENTAGE CANNOT SEE — the budgets asserted BY VALUE
//      (a regression in the admission cap costs money), the resolver's totality,
//      both lanes still reachable, and "ONE composition" as a structural fact
//      rather than a style note.
//
// Real Postgres throughout, no mocks except the two the repo already allows.

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** The three jobs this story moves. Named once — every guard below reads it. */
const SUPERVISORS = [
  'system.code-graph-index',
  'system.code-graph-refresh',
  'system.ci-runner-boot',
] as const;

/**
 * ⚠️ EVERY `defineJob` BELOW REGISTERS A SYNTHETIC ID, NEVER A REAL ONE.
 * `registerEngineJob` OVERWRITES by id and the registry is MODULE state, so
 * redefining `system.code-graph-refresh` here would replace the shipped
 * definition's debounce — for this file, and for every later file sharing the
 * worker.
 */
let seq = 0;
function gateJobId(): string {
  seq += 1;
  return `gate.supervisor.${seq}`;
}

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

// ═══════════════════════════════════════════════════════════════════════════
// §1 — THE BRANCH TOP-UP
// ═══════════════════════════════════════════════════════════════════════════

describe('§1 the arms of the story’s own code nothing else reaches', () => {
  // ⚠️ SORTED FIRST, as the card requires. The story's surface measured
  // 100/100/100 on `debounce.ts`, `manifest.ts`, `registry.ts`,
  // `jobQueueRepository.ts` and `ciRunnerFleet.ts`; 99+ on the two services;
  // 91.66 branches on `indexFleetSteps.ts`. The two files BELOW the floor were
  // `eventExpression.ts` (85 branches) and `idempotency.ts` (75) — and for each
  // uncovered arm the question asked was what would have to be TRUE for it to
  // fire, read off the code that BUILDS the value rather than off the arm. Every
  // one is reachable from an ordinary call. None is dead, so none gets an ignore.

  it('an EMPTY expression is refused, and the message names no offending term', () => {
    // The `offendingTerm === undefined` arm. It fires only here: every other
    // refusal comes from a term the split produced, so it HAS one to quote. An
    // empty expression has no terms at all, and quoting `""` would be noise.
    const boom = () => parseEventExpression('j', 'debounce.key', '   ');
    expect(boom).toThrow(/cannot evaluate/);
    expect(boom).not.toThrow(/the term/);
  });

  it('resolves against a NULL payload without reaching for a property of null', () => {
    // The `data ?? {}` arm. `dispatchEventToEngine` is called with `null` by
    // `tests/jobs/engine-units.test.ts`, so this is not hypothetical: a field
    // term over no payload must resolve to "no key", never throw on the emit
    // path, which is POST-COMMIT on a user's mutation.
    const terms = parseEventExpression('j', 'debounce.key', 'event.data.a');
    expect(resolveEventExpression(terms, null)).toBeNull();
    expect(resolveEventExpression(terms, undefined)).toBeNull();
  });

  it('an all-EMPTY-literal expression resolves to no key rather than to ""', () => {
    // The `key.length > 0 ? key : null` arm. A key of `''` would be a non-NULL
    // value in the partial unique index, so every event of that job would
    // coalesce into one row — the exact failure the `null` contract exists to
    // avoid, arriving through the one path that produces a defined-but-empty key.
    const terms = parseEventExpression('j', 'debounce.key', "'' + ''");
    expect(terms).toEqual([
      { kind: 'literal', value: '' },
      { kind: 'literal', value: '' },
    ]);
    expect(resolveEventExpression(terms, { a: 'x' })).toBeNull();
  });

  it('refuses a COMPOSED idempotency template, though the grammar accepts one', () => {
    // The `terms.length === 1 ? … : undefined` arm. The grammar was widened for
    // the debounce key; the dedup door was deliberately NOT — a composed key has
    // no consumer in the tree, so accepting one would ship a shape nothing tests.
    expect(() => parseIdempotencyTemplate('j', "event.data.a + '/' + event.data.b")).toThrow(
      /exactly one/,
    );
  });

  it('refuses a LITERAL-ONLY idempotency template', () => {
    // The `only.kind !== 'field'` arm, and the reason the narrowing is not
    // arbitrary: a constant dedup key collides EVERY event of that job into a
    // single run, and all but the first are dropped.
    expect(() => parseIdempotencyTemplate('j', "'always-the-same'")).toThrow(/collide every event/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 — THE INTEGRATION SEAMS
// ═══════════════════════════════════════════════════════════════════════════

describe('§2a debounce → worker: the claimed run carries the LAST event', () => {
  it('coalesces a burst and hands the worker the newest payload, not the first', async () => {
    // ⚠️ THE PAIR MOST LIKELY TO DRIFT, and the card says why: the debounce card
    // asserts the ROW and the collapse cards assert the HANDLER, and nothing
    // today asserts that the row the WORKER picks up carries what the last push
    // said. A refresh indexes the repo at its default branch, so a coalesced run
    // that executed the first push's payload would index a superseded head.
    const jobId = gateJobId();
    // ⚠️ ITS OWN TRIGGER, NOT A REAL EVENT (MOTIR-3418). The probe used to
    // subscribe to a real event and be isolated by the per-job cutover switch —
    // only the routed id was enqueued. With one lane a dispatch enqueues EVERY
    // subscriber, so a shared trigger would enqueue the real consumers too and the
    // worker's tick would claim four runs instead of one.
    const trigger = `${jobId}.pushed`;
    const seen: unknown[] = [];
    defineJob(
      {
        id: jobId as never,
        trigger: trigger as never,
        debounce: { key: 'event.data.repoName', period: '2m' },
      },
      (ctx) => {
        seen.push(ctx.event.data);
        return { ok: true };
      },
    );

    for (const head of ['sha-1', 'sha-2', 'sha-3']) {
      await dispatchEventToEngine(trigger, {
        workspaceId: null,
        repoName: 'motir-core',
        head,
      });
    }

    const pending = await adminDb.jobQueueRun.findMany({ where: { jobId } });
    expect(pending).toHaveLength(1);

    // ⚠️ THE WINDOW ELAPSING, expressed as STATE rather than as a wait. `run_at`
    // in the past IS what "the quiet period passed" means to the claim, and
    // sleeping two real minutes to say so would make the assertion a race.
    await adminDb.jobQueueRun.update({
      where: { id: pending[0]!.id },
      data: { runAt: new Date(Date.now() - 1_000) },
    });

    const worker = new JobWorker({
      workerId: 'debounce-seam-worker',
      logger: silent,
      execute: async (run) => {
        const event =
          run.eventId === null
            ? null
            : await adminDb.jobEvent.findUniqueOrThrow({ where: { id: run.eventId } });
        await executeWithLedger(run, event?.data ?? null);
      },
    });
    expect(await worker.tick()).toBe(1);
    // ⚠️ `tick()` returns at the CLAIM since MOTIR-3762; `settled()` is what
    // says the handler and its ledger write are done.
    await worker.settled();

    // ONE execution, carrying the THIRD push.
    expect(seen).toHaveLength(1);
    expect((seen[0] as { head?: string }).head).toBe('sha-3');
    const ledger = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.status).toBe('succeeded');
  });
});

describe('§2b collapse → ledger: the row a supervised run leaves behind', () => {
  /** Enqueue one engine run for a synthetic job, due now. */
  async function enqueue(jobId: string, data: unknown, maxAttempts = 1) {
    const event = await adminDb.jobEvent.create({
      data: { name: jobId, data: data as never, workspaceId: null },
    });
    const run = await adminDb.jobQueueRun.create({
      data: {
        jobId,
        eventId: event.id,
        eventName: jobId,
        runAt: new Date(),
        maxAttempts,
        workspaceId: null,
      },
    });
    return { run, data };
  }

  function workerFor(): JobWorker {
    return new JobWorker({
      workerId: 'ledger-seam-worker',
      logger: silent,
      execute: async (run) => {
        const event =
          run.eventId === null
            ? null
            : await adminDb.jobEvent.findUniqueOrThrow({ where: { id: run.eventId } });
        await executeWithLedger(run, event?.data ?? null);
      },
      onTerminalFailure: async (run, error) => {
        await recordEngineTerminalFailure(run, error, {});
      },
    });
  }

  it('a run that indexed writes ONE succeeded row carrying ONE repoRef', async () => {
    // The ledger contract MOTIR-3417 refuses to let this story change, driven
    // through the REAL worker rather than through `the in-process JobTestEngine`. The shape is
    // `runIndexFleetSteps`'s return value, which `executeWithLedger` serializes
    // into `job_run.output` exactly as `defineJob` does on the other lane.
    const jobId = gateJobId();
    defineJob({ id: jobId as never, trigger: 'work-item/embedding.requested' }, () => ({
      indexed: true,
      repoRef: 'moooon/motir-core',
      projectsIndexed: 2,
    }));
    await enqueue(jobId, { workspaceId: null });

    const succeedingWorker = workerFor();
    expect(await succeedingWorker.tick()).toBe(1);
    await succeedingWorker.settled();

    const ledger = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.status).toBe('succeeded');
    expect(ledger[0]?.output).toEqual({
      indexed: true,
      repoRef: 'moooon/motir-core',
      projectsIndexed: 2,
    });
  });

  it('a container that did not index writes a FAILED row carrying the NAMED exit class', async () => {
    // The other half of the same contract. A `succeeded` row with an
    // `output.repoRef` is a permanent claim, to every reader, that the repo has a
    // code graph — so a run whose container exited non-zero must leave a FAILED
    // row, and the exit class must survive into it because it is the operator's
    // entire diagnostic channel.
    const jobId = gateJobId();
    defineJob({ id: jobId as never, trigger: 'work-item/embedding.requested' }, () => {
      throw new Error('Indexing moooon/motir-core into project p1 failed (out_of_memory): killed');
    });
    await enqueue(jobId, { workspaceId: null });

    const failingWorker = workerFor();
    await failingWorker.tick();
    await failingWorker.settled();

    const ledger = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.status).toBe('failed');
    expect(ledger[0]?.output).toBeNull();
    const dlq = await adminDb.jobRunDlq.findMany({ where: { functionId: jobId } });
    expect(JSON.stringify(dlq[0]?.failure)).toContain('out_of_memory');
  });
});

describe('§2c collapse → job_step, and §2d the worker RESTART', () => {
  /**
   * Drive one synthetic supervision through the ENGINE's real step ledger,
   * `polls` times, resuming from `resumeFrom` passes.
   *
   * The shape mirrors what `runIndexContainer` / `runIntent` now do: a memoized
   * BOOT, an un-memoized loop, a memoized SETTLE.
   */
  async function supervise(opts: { polls: number; runId?: string }) {
    const jobId = gateJobId();
    const boots: number[] = [];
    const settles: number[] = [];
    let pollCount = 0;
    defineJob({ id: jobId as never, trigger: 'work-item/embedding.requested' }, async (ctx) => {
      const session = await ctx.step.run('boot', () => {
        boots.push(1);
        return { containerId: 'c-1' };
      });
      for (let i = 1; i <= opts.polls; i += 1) pollCount += 1;
      return ctx.step.run('settle', () => {
        settles.push(1);
        return { torn: session.containerId };
      });
    });

    const run =
      opts.runId === undefined
        ? await adminDb.jobQueueRun.create({
            data: {
              jobId,
              eventName: jobId,
              runAt: new Date(),
              maxAttempts: 1,
              eventId: null,
              workspaceId: null,
            },
          })
        : await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: opts.runId } });

    const result = await executeWithLedger(run, {});
    return { jobId, runId: run.id, boots, settles, pollCount, result };
  }

  it('writes a CONSTANT number of step rows however many times it polled', async () => {
    // ⚠️ ASSERT THE NUMBER, NOT THAT IT IS "SMALL". A shape that writes one row
    // per poll and happened to poll twice would pass "small". So: the same
    // supervision at two poll counts, and the count must be identical.
    const short = await supervise({ polls: 1 });
    const long = await supervise({ polls: 40 });

    const rowsFor = async (runId: string) =>
      (await adminDb.jobStep.findMany({ where: { runId } })).filter(
        (r) => !r.stepId.startsWith('job-run:'),
      );

    expect(short.pollCount).toBe(1);
    expect(long.pollCount).toBe(40);
    expect((await rowsFor(short.runId)).map((r) => r.stepId).sort()).toEqual(['boot', 'settle']);
    expect((await rowsFor(long.runId)).map((r) => r.stepId).sort()).toEqual(['boot', 'settle']);
    // Stated as an exact number as well as a set, because the set would survive a
    // duplicate row and the count would not.
    expect(await rowsFor(long.runId)).toHaveLength(2);
  });

  it('a RESTART replays the boot rather than provisioning a second container', async () => {
    // ⚠️ THE STORY'S OWN CRITERION, and it must ACTUALLY restart. A second pass
    // over the SAME `job_queue` row is exactly what a lease reclaim produces:
    // `runQueuedJob` rebuilds the context and calls the handler from the top, and
    // `createStepApi` serves each completed step from `job_step`.
    const first = await supervise({ polls: 3 });
    expect(first.boots).toHaveLength(1);
    expect(first.settles).toHaveLength(1);

    // The reclaim itself — real, through the repository the worker uses.
    await adminDb.jobQueueRun.update({
      where: { id: first.runId },
      data: {
        state: 'running',
        claimedBy: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 1),
      },
    });
    const reclaimed = await withSystemContext((tx) => jobQueueRepository.reclaimExpiredLeases(tx));
    expect(reclaimed).toBe(1);

    const def = engineJob(first.jobId);
    const row = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: first.runId } });
    expect(def).toBeDefined();
    const replayed = await executeWithLedger(row, {});

    // ⚠️ THE ASSERTION THE CARD TURNS ON — the BOOT COUNT, not "it finished".
    // "It finished" is true of the double-boot case too.
    expect(first.boots).toHaveLength(1);
    expect(first.settles).toHaveLength(1);
    // Same answer, served from the memo — and it crossed the JSON boundary, which
    // is the shim's contract on BOTH paths so a handler cannot work in-process
    // and throw on resume.
    expect(replayed).toEqual({ torn: 'c-1' });
    // Still two step rows: the resume added none.
    const rows = (await adminDb.jobStep.findMany({ where: { runId: first.runId } })).filter(
      (r) => !r.stepId.startsWith('job-run:'),
    );
    expect(rows).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 — THE GUARDS A PERCENTAGE CANNOT SEE
// ═══════════════════════════════════════════════════════════════════════════

describe('§3 the guards', () => {
  it('every time budget survives the collapse BY VALUE', () => {
    // ⚠️ READ FROM THE SHIPPED CONSTANTS, so a collapse that quietly changed a
    // cadence fails here. MOTIR-3417 forbids any behaviour change, and a poll
    // interval is the easiest thing to "tidy" while rewriting a loop.
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
    expect(FLEET_TIME_BUDGETS.jobTimeoutMs).toBe(3_600_000);
    expect(FLEET_TIME_BUDGETS.pollIntervalMs).toBe(3_000);
    expect(FLEET_TIME_BUDGETS.maxPollIntervalMs).toBe(30_000);
    expect(FLEET_TIME_BUDGETS.maxPollIterations).toBe(2_000);
    expect(FLEET_TIME_BUDGETS.bootDeadlineMs).toBe(120_000);
    expect(FLEET_TIME_BUDGETS.reapAfterMs).toBe(4_200_000);

    // And the two backoff FUNCTIONS, which is where a cadence actually lives —
    // a constant can be right while the curve that reads it is not.
    expect([1, 2, 3, 4, 5].map((n) => indexPollWaitMs(n))).toEqual([
      3_000, 6_000, 12_000, 15_000, 15_000,
    ]);
    expect([1, 2, 3, 4, 5].map((n) => pollWaitMs(n))).toEqual([
      3_000, 6_000, 12_000, 24_000, 30_000,
    ]);
    expect([1, 2, 3, 4].map((n) => indexAdmissionWaitMs(n))).toEqual([
      5_000, 10_000, 20_000, 40_000,
    ]);
  });

  it('the ADMISSION CAP and the fleet limits are untouched', () => {
    // MOTIR-3417 names these as forbidden ground because a regression there costs
    // money — a cap that silently doubled would double the fleet's invoice with
    // every signal green. Asserted by VALUE, and by the derivation that keeps the
    // per-org bound from drifting from the global one.
    expect(indexInFlightCap()).toBe(6);
    expect(orgIndexInFlightCap(indexInFlightCap())).toBe(3);
    expect(orgIndexInFlightCap(10)).toBe(5);
  });

  it('the debounce key resolver is TOTAL — no arm silently merges unrelated events', () => {
    // `codeGraphRefresh`'s own header names the failure: an expression that does
    // not resolve MERGES on Inngest, so N unrelated repos index as one. There
    // must be no arm here that returns a shared bucket.
    for (const bad of ['event.ts', 'event.data.user.id', 'event.data.a + b', '"double"', '']) {
      expect(() => parseEventExpression('j', 'debounce.key', bad), bad).toThrow(/cannot evaluate/);
    }
    // And the shipped declaration still resolves, on a real payload.
    const declared = engineJob('system.code-graph-refresh')?.debounce;
    expect(declared).toBeDefined();
    expect(
      resolveEventExpression(
        parseEventExpression('system.code-graph-refresh', 'debounce.key', declared!.key),
        { installationId: 'i1', repoOwner: 'moooon', repoName: 'motir-core' },
      ),
    ).toBe('i1/moooon/motir-core');
  });

  it('the three supervisors are REGISTERED and reachable from the emit path', () => {
    // ⚠️ THIS ASSERTED A SWITCH (MOTIR-3418 removed that half). It checked the
    // default-to-the-old-lane safety property on the three ids this story moved,
    // then flipped the routing set and checked they moved. There is one lane now,
    // so what remains is the half that was never about the migration: the three
    // are in the engine registry, and the emit path can actually reach them.
    for (const id of SUPERVISORS) expect(engineJob(id), id).toBeDefined();

    // ⚠️ AND THEY ARE ALL EVENT-TRIGGERED, so the emit path can actually reach
    // them. A supervisor registered with no trigger would be invisible to
    // `manifestSubscribers` and nothing would ever enqueue it.
    for (const id of SUPERVISORS) {
      const def = engineJob(id)!;
      expect(def.trigger, id).toBeDefined();
      expect(
        manifestSubscribers(def.trigger!).map((d) => d.id),
        id,
      ).toContain(id);
    }
  });

  it('ONE composition per fleet — structural, not stylistic', () => {
    // ⚠️ THE THING THIS STORY DELETES MUST NOT GROW BACK BY COPY-PASTE, and only
    // a test that reads the tree can say so. A second supervision loop would pass
    // every behavioural test in the repository while re-creating the exact defect
    // the collapse removed: two compositions kept in agreement by hand.
    //
    // ⚠️ AMENDED ON THE RECORD (MOTIR-3828), and NOT relaxed — the count for the
    // index fleet moves from ONE to ZERO because the loop has left those files
    // entirely. `docs/decisions/job-queue-foundation.md` §16 makes a supervision
    // a state machine over RUNS: `advanceSupervision`
    // (`lib/jobs/supervision/driver.ts`) does one poll and defers, so there is
    // no `for (let iteration` anywhere in the index path any more.
    //
    // The PROPERTY this test is named for is unchanged and is now asserted from
    // both sides, which is strictly stronger than the count it replaces: the
    // fleet files hold NO supervision loop, and exactly ONE call site drives the
    // shared machine. A copy-pasted second composition fails whichever form it
    // takes — a loop that grew back, or a second consumer of the driver.
    //
    // ⚠️ AND THE CI ARM IS FLIPPED TOO NOW (MOTIR-3829). Both fleets are on the
    // shared machine, so both hold zero loops and one call site each — which is
    // the property this test is named for, asserted identically on both sides
    // rather than as a count that happened to be one.
    const linesMatching = (paths: string[], re: RegExp) =>
      paths.flatMap((p) =>
        readFileSync(p, 'utf8')
          .split('\n')
          .map((line, i) => ({ p, i: i + 1, line }))
          .filter((r) => re.test(r.line)),
      );
    const loops = (paths: string[]) => linesMatching(paths, /for \(let iteration/);
    const drivers = (paths: string[]) => linesMatching(paths, /\badvanceSupervision[(<]/);

    const INDEX_FILES = [
      'lib/services/codeGraphIndexDispatchService.ts',
      'lib/jobs/indexFleetSteps.ts',
      'lib/jobs/definitions/codeGraphIndex.ts',
      'lib/jobs/definitions/codeGraphRefresh.ts',
    ];
    expect(loops(INDEX_FILES)).toHaveLength(0);
    expect(drivers(INDEX_FILES)).toHaveLength(1);
    const CI_FILES = [
      'lib/services/ciRunnerBootService.ts',
      'lib/jobs/definitions/ciRunnerFleet.ts',
    ];
    expect(loops(CI_FILES)).toHaveLength(0);
    expect(drivers(CI_FILES)).toHaveLength(1);

    // And neither JOB file sleeps any more — the wait moved into the service, so
    // a `step.sleep` reappearing in a handler is the stepped shape returning.
    for (const p of [
      'lib/jobs/indexFleetSteps.ts',
      'lib/jobs/definitions/ciRunnerFleet.ts',
      'lib/jobs/definitions/codeGraphIndex.ts',
      'lib/jobs/definitions/codeGraphRefresh.ts',
    ]) {
      expect(readFileSync(p, 'utf8'), p).not.toMatch(/\bstep\.sleep\(/);
    }
  });

  it('every registered job carries the two option fields the engine now reads', () => {
    // Totality over the SHIPPED set rather than a fixture: `EngineJobDefinition`
    // keeps its optionals as `T | undefined` REQUIRED precisely so a registration
    // cannot silently drop one, and this is the runtime half of that.
    //
    // ⚠️ THE SHIPPED SET IS DERIVED FROM `jobDefinitions`, NOT FROM A PREFIX FILTER.
    // `registerEngineJob` writes to MODULE state, so the registry in a given
    // worker also holds every synthetic job any earlier test file defined —
    // including this file's own. A prefix filter would work today and would fail
    // the first time somebody names a fixture differently; `jobDefinitions` is the
    // array `lib/jobs/registry.ts` actually collects, so intersecting with it
    // names the real population by construction.
    const shipped = new Set(jobDefinitions.map((d) => d.id));
    const registered = engineJobs().filter((d) => shipped.has(d.id));
    expect(registered.length).toBe(shipped.size);
    for (const def of registered) {
      expect(Object.hasOwn(def, 'idempotency'), def.id).toBe(true);
      expect(Object.hasOwn(def, 'debounce'), def.id).toBe(true);
    }
    // Exactly five SHIPPED jobs declare a debounce: the refresh, the agent
    // instance idle timer (MOTIR-6873), whose debounce IS its 30-minute window,
    // the page embedding job (MOTIR-9571), which folds a typing burst into
    // one run per page, the production config redeploy (MOTIR-10032), which
    // folds a burst of saves into one release per repository, and the release
    // status post (MOTIR-10033), which folds a release's burst of state changes
    // into one post per release.
    expect(
      registered
        .filter((d) => d.debounce !== undefined)
        .map((d) => d.id)
        .sort(),
    ).toEqual([
      'agent-instance/idle-check',
      'hosted-release.status',
      'hosting/production-config-redeploy',
      'page/embedding.requested',
      'system.code-graph-refresh',
    ]);
  });
});
