import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine, spyOnJobDispatch, dispatchedEvents } from '../helpers/jobs';
import { db } from '@/lib/db';
import { defineJob } from '@/lib/jobs/defineJob';
import { jobDefinitions } from '@/lib/jobs/registry';
import { jobServices } from '@/lib/jobs/services';
import { jobSchedules } from '@/lib/jobs/schedules';
import { RETRY_POLICIES } from '@/lib/jobs/retries';
import {
  ciRunnerBootService,
  pollWaitMs,
  FLEET_TIME_BUDGETS,
} from '@/lib/services/ciRunnerBootService';
import { inMemorySupervisionStore } from '@/lib/jobs/supervision/driver';
import { ciRunnerBootEvent } from '@/lib/ciFleet/bootDispatch';
import { jobRunsService } from '@/lib/services/jobRunsService';
import {
  CI_RUNNER_PROVISION_SWEEP_CRON,
  ciRunnerBoot,
  ciRunnerProvisionSweep,
} from '@/lib/jobs/definitions/ciRunnerFleet';
import { FLEET_ATTRIBUTION_CRON, fleetAttribution } from '@/lib/jobs/definitions/fleetAttribution';
import { fleetAttributionService } from '@/lib/services/fleetAttributionService';
import { ciRunnerReconcileService } from '@/lib/services/ciRunnerReconcileService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createStepApi } from '@/lib/jobs/engine/step';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';

// The runner FLEET's job WIRING (Story MOTIR-1916 · MOTIR-1921).
//
// `ciRunnerBootService.test.ts` drives the provisioner itself against real
// Postgres. This file covers what that suite cannot reach: whether the three
// functions are actually SERVED, on what schedule, with which retry budget, and
// whether the handlers delegate rather than re-implement.
//
// ⚠️ AN UNREGISTERED CRON FIRES SILENTLY NEVER — no error, no ledger row, nothing
// to alert on. For a fleet whose reaper is the last thing standing between Motir
// and an unbounded invoice, "the job exists" and "the job runs" are different
// claims, and only the second one is worth anything.

/** Read a job's registered definition by re-defining it. */
function configFor(options: Parameters<typeof defineJob>[0]) {
  return defineJob(options, () => undefined);
}

/**
 * The triggering event's id, PINNED.
 *
 * ⚠️ `JobTestEngine` does not model event identity the way the executor
 * does, and the difference is load-bearing here. `individualExecution` mints a
 * fresh `runId` per replay pass and merges a fresh `createMockEvent()` UNDER
 * each supplied event, so an event handed in without an id is given a NEW one on
 * every pass. In production the id is assigned once, when the event is sent, and
 * every pass of the run sees the same one. The boot's supervision memo keys on
 * exactly that id (MOTIR-2002), so an unpinned event here would exercise a world
 * that does not exist — and would do it by failing, not by passing.
 */
const EVENT_ID = 'evt-ci-runner-boot-1';

/** The event both senders emit, from the REAL payload builder, with the id the
 *  executor would have assigned. */
function bootEvent(intentId: string, id: string = EVENT_ID) {
  return { ...ciRunnerBootEvent(intentId), id };
}

/** A settled run's outcome — a container that ran, with its cost. The shape
 *  MOTIR-1928 reads off both the ledger and Inngest's own run output. */
const SETTLED_OUTCOME = {
  outcome: 'settled',
  reason: 'job_completed',
  containerId: 'c-1',
  billableSeconds: 42,
  costUsd: '0.0042',
  bootLatencyMs: 1200,
  usage: {
    handleId: 'c-1',
    provider: 'fake',
    region: 'ams',
    orgId: 'org-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    repoFullName: 'moooon-B-V/motir-core',
    workload: 'ci_runner',
    workflowJobId: 99,
    cpuKind: 'shared',
    cpus: 2,
    memoryMb: 4096,
    createdAt: new Date('2026-08-02T10:00:00.000Z'),
    startedAt: new Date('2026-08-02T10:00:05.000Z'),
    stoppedAt: new Date('2026-08-02T10:00:47.000Z'),
    billableSeconds: 42,
    usdPerSecond: '0.0001',
    costUsd: '0.0042',
    rateEffectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    terminalState: 'stopped',
    teardownReason: 'job_completed',
  },
} as const;

/** What `defineJob` persists to `job_run.output`, and what a replayed pass
 *  returns: the JSON projection, Dates and all. */
const SETTLED_JSON = JSON.parse(JSON.stringify(SETTLED_OUTCOME)) as unknown;

/** One real, pending intent — the row the supervision memo is written to. The
 *  boot's `runIntent` is spied out in this file (the provisioner itself is
 *  driven end to end by `tests/ciFleet/ciRunnerBootService.test.ts`), so the row
 *  needs only its tenancy to be real. */
let intentId: string;

/** The per-call `jobId` counter. `runId` / `runAttempt` are fixed, so this column
 *  alone carries `@@unique([runId, runAttempt, jobId])` — and a random draw over
 *  900 values is not identity, however unique it usually happens to be
 *  (MOTIR-3845). */
let jobSeq = 0;

