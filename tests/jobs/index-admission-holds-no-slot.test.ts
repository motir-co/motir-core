// MOTIR-10600 — an index run queued for admission holds NO worker slot.
//
// On 2026-11-07 ten `system.code-graph-refresh` runs queued for admission held
// all ten of the worker's slots for up to an hour each: the admission backoff
// slept IN PROCESS inside the `index-admit:` step. Nothing else ran — 1 822
// GitHub webhook deliveries queued behind them, no cron fire was written, and
// every restart handed the same ten rows to the next worker.
//
// This suite is that incident on a real Postgres, through the REAL worker, the
// real ledger and the registered handler. The admission is refused through the
// real gate, by the operator's kill switch (`MOTIR_FLEET_MAX_IN_FLIGHT=0`, a
// `fleet_ceiling` deferral that IS waited on), so nothing about admission is
// mocked. The only seams are the millisecond budgets — and they are what made
// the old shape hang: a 5 s first wait is enough to keep a pass in its slot.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { JobWorker, POOL_SIZE } from '@/lib/jobs/engine/worker';
import type { JobQueueRun } from '@/generated/prisma/client';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import '@/lib/jobs/registry';
import { INDEX_NO_ACCOUNT_PAUSE_REASON } from '@/lib/ciFleet/indexAllowance';
import { fleetKindOnPool, wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { indexFleetOnPool } from '@/lib/ciFleet/limits';
import {
  codeGraphIndexDispatchService,
  INDEX_ADMISSION_BUDGETS,
} from '@/lib/services/codeGraphIndexDispatchService';
import { fakeOrchestrator } from '@motir/orchestrator';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  refreshEventFor,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

/** The shipped first admission wait — what a queued run waits before it asks again. */
const FIRST_WAIT_MS = INDEX_ADMISSION_BUDGETS.baseWaitMs;

let budgets: Record<string, number> = {};

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetTarballBodyTrap();
  stubIndexFleet();
  budgets = {};
  const real = codeGraphIndexDispatchService.advanceIndexContainer.bind(
    codeGraphIndexDispatchService,
  );
  vi.spyOn(codeGraphIndexDispatchService, 'advanceIndexContainer').mockImplementation(
    (runId, input, options) => real(runId, input, { ...budgets, ...options }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  wireFleetKindSwitch('code_graph_index', indexFleetOnPool);
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

/**
 * An instant that is due by the DATABASE's clock too. The claim compares
 * `run_at <= now()` in Postgres, and a host clock even a few milliseconds ahead
 * of the database's would make a row stamped `new Date()` not yet due.
 */
function dueNow(): Date {
  return new Date(Date.now() - 1_000);
}

/** One `system.code-graph-refresh` row, due now, for a freshly seeded workspace. */
async function queueRefresh(): Promise<{ runId: string; data: unknown }> {
  seq += 1;
  const { workspaceId, installationId } = await seedIndexWorkspace(`adm${seq}`, 1);
  const event = refreshEventFor({ installationId, workspaceId, eventId: `evt-adm-${seq}` });
  const jobEvent = await adminDb.jobEvent.create({
    data: { name: event.name, data: event.data as object, workspaceId },
  });
  const run = await adminDb.jobQueueRun.create({
    data: {
      jobId: 'system.code-graph-refresh',
      eventId: jobEvent.id,
      eventName: event.name,
      workspaceId,
      runAt: new Date(Date.now() - 60_000 + seq),
      maxAttempts: 3,
    },
  });
  return { runId: run.id, data: event.data };
}

/**
 * The worker the incident ran on: the shipped pool size, the real ledger around
 * the registered handler for the index runs, and a recording handler for the
 * one ordinary job that queued behind them.
 */
function incidentWorker(
  eventData: Map<string, unknown>,
  ordinary: string[],
  scheduled: string[] | null,
) {
  return new JobWorker({
    workerId: `adm-worker-${seq}`,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    execute: async (claimed: JobQueueRun) => {
      if (claimed.jobId === 'system.code-graph-refresh') {
        await executeWithLedger(claimed, eventData.get(claimed.id));
        return;
      }
      ordinary.push(claimed.jobId);
    },
    onTerminalFailure: async (claimed, err) => {
      await recordEngineTerminalFailure(claimed, err, eventData.get(claimed.id));
    },
    onSchedulerTick: async () => {
      if (!scheduled) return;
      // A fixed instant in the past: always due, and one fire however often it ticks.
      const fire = new Date(Date.UTC(2026, 10, 7, 20, 30, 0));
      const queued = await withSystemContext((tx) =>
        jobQueueRepository.enqueueScheduled(
          {
            jobId: 'system.attachment-gc',
            scheduledFor: fire,
            eventName: 'scheduled.system.attachment-gc',
            runAt: fire,
            maxAttempts: 5,
          },
          tx,
        ),
      );
      if (queued) scheduled.push(fire.toISOString());
    },
  });
}

/** Wait — bounded — for the worker to hold nothing; answers whether it got there. */
async function drainsWithin(worker: JobWorker, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (worker.inFlightCount > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return worker.inFlightCount === 0;
}

describe('the 2026-11-07 stall, reproduced (MOTIR-10600 AC 4)', () => {
  it('ten refreshes refused admission leave the pool FREE: an event job is claimed and the cron fire is written while all ten are still pending', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    const eventData = new Map<string, unknown>();
    const refreshIds: string[] = [];
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const { runId, data } = await queueRefresh();
      eventData.set(runId, data);
      refreshIds.push(runId);
    }
    // The ordinary event job that queued behind them — a webhook delivery, on the day.
    const ws = await seedIndexWorkspace(`adm-ordinary-${seq}`, 1);
    await adminDb.jobQueueRun.create({
      data: {
        jobId: 'system.github-webhook-delivery',
        eventName: 'github.webhook.delivery',
        workspaceId: ws.workspaceId,
        runAt: dueNow(),
        maxAttempts: 3,
      },
    });

    const ordinary: string[] = [];
    const scheduled: string[] = [];
    const worker = incidentWorker(eventData, ordinary, scheduled);

    // Two ticks claim the ten refreshes (CLAIM_BATCH is five). Each asks once, is
    // refused, and goes BACK TO THE QUEUE rather than sleeping in its slot.
    for (let tick = 0; tick < 2; tick += 1) {
      await worker.tick();
      expect(
        await drainsWithin(worker, 3_000),
        `tick ${tick + 1}: a refused admission must release its slot, not sleep in it`,
      ).toBe(true);
    }
    expect(worker.freeCapacity).toBe(POOL_SIZE);

    // The next tick reaches the work queued behind them.
    await worker.tick();
    await worker.settled();
    // Both the webhook delivery and the cron fire the scheduler just wrote ran.
    expect([...ordinary].sort()).toEqual([
      'system.attachment-gc',
      'system.github-webhook-delivery',
    ]);
    expect(scheduled.length, 'the scheduler wrote the due cron fire').toBeGreaterThan(0);
    expect(
      await adminDb.jobQueueRun.count({ where: { jobId: 'system.attachment-gc' } }),
    ).toBeGreaterThan(0);

    // And all ten refreshes are still waiting their turn — pending, unclaimed,
    // due at the first wait, the attempt refunded.
    const rows = await adminDb.jobQueueRun.findMany({ where: { id: { in: refreshIds } } });
    expect(rows).toHaveLength(POOL_SIZE);
    for (const row of rows) {
      expect(row.state).toBe('pending');
      expect(row.claimedBy).toBeNull();
      expect(row.attempts).toBe(0);
      expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + FIRST_WAIT_MS / 2);
    }
    // One memoized ask each, and no verdict yet — the next pass asks again.
    const steps = await adminDb.jobStep.findMany({ where: { runId: { in: refreshIds } } });
    const ids = steps.map((s) => s.stepId);
    expect(ids.filter((id) => id.startsWith('index-admit-try:'))).toHaveLength(POOL_SIZE);
    expect(ids.filter((id) => id.startsWith('index-admit:'))).toEqual([]);
  }, 60_000);
});

describe('a queued admission is a defer between asks (MOTIR-10600 AC 1)', () => {
  it('each ask is one pass and one memo; the budget still ends in admission_deferred', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    budgets = { maxAdmissionAttempts: 3, admissionWaitMs: 1, maxAdmissionWaitMs: 1 };
    const { runId, data } = await queueRefresh();
    const worker = incidentWorker(new Map([[runId, data]]), [], null);

    const asks: number[] = [];
    for (let pass = 1; pass <= 3; pass += 1) {
      await adminDb.jobQueueRun.update({ where: { id: runId }, data: { runAt: dueNow() } });
      expect(await worker.tick(), `pass ${pass} claims the run`).toBe(1);
      await worker.settled();
      const tries = await adminDb.jobStep.count({
        where: { runId, stepId: { startsWith: 'index-admit-try:' } },
      });
      asks.push(tries);
      if (pass < 3) {
        const row = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: runId } });
        expect(row.state, `pending between asks (pass ${pass})`).toBe('pending');
        expect(row.attempts, 'a defer refunds the attempt').toBe(0);
        expect(worker.inFlightCount).toBe(0);
      }
    }
    // ONE new ask per pass: the earlier refusals replay from their memos.
    expect(asks).toEqual([1, 2, 3]);

    // The third refusal exhausts the budget: the verdict is memoized and the run
    // fails as an `admission_deferred` dispatch, exactly as before.
    const admit = await adminDb.jobStep.findFirst({
      where: { runId, stepId: { startsWith: 'index-admit:' } },
    });
    expect(admit?.result).toMatchObject({
      outcome: 'deferred',
      reason: 'fleet_ceiling',
      detail: expect.stringContaining('refused for 3 attempts'),
    });
    // The attempt FAILED (spending it, unlike a defer) and is rescheduled for a
    // retry, its error naming the deferral.
    const row = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.attempts).toBe(1);
    expect(JSON.stringify(row.lastError)).toContain('admission_deferred');
  }, 60_000);
});

describe('an indexer pool with no account is answered, not waited on (MOTIR-10600 AC 2)', () => {
  it('the first ask pauses the repository with the no-account reason; nothing defers, nothing is held', async () => {
    wireFleetKindSwitch('code_graph_index', () => true);
    expect(await fleetKindOnPool('code_graph_index')).toBe(true);
    const { runId, data } = await queueRefresh();
    const worker = incidentWorker(new Map([[runId, data]]), [], null);

    expect(await worker.tick()).toBe(1);
    await worker.settled();

    const row = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.state).toBe('succeeded');
    const tries = await adminDb.jobStep.findMany({
      where: { runId, stepId: { startsWith: 'index-admit-try:' } },
    });
    expect(tries).toHaveLength(1);
    const repos = await adminDb.githubRepo.findMany({
      where: { indexPausedReason: INDEX_NO_ACCOUNT_PAUSE_REASON },
    });
    expect(repos).toHaveLength(1);
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  }, 60_000);
});