async function seedIntent(): Promise<string> {
  jobSeq += 1;
  const email = `fleet-jobs-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const intent = await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(44_000 + jobSeq),
      repoOwner: 'moooon-B-V',
      repoName: 'motir-core',
      requestedLabels: ['motir-runner'],
      queuedAt: new Date(Date.now() - 5_000),
    },
  });
  return intent.id;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateJobRuns();
  await truncateAuthTables();
  intentId = await seedIntent();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('all three fleet jobs are REGISTERED and reach the service through the injected bag', () => {
  it('the sweep, the boot and the attribution reconciler are all served', () => {
    expect(jobDefinitions).toContain(ciRunnerProvisionSweep);
    expect(jobDefinitions).toContain(ciRunnerBoot);
    // The reaper's schedule became the reconciler's (MOTIR-6925).
    expect(jobDefinitions).toContain(fleetAttribution);
  });

  it('the service in the bag IS the exported singleton, not a lookalike', () => {
    expect(jobServices.ciRunnerBoot).toBe(ciRunnerBootService);
  });

  it('both crons self-register in the schedule table', () => {
    // The table the schedule-health check iterates (MOTIR-1970). A cron missing
    // from it is a cron nothing is watching.
    const ids = jobSchedules().map((s) => s.functionId);
    expect(ids).toContain('system.ci-runner-provision-sweep');
    expect(ids).toContain('system.fleet-attribution');
  });
});

describe('the schedules say what they can and cannot promise', () => {
  it('the provision sweep is a BACKSTOP every 5 minutes, and says so (§6, MOTIR-6932)', () => {
    // §6 budgets p50 ≤ 30s webhook-to-start, and no cron can meet that — which is
    // why the hot path is the `workflow_job` webhook (MOTIR-1996) and a DEFERRED
    // intent is dispatched by the admission wake (MOTIR-2852). This schedule
    // covers only a dispatch dropped in transit; it runs at the sub-hourly cadence
    // every `system.*` backstop shares since the database became always-on.
    expect(CI_RUNNER_PROVISION_SWEEP_CRON).toBe('*/5 * * * *');
    const config = configFor({
      id: 'system.ci-runner-provision-sweep',
      cron: CI_RUNNER_PROVISION_SWEEP_CRON,
      catchUp: 'latest',
      retryPolicy: 'idempotent',
    });
    expect(config.cron).toBe('*/5 * * * *');
    expect(config.trigger).toBeUndefined();
  });

  it('the attribution reconciler runs every 5 minutes (MOTIR-6925)', () => {
    // It replaced the reaper's 30-minute schedule: with the 10-minute grace a
    // leaked machine lives at most grace + cadence = 15 minutes
    // (`fleet-per-org-pool.md` §5).
    expect(FLEET_ATTRIBUTION_CRON).toBe('*/5 * * * *');
  });
});

describe('the retry budgets are correctness decisions, not defaults', () => {
  it('the BOOT takes ONE attempt — a retry would boot a second container', () => {
    // ⚠️ The one retry policy in the fleet that is a correctness decision. A
    // retry mints a SECOND JIT config and boots a SECOND container for a job only
    // one runner can take; the loser idles to its timeout, billed to the tenant,
    // having done nothing. `runIntent` returns typed outcomes instead of throwing
    // precisely so the retryable failures come back through the sweep for free.
    const config = configFor({ id: 'system.ci-runner-boot', retryPolicy: 'none' });
    expect(config.maxAttempts).toBe(RETRY_POLICIES.none.maxAttempts);
    expect(config.maxAttempts).toBe(1);
  });

  it('the sweep and the reaper are IDEMPOTENT — both re-derive rather than re-assert', () => {
    const sweep = configFor({
      id: 'system.ci-runner-provision-sweep',
      cron: CI_RUNNER_PROVISION_SWEEP_CRON,
      catchUp: 'latest',
      retryPolicy: 'idempotent',
    });
    const reap = configFor({
      id: 'system.fleet-attribution',
      cron: FLEET_ATTRIBUTION_CRON,
      catchUp: 'latest',
      retryPolicy: 'idempotent',
    });
    expect(sweep.maxAttempts).toBe(RETRY_POLICIES.idempotent.maxAttempts);
    expect(reap.maxAttempts).toBe(RETRY_POLICIES.idempotent.maxAttempts);
  });
});

describe('the sweep fans out ONE event per intent', () => {
  it('sends one boot event per pending intent, carrying only the id', async () => {
    // One event per intent, never one per batch: a batch handler that died
    // halfway would leave the containers it had already booted with no
    // supervisor — the exact orphan the reaper exists to catch, manufactured on
    // purpose.
    vi.spyOn(ciRunnerBootService, 'listRunnableIntentIds').mockResolvedValue(['i1', 'i2']);
    const send = spyOnJobDispatch();

    const engine = new JobTestEngine({ function: ciRunnerProvisionSweep });
    const { result } = await engine.execute();

    expect(result).toMatchObject({ dispatched: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    // The literal, spelled out rather than compared to `ciRunnerBootEvent('i1')`
    // — this is the one place that pins the payload independently of the builder
    // that produces it. `workspaceId` is `null`, never `''`: an empty string is
    // not nullish, so it survives `defineJob`'s `?? null` and trips the ledger's
    // workspace FK, which silently costs the run its `job_run` row (MOTIR-1998).
    expect(dispatchedEvents(send)[0]).toEqual({
      name: 'system.ci-runner-boot',
      data: { intentId: 'i1', workspaceId: null },
    });
  });

  it('dispatches nothing — and sends nothing — when no intent is pending', async () => {
    vi.spyOn(ciRunnerBootService, 'listRunnableIntentIds').mockResolvedValue([]);
    const send = spyOnJobDispatch();

    const engine = new JobTestEngine({ function: ciRunnerProvisionSweep });
    const { result } = await engine.execute();

    expect(result).toMatchObject({ dispatched: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('LOGS when the batch ceiling binds — never a silent truncation', async () => {
    // A sweep that silently drops the tail reads exactly like one that had
    // nothing left to do.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(ciRunnerBootService, 'listRunnableIntentIds').mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => `i${i}`),
    );
    spyOnJobDispatch();

    const engine = new JobTestEngine({ function: ciRunnerProvisionSweep });
    await engine.execute();

    expect(warn).toHaveBeenCalledWith(
      '[ciRunnerProvisionSweep] the batch ceiling bound; more intents remain',
      { batch: 25 },
    );
  });
});

describe('the sweep records the GitHub-queue reconcile (MOTIR-10790)', () => {
  // The sweep used to record only `{ dispatched }`, so a reconcile that failed for
  // an org on every tick was visible only in the worker logs. Its per-org outcome
  // is now part of what lands on the `job_run` row.
  it('returns the per-org outcome, including an org that could not be read', async () => {
    vi.spyOn(ciRunnerBootService, 'listRunnableIntentIds').mockResolvedValue([]);
    const outcome = {
      orgs: [
        {
          org: 'motir-co',
          queued: 3,
          idleRunners: 0,
          awaiting: 1,
          added: 2,
          skippedRuns: [
            {
              repoOwner: 'motir-co',
              repoName: 'motir-meta',
              runId: '42516284826',
              status: 502,
              detail: 'Server Error',
            },
          ],
        },
        { org: 'acme', queued: 0, idleRunners: 0, awaiting: 0, added: 0, error: 'revoked' },
      ],
      added: 2,
    };
    vi.spyOn(ciRunnerReconcileService, 'reconcile').mockResolvedValue(outcome);
    spyOnJobDispatch();

    const { result } = await new JobTestEngine({ function: ciRunnerProvisionSweep }).execute();

    expect(result).toEqual({ dispatched: 0, reconcile: outcome });
  });

  it('records a reconcile that threw as an error, and still fans out the boots', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(ciRunnerBootService, 'listRunnableIntentIds').mockResolvedValue(['i1']);
    vi.spyOn(ciRunnerReconcileService, 'reconcile').mockRejectedValue(new Error('db down'));
    const send = spyOnJobDispatch();

    const { result } = await new JobTestEngine({ function: ciRunnerProvisionSweep }).execute();

    expect(result).toEqual({
      dispatched: 1,
      reconcile: { orgs: [], added: 0, error: 'db down' },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      '[ciRunnerProvisionSweep] the GitHub-queue reconcile failed',
      expect.any(Error),
    );
  });
});

describe('the boot and reap handlers DELEGATE', () => {
  it('the boot handler DELEGATES each phase to the service, and returns the settled outcome', async () => {
    const boot = vi
      .spyOn(ciRunnerBootService, 'bootIntent')
      .mockResolvedValue({ phase: 'terminal', outcome: { outcome: 'unknown_intent' } });
    const engine = new JobTestEngine({ function: ciRunnerBoot });
    // Driven with the REAL payload builder, so the handler is exercised against
    // the event the two senders actually emit rather than a hand-written double.
    const { result } = await engine.execute({ events: [bootEvent('i-42')] });

    // The handler DELEGATES: an intent id off the payload, nothing
    // re-implemented here. A `terminal` boot provisioned nothing, so there is
    // nothing to supervise or tear down and the outcome IS the run's result.
    expect(boot.mock.calls.every((c) => c[0] === 'i-42')).toBe(true);
    expect(result).toEqual({ outcome: 'unknown_intent' });
  });

  it('the boot handler DRIVES runIntent, through the durable step seam', async () => {
    // ⚠️ THIS GUARD IS INVERTED FROM WHAT IT WAS, and the inversion is the card
    // (MOTIR-3485). It used to read "the boot handler NEVER calls runIntent —
    // that would rebuild the hour-long invocation", because `runIntent`
    // supervises to the end in ONE call and that could not fit inside
    // `maxDuration`. There is no invocation ceiling to fit inside: motir-core
    // runs as a long-lived Fly process (MOTIR-2384). Having ONE composition
    // rather than two kept in agreement by hand is now the deliverable, so the
    // handler must call it — and must hand it the step seam, or the boot and the
    // teardown stop being memoized and a worker restart mints a second runner.
    //
    // ⚠️ THE ENTRY POINT MOVED (MOTIR-3829): the handler drives `advanceIntent`,
    // which does ONE poll and defers, rather than `runIntent`, which is now the
    // in-process run-to-completion wrapper for a caller with no `job_queue` row.
    // Same composition, one pass at a time — the run id it is handed is the
    // handler's own, because that is what the supervision row hangs off.
    const runIntent = vi.spyOn(ciRunnerBootService, 'advanceIntent');
    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'terminal',
      outcome: { outcome: 'unknown_intent' },
    });

    const engine = new JobTestEngine({ function: ciRunnerBoot });
    await engine.execute({ events: [bootEvent(intentId)] });

    expect(runIntent).toHaveBeenCalled();
    expect(runIntent.mock.calls[0]![0], 'the run the supervision hangs off').toBeTruthy();
    expect(runIntent.mock.calls[0]![1]).toBe(intentId);
    expect(
      runIntent.mock.calls[0]![2]?.steps,
      'the handler must supply the durable seam',
    ).toBeDefined();
  });

  it('the attribution reconciler delegates, then sweeps stale claims and vanished containers (MOTIR-6925, MOTIR-9347)', async () => {
    const reconcile = vi
      .spyOn(fleetAttributionService, 'reconcile')
      .mockResolvedValue({ outcome: 'disabled' });
    const sweep = vi.spyOn(ciRunnerBootService, 'sweepStaleClaims').mockResolvedValue(1);
    const vanished = vi.spyOn(ciRunnerBootService, 'sweepVanishedInFlight').mockResolvedValue(2);

    const engine = new JobTestEngine({ function: fleetAttribution });
    const { result } = await engine.execute();

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(vanished).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      reconciled: { outcome: 'disabled' },
      staleClaims: 1,
      vanishedInFlight: 2,
    });
  });

  it('the reconciler runs end to end against a real (empty) database', async () => {
    // No spy: the REAL service runs. With no fleet configured it is inert, which
    // is the assertion — a self-hosted deployment must not error every five
    // minutes for want of a Fly token.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_INVENTORY_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    try {
      const engine = new JobTestEngine({ function: fleetAttribution });
      const { result } = await engine.execute();
      expect(result).toEqual({
        reconciled: { outcome: 'disabled' },
        staleClaims: 0,
        vanishedInFlight: 0,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a reconciler run lands one succeeded, UNTENANTED ledger row', async () => {
    vi.spyOn(fleetAttributionService, 'reconcile').mockResolvedValue({ outcome: 'disabled' });
    vi.spyOn(ciRunnerBootService, 'sweepStaleClaims').mockResolvedValue(0);
    vi.spyOn(ciRunnerBootService, 'sweepVanishedInFlight').mockResolvedValue(0);

    const engine = new JobTestEngine({ function: fleetAttribution });
    await engine.execute();

    const runs = await adminDb.jobRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      functionId: 'system.fleet-attribution',
      eventName: 'scheduled.system.fleet-attribution',
      status: 'succeeded',
      workspaceId: null,
      failure: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MOTIR-1998 — the BOOT's ledger row.
//
// The boot is the one job in the system that spends real money per invocation,
// and until this card it wrote NO `job_run` row at all: the event carried
// `workspaceId: ''`, which is not nullish, so it survived `defineJob`'s
// `?? null`, reached `job_run.workspace_id`, tripped the workspace FK (`P2003`)
// and was swallowed by `isVanishedRunError` — the catch that exists for a
// genuinely vanished tenant (MOTIR-1545). No start, no outcome, no duration,
// nothing for MOTIR-1928's live verification to read.
//
// So these assert the ROW, read back out of real Postgres. Asserting the send
// (what the earlier suites do, correctly, for the fan-out) cannot see this bug:
// the event went out perfectly every time.
// ─────────────────────────────────────────────────────────────────────────────
describe('a BOOT run is READABLE on the job_run ledger', () => {
  it('lands EXACTLY ONE succeeded, untenanted row for the event both senders emit', async () => {
    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'terminal',
      outcome: { outcome: 'unknown_intent' },
    });

    const engine = new JobTestEngine({ function: ciRunnerBoot });
    // The REAL payload builder — the whole defect lived in the payload, so a
    // hand-written event here would test the fix out of existence.
    await engine.execute({ events: [bootEvent(intentId)] });

    const runs = await adminDb.jobRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      functionId: 'system.ci-runner-boot',
      eventName: 'system.ci-runner-boot',
      status: 'succeeded',
      // Untenanted — the fleet is cross-tenant, exactly like the reaper above.
      // This is the assertion that was `0 rows` before MOTIR-1998.
      workspaceId: null,
      failure: null,
    });
  });

  it("carries the run's OUTCOME as the row's output, so a settled run is readable end to end", async () => {
    // The audit trail `ciRunnerFleet.ts` promises: the container's id, its
    // billable seconds and its cost, on the ledger, for a post-incident read.
    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'supervising',
      session: SESSION,
    });
    vi.spyOn(ciRunnerBootService, 'pollOnce').mockResolvedValue({
      done: true,
      reason: 'job_completed',
      startedAt: NOT_DONE.startedAt,
      bootLatencyMs: NOT_DONE.bootLatencyMs,
      failureDetail: null,
    });
    vi.spyOn(ciRunnerBootService, 'settleSupervision').mockResolvedValue(SETTLED_OUTCOME);

    superviseFast();
    const engine = new JobTestEngine({ function: ciRunnerBoot });
    await engine.execute({ events: [bootEvent(intentId)] });

    const run = await adminDb.jobRun.findFirstOrThrow();
    expect(run.status).toBe('succeeded');
    // `defineJob` JSON-round-trips the handler's return value into `output`, so
    // the Dates land as ISO strings — assert the persisted shape, not the
    // in-memory one.
    expect(run.output).toEqual(SETTLED_JSON);
    const output = run.output as { billableSeconds: number; costUsd: string; containerId: string };
    expect(output.billableSeconds).toBe(42);
    expect(output.costUsd).toBe('0.0042');
    expect(output.containerId).toBe('c-1');
  });

  it("an EMPTY-STRING workspaceId writes no row at all — the failure mode, pinned so it can't come back quietly", async () => {
    // Characterization, not aspiration: this is what `''` DOES, and why the
    // payload's type is `null` rather than `string`. `recordStart` returning
    // `null` is the P2003 catch doing its job for a tenant that really is gone
    // (MOTIR-1545) — the bug was feeding it a value that is never a tenant.
    const started = await jobRunsService.recordStart({
      workspaceId: '',
      functionId: 'system.ci-runner-boot',
      eventName: 'system.ci-runner-boot',
      eventId: 'evt-empty',
      lane: 'engine',
      attempt: 0,
    });
    expect(started).toBeNull();
    const jobRunCount = await adminDb.jobRun.count({ where: { eventId: 'evt-empty' } });
    expect(jobRunCount).toBe(0);

    // The identical call with `null` — the shipped value — persists.
    const untenanted = await jobRunsService.recordStart({
      workspaceId: null,
      functionId: 'system.ci-runner-boot',
      eventName: 'system.ci-runner-boot',
      eventId: 'evt-null',
      lane: 'engine',
      attempt: 0,
    });
    expect(untenanted).not.toBeNull();
    const jobRunCount2 = await adminDb.jobRun.count({ where: { eventId: 'evt-null' } });
    expect(jobRunCount2).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEARDOWN IS REACHED ON EVERY PATH OUT OF THE LOOP — MOTIR-2007's guarantee,
// RE-PROVEN after MOTIR-3485 changed the mechanism that holds it.
//
// The original defect: supervision watched a container synchronously for up to
// 3,600s inside ONE invocation whose ceiling was `maxDuration = 300`. Every CI
// job over ~5 minutes was killed mid-loop — no teardown, no usage row, a
// dead-lettered run for a job that had passed, and an intent holding a fleet slot
// against the fail-CLOSED ceiling until the reaper aged it out 70 minutes later.
// MOTIR-2007 fixed it by making the wait a `ctx.step.sleep`, and this section's
// assertion used to be that a run whose SLEEPS ALREADY SUM PAST `maxDuration`
// still reaches its teardown STEP.
//
// ⚠️ THAT PREMISE HAS EXPIRED AND THE GUARANTEE HAS NOT. There is no invocation
// ceiling to outlive — motir-core is a long-lived Fly process (MOTIR-2384) — so
// "sums past `maxDuration`" is no longer a meaningful quantity, and the teardown
// is an ordinary `finally` rather than a step reachable from two exits.
// `docs/decisions/job-queue-foundation.md` §13.4 requires the property be
// RE-PROVEN per exit path rather than inherited, because a `finally` reaches a
// THIRD exit the stepped form never could. So the three cases below are: a `done`
// verdict, the iteration CEILING, and a THROW from inside the loop.
//
// ⚠️ AND THE WAITS ARE REAL `await`s NOW, so the cadence has to be shortened or a
// twenty-poll test sleeps for minutes. `superviseFast()` does it through the
// service's own options seam and changes nothing else — the composition, the
// steps and the ledger are all real. (It replaces `sleepSteps()`, which
// pre-fulfilled `supervise-wait:<n>` state because an un-stubbed `step.sleep`
// hangs `JobTestEngine` forever. There are no sleeps left to stub.)
// ─────────────────────────────────────────────────────────────────────────────

/** Millisecond poll cadence for a job-level test, and an optional per-pass ceiling. */
function superviseFast(over: { maxPollIterations?: number } = {}) {
  const fast = { pollIntervalMs: 1, maxPollIntervalMs: 2, ...over };
  // The IN-PROCESS composition — scripts, harnesses, and this suite's own
  // service-level tests.
  const runReal = ciRunnerBootService.runIntent.bind(ciRunnerBootService);
  vi.spyOn(ciRunnerBootService, 'runIntent').mockImplementation((id, options) =>
    runReal(id, { ...fast, ...options }),
  );

  // ⚠️ AND THE JOB'S ONE-PASS ENTRY (MOTIR-3829), which is what
  // `system.ci-runner-boot` actually calls now. Two things are injected, and
  // both are test-only uses of a seam the service already exposes: the
  // millisecond budgets, and an IN-MEMORY supervision store — because
  // `JobTestEngine` synthesises a `runId` rather than claiming a real
  // `job_queue` row, and the durable store's row FKs to that table. The store
  // carries a supervision's poll count and observation across passes, and
  // `JobTestEngine` drives those passes; together they model the engine
  // faithfully without a worker.
  const supervisionStore = inMemorySupervisionStore();
  const advanceReal = ciRunnerBootService.advanceIntent.bind(ciRunnerBootService);
  return vi
    .spyOn(ciRunnerBootService, 'advanceIntent')
    .mockImplementation((runId, id, options) =>
      advanceReal(runId, id, { ...fast, supervisionStore, ...options }),
    );
}

/** A supervising session — the JSON shape `bootIntent` hands across the step
 *  boundary. Only the fields the loop and the teardown read need to be real. */
const SESSION = {
  intentId: 'i-long',
  handle: {
    provider: 'fake' as const,
    id: 'c-1',
    region: 'ams',
    createdAt: '2026-08-02T10:00:00.000Z',
  },
  githubRunnerId: 9001,
  // ⚠️ `bootedAt` IS FRESH, and the rest of the fixture's instants are not
  // (MOTIR-3829). The supervision driver evaluates the SESSION-ANCHORED deadline
  // itself, before it polls — `docs/decisions/job-queue-foundation.md` §13.3(a),
  // so a resumed pass settles a container already past `jobTimeoutMs` instead of
  // watching it for another N polls. A session frozen at 2026-08-02 is one that
  // timed out weeks ago, so every test here would settle before its first poll.
  //
  // It used to be frozen and it used to be harmless, because these tests mock
  // `pollOnce` and the old deadline check lived INSIDE it — so nothing ever
  // evaluated it. That is a fixture that was only correct while the check was
  // somewhere the mock covered.
  bootedAt: new Date().toISOString(),
  queuedAt: '2026-08-02T09:59:55.000Z',
  attribution: {
    orgId: 'org-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    repoFullName: 'moooon-B-V/motir-core',
    workload: 'ci_runner',
    workflowJobId: 99,
  },
};

const NOT_DONE = {
  done: false as const,
  startedAt: '2026-08-02T10:00:05.000Z',
  bootLatencyMs: 1200,
  consecutiveReadFailures: 0,
};

describe('a container that outlives many polls still reaches teardown', () => {
  /** How many polls the SHIPPED cadence would have needed to span an hour-long job. */
  function pollsToSpanAJob(): number {
    let elapsed = 0;
    let polls = 0;
    while (elapsed <= FLEET_TIME_BUDGETS.jobTimeoutMs) {
      polls += 1;
      elapsed += pollWaitMs(polls);
    }
    return polls;
  }

  it('supervises across MANY polls, then settles — on a `done` verdict', async () => {
    const polls = pollsToSpanAJob();
    // Sanity on the premise: at the shipped cadence this really is a full-length
    // CI job's worth of supervision, not two polls in a trench coat. The number
    // is derived from `jobTimeoutMs` rather than from `maxDuration`, which is the
    // correction — the container's hard kill is the quantity that still exists.
    const scheduled = Array.from({ length: polls }, (_, i) => pollWaitMs(i + 1)).reduce(
      (a, b) => a + b,
      0,
    );
    expect(scheduled).toBeGreaterThan(FLEET_TIME_BUDGETS.jobTimeoutMs);
    superviseFast();

    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'supervising',
      session: SESSION,
    });
    // Not terminal until the very last poll — a container that ran for longer
    // than the supervisor's own invocation could possibly have lasted.
    const poll = vi.spyOn(ciRunnerBootService, 'pollOnce');
    for (let i = 1; i < polls; i += 1) poll.mockResolvedValueOnce(NOT_DONE);
    poll.mockResolvedValue({
      done: true,
      reason: 'job_completed',
      startedAt: NOT_DONE.startedAt,
      bootLatencyMs: NOT_DONE.bootLatencyMs,
      failureDetail: null,
    });
    const settle = vi
      .spyOn(ciRunnerBootService, 'settleSupervision')
      .mockResolvedValue(SETTLED_OUTCOME);

    const engine = new JobTestEngine({ function: ciRunnerBoot });
    const { result } = await engine.execute({ events: [bootEvent(intentId)] });

    // ⚠️ TEARDOWN RAN, and it ran ONCE. This is the line MOTIR-2007 exists for:
    // before it, the supervising invocation was killed here and `settleIntent` /
    // `recordContainerUsage` / `deregisterQuietly` never happened at all. It is
    // still exactly once because `settle-runner` is a MEMOIZED step, which is
    // what an Inngest replay pass cannot re-execute.
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toMatchObject({ done: true, reason: 'job_completed' });
    // It really did poll many times rather than collapsing into one. Not EXACTLY
    // `polls`: Inngest re-invokes the handler from the top at each step boundary,
    // and the loop is ordinary code between two steps, so a replay pass re-enters
    // it. Those reads are idempotent and the outcome is memoized; the engine,
    // which does not re-invoke from the top, runs the loop once.
    expect(poll.mock.calls.length).toBeGreaterThanOrEqual(polls);
    // And the run REPORTS the settled outcome — no dead-letter, no
    // `FUNCTION_INVOCATION_TIMEOUT` for a job that succeeded. Compared through
    // the JSON projection because that is what BOTH surfaces apply: Inngest
    // serializes the function's return value, and `defineJob` round-trips the
    // same value into `job_run.output`. The in-process engine hands back the
    // live object, Dates and all, so projecting here is what makes the
    // assertion about production rather than about the harness.
    expect(JSON.parse(JSON.stringify(result))).toEqual(SETTLED_JSON);
  }, 30_000);

  it('the ledger row reads SUCCEEDED with the settled outcome, not a platform kill', async () => {
    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'supervising',
      session: SESSION,
    });
    vi.spyOn(ciRunnerBootService, 'pollOnce').mockResolvedValueOnce(NOT_DONE).mockResolvedValue({
      done: true,
      reason: 'job_completed',
      startedAt: NOT_DONE.startedAt,
      bootLatencyMs: NOT_DONE.bootLatencyMs,
      failureDetail: null,
    });
    vi.spyOn(ciRunnerBootService, 'settleSupervision').mockResolvedValue(SETTLED_OUTCOME);

    superviseFast();
    const engine = new JobTestEngine({ function: ciRunnerBoot });
    await engine.execute({ events: [bootEvent(intentId)] });

    const run = await adminDb.jobRun.findFirstOrThrow();
    expect(run.status).toBe('succeeded');
    // The audit trail MOTIR-1928 reads on live infrastructure: the container's
    // id, its billable seconds and its cost — for a job that used to
    // dead-letter with no step output at all.
    expect(run.output).toEqual(SETTLED_JSON);
  });

  it('EVERY phase runs exactly once across the whole run — memoization, not a memo column', async () => {
    // ⚠️ WHAT RETIRES MOTIR-2002. Its `supervision_key` / `supervision_outcome`
    // columns existed only because the supervision sat OUTSIDE a step and so
    // re-executed on every durable-replay pass. With each phase inside a step,
    // Inngest's memoization gives once-per-run for free — including the
    // admission claim inside `bootIntent`, which is the one that costs money.
    const boot = vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'supervising',
      session: SESSION,
    });
    vi.spyOn(ciRunnerBootService, 'pollOnce').mockResolvedValue({
      done: true,
      reason: 'job_completed',
      startedAt: NOT_DONE.startedAt,
      bootLatencyMs: NOT_DONE.bootLatencyMs,
      failureDetail: null,
    });
    const settle = vi
      .spyOn(ciRunnerBootService, 'settleSupervision')
      .mockResolvedValue(SETTLED_OUTCOME);

    superviseFast();
    const engine = new JobTestEngine({ function: ciRunnerBoot });
    const { result } = await engine.execute({ events: [bootEvent(intentId)] });

    // ⚠️ STILL EXACTLY ONCE EACH, and the reason is unchanged: both sit inside
    // memoized steps, which a replay pass serves from `job_step` rather than
    // re-executing. The loop between them re-enters on every pass; the two
    // operations that COST money do not.
    expect(boot).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    // Both surfaces agree — what MOTIR-2002 was restoring by other means, now a
    // property of the shape. Through the JSON projection both of them apply.
    const ledger = await adminDb.jobRun.findFirstOrThrow();
    expect(JSON.parse(JSON.stringify(result))).toEqual(SETTLED_JSON);
    expect(ledger.output).toEqual(JSON.parse(JSON.stringify(result)));
  });

  it('the static iteration CEILING still tears down — the loop cannot exit any other way', async () => {
    // ⚠️ THE BACKSTOP ON THE BACKSTOP. `pollOnce` normally ends the loop on the
    // job timeout, but that is a CLOCK decision; this ceiling holds if the clock
    // does something surprising (a frozen `now`, a provider that never reports
    // terminal). A durable loop with no static bound is a runaway that bills per
    // iteration — and, worse, one that exits without teardown.
    //
    // ⚠️ LOWERED THROUGH THE OPTIONS SEAM, not by redefining the exported
    // constant. The loop reads its ceiling from `options.maxPollIterations ??
    // MAX_POLL_ITERATIONS` and clamps to the shipped value, so a test may lower
    // it and cannot raise it — which is a better shape than mutating a frozen
    // budget object and restoring it in a `finally`.
    superviseFast({ maxPollIterations: 3 });
    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'supervising',
      session: SESSION,
    });
    // NEVER terminal — the pathological case the ceiling exists for.
    const poll = vi.spyOn(ciRunnerBootService, 'pollOnce').mockResolvedValue(NOT_DONE);
    const settle = vi
      .spyOn(ciRunnerBootService, 'settleSupervision')
      .mockResolvedValue(SETTLED_OUTCOME);

    const engine = new JobTestEngine({ function: ciRunnerBoot });
    await engine.execute({ events: [bootEvent(intentId)] });

    // Three per pass, and the pass count is Inngest's business (see the note on
    // the `done`-verdict case above). What matters is that the loop ENDED rather
    // than running to the shipped 2,000.
    expect(poll.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(poll.mock.calls.length).toBeLessThan(FLEET_TIME_BUDGETS.maxPollIterations);
    // The container is still torn down, with a verdict that SAYS why rather
    // than reporting a clean completion it never observed.
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toMatchObject({
      done: true,
      reason: 'job_timed_out',
      failureDetail: expect.stringContaining('poll ceiling'),
    });
  });

  it('a boot that provisioned NOTHING never polls and never tears down', async () => {
    // No container means nothing to supervise. The run ends at the boot step —
    // and must not schedule a teardown for a container that does not exist.
    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'terminal',
      outcome: { outcome: 'gate_deferred', reason: 'plan_cap', detail: 'at the cap' },
    });
    const poll = vi.spyOn(ciRunnerBootService, 'pollOnce');
    const settle = vi.spyOn(ciRunnerBootService, 'settleSupervision');

    const engine = new JobTestEngine({ function: ciRunnerBoot });
    const { result } = await engine.execute({ events: [bootEvent(intentId)] });

    expect(poll).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: 'gate_deferred',
      reason: 'plan_cap',
      detail: 'at the cap',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE COLLAPSE MUST NOT LOSE (MOTIR-3485) — the three properties whose
// MECHANISM changed, each re-proven rather than inherited.
//
// `docs/decisions/job-queue-foundation.md` §13.4 names them: teardown on every
// exit path (a `finally` now, not a step reachable from two exits), the boot
// happening once across a restart (memoization, unchanged), and this job's
// SINGLE attempt surviving a worker restart (the reclaim's refund).
// ─────────────────────────────────────────────────────────────────────────────

describe('the guarantees the collapse changed the mechanism of', () => {
  /** One `job_queue` row for this job, plus the ENGINE step API bound to it. */
  async function engineRun() {
    const run = await adminDb.jobQueueRun.create({
      data: {
        jobId: 'system.ci-runner-boot',
        eventName: 'system.ci-runner-boot',
        runAt: new Date(),
        // `retryPolicy: 'none'` — ONE attempt, which is what makes the refund
        // below a correctness property rather than a nicety.
        maxAttempts: 1,
        eventId: null,
        workspaceId: null,
      },
    });
    return { runId: run.id, steps: createStepApi({ runId: run.id, workspaceId: null }) };
  }

  const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 2 } as const;
  const DONE_VERDICT = {
    done: true as const,
    reason: 'job_completed' as const,
    startedAt: NOT_DONE.startedAt,
    bootLatencyMs: NOT_DONE.bootLatencyMs,
    failureDetail: null,
  };

  it('writes a CONSTANT number of step rows however many times it polled', async () => {
    // The property the collapse buys, and a regression in it is silent because
    // the run still succeeds. The old shape wrote a sleep checkpoint AND a result
    // row per poll — 2,400 steps for one hour-long CI job, by
    // `MAX_POLL_INTERVAL_MS`'s own comment.
    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'supervising',
      session: SESSION,
    });
    vi.spyOn(ciRunnerBootService, 'settleSupervision').mockResolvedValue(SETTLED_OUTCOME);
    const poll = vi.spyOn(ciRunnerBootService, 'pollOnce');
    for (let i = 0; i < 7; i += 1) poll.mockResolvedValueOnce(NOT_DONE);
    poll.mockResolvedValue(DONE_VERDICT);

    const { runId, steps } = await engineRun();
    await ciRunnerBootService.runIntent('i-const', { ...FAST, steps });

    expect(poll.mock.calls.length).toBe(8);
    const rows = await adminDb.jobStep.findMany({ where: { runId } });
    expect(rows.map((r) => r.stepId).sort()).toEqual(['boot-runner', 'settle-runner']);
    // Not a sleep checkpoint among them — the row kind the old shape wrote once
    // per poll.
    expect(rows.every((r) => r.kind === 'run')).toBe(true);
  });

  it('tears down when a poll THROWS from inside the loop — the exit a step could not reach', async () => {
    // ⚠️ THE THIRD EXIT PATH, and the one that is NEW. The stepped form reached
    // teardown from the loop's two normal exits (a `done` verdict, the iteration
    // ceiling) and could not reach it from a throw at all: the Inngest executor
    // finalizes a terminally-failed step before anything scheduled from a `catch`
    // could run (PRODECT_FINDINGS #39). An ordinary `finally` does reach it.
    //
    // `pollOnce` is contracted never to throw, and that contract is unchanged and
    // still the primary guarantee — this asserts the BACKSTOP behind it, because
    // §13.4 requires the property be re-proven for the mechanism that now holds
    // it rather than inherited from the one that used to.
    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'supervising',
      session: SESSION,
    });
    const settle = vi
      .spyOn(ciRunnerBootService, 'settleSupervision')
      .mockResolvedValue(SETTLED_OUTCOME);
    vi.spyOn(ciRunnerBootService, 'pollOnce')
      .mockResolvedValueOnce(NOT_DONE)
      .mockRejectedValue(new Error('the provider adapter blew up mid-loop'));

    const { runId, steps } = await engineRun();

    // The error still propagates — a supervision that failed must not report a
    // clean outcome — but the container is destroyed on the way out.
    await expect(ciRunnerBootService.runIntent('i-throw', { ...FAST, steps })).rejects.toThrow(
      /blew up mid-loop/,
    );

    expect(settle).toHaveBeenCalledTimes(1);
    // With the ceiling verdict, because no poll ever returned `done` — so the
    // settled intent SAYS supervision ended without observing a completion,
    // rather than reporting one it never saw.
    expect(settle.mock.calls[0]![1]).toMatchObject({ done: true, reason: 'job_timed_out' });
    const rows = await adminDb.jobStep.findMany({ where: { runId } });
    expect(rows.map((r) => r.stepId).sort()).toEqual(['boot-runner', 'settle-runner']);
  });

  it('a worker RESTART resumes the same container and boots exactly once', async () => {
    // The restart, driven rather than simulated: two passes over the SAME
    // `job_queue` row, which is exactly what a lease reclaim produces — the
    // runner rebuilds the context and calls the handler from the top, and the
    // shim serves each completed step from `job_step`.
    const boot = vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'supervising',
      session: SESSION,
    });
    const settle = vi
      .spyOn(ciRunnerBootService, 'settleSupervision')
      .mockResolvedValue(SETTLED_OUTCOME);
    const poll = vi.spyOn(ciRunnerBootService, 'pollOnce');
    // Pass one dies mid-supervision, after the boot step has been memoized.
    poll.mockRejectedValueOnce(new Error('the worker went away'));

    const { runId, steps } = await engineRun();
    await expect(ciRunnerBootService.runIntent('i-restart', { ...FAST, steps })).rejects.toThrow(
      /went away/,
    );
    expect(boot).toHaveBeenCalledTimes(1);

    // ⚠️ A SECOND STEP API OVER THE SAME RUN — a different worker process, the
    // same durable ledger. Nothing in `createStepApi` is per-process except the
    // scope it is built from, which is the queue row's id.
    const resumed = createStepApi({ runId, workspaceId: null });
    poll.mockResolvedValue(DONE_VERDICT);
    const outcome = await ciRunnerBootService.runIntent('i-restart', {
      ...FAST,
      steps: resumed,
    });

    // ⚠️ THE ASSERTION THE CARD TURNS ON. `bootIntent` admits, claims the intent,
    // MINTS A GITHUB RUNNER REGISTRATION and provisions a machine. Running it
    // twice would leave a second runner registered and a second machine billed —
    // and it did not run twice, because the boot sits inside a memoized step and
    // the resumed pass replayed it.
    expect(boot).toHaveBeenCalledTimes(1);
    // The resumed pass supervised the SAME session, out of that memo.
    expect(poll.mock.calls.at(-1)![0]).toMatchObject({ intentId: SESSION.intentId });
    // Through the JSON projection, because the resumed pass reads the outcome
    // back OUT of `job_step` — the shim's documented contract, which applies
    // `roundTrip` to what it RETURNS as well as to what it stores so that a
    // handler cannot work in-process and throw on resume.
    expect(JSON.parse(JSON.stringify(outcome))).toEqual(SETTLED_JSON);
    // And the settle ran once across BOTH passes: the first pass's `finally`
    // wrote it, and the second replayed it.
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("and the restart does NOT consume this job's single attempt", async () => {
    // ⚠️ THE ONE JOB IN THE FLEET WHERE THIS IS A CORRECTNESS PROPERTY.
    // `retryPolicy: 'none'` is a budget of exactly ONE, so if a worker restart
    // spent it, a deploy mid-CI-job would dead-letter a run that was fine — the
    // MOTIR-2007 outcome by another route. Asserted against the worker's REAL
    // reclaim path, not against the comment that claims it.
    const { runId } = await engineRun();

    const claimed = await withSystemContext((tx) =>
      jobQueueRepository.claimDueRuns('worker-a', 5, 1, tx),
    );
    expect(claimed.map((r) => r.id)).toContain(runId);
    // The claim SPENDS the attempt — which is what makes the refund necessary.
    expect((await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: runId } })).attempts).toBe(
      1,
    );

    // The worker dies: its 1 ms lease expires and a live worker reclaims the row.
    await adminDb.jobQueueRun.update({
      where: { id: runId },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });
    await withSystemContext((tx) => jobQueueRepository.reclaimExpiredLeases(tx));

    const after = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: runId } });
    expect(after.state).toBe('pending');
    // REFUNDED. The budget is intact, so the resumed run is a resume rather than
    // a dead-letter.
    expect(after.attempts).toBe(0);
    expect(after.attempts).toBeLessThan(after.maxAttempts);
  });
});
