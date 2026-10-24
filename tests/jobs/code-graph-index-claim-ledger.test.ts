import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { deriveMigrateIndexRepoState } from '@/lib/codeGraph/migrateIndexRepoState';
import { deriveRefreshFailing } from '@/lib/codeGraph/refreshReason';
import { fakeOrchestrator } from '@motir/orchestrator';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  INDEX_REPO_REF,
  driveIndexFleetFast,
  indexEventFor,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// THE INDEXING CLAIM NAMES THE LEDGER ROW (Bug MOTIR-9454).
//
// `github_repo.indexing_run_id` is read against `job_run` ids — the running set
// says `indexing`, the terminal set says `failed`. On the Postgres engine
// `ctx.runId` is the `job_queue` row id, a DIFFERENT row, so a claim stamped
// from it matched neither set: a running index read `queued`, and a failed one
// never read `failed`.
//
// ⚠️ SO THIS RUNS THE REAL JOB THROUGH `executeWithLedger`, on a real queue row.
// The unit suites hand `markIndexStarted` a `job_run` id they made themselves,
// and `JobTestEngine` synthesises its own run id — neither can produce the id
// the shipped engine actually hands the handler, which is the whole defect.

const [REPO_OWNER, REPO_NAME] = INDEX_REPO_REF.split('/') as [string, string];

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetTarballBodyTrap();
  driveIndexFleetFast();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** What the readers see for the repository: its pointer, joined to the ledger. */
async function readerState(workspaceId: string) {
  const repo = await adminDb.githubRepo.findFirstOrThrow({
    where: { owner: REPO_OWNER, name: REPO_NAME },
    select: { indexingRunId: true },
  });
  const { running, terminal } = await withSystemContext(async (tx) => ({
    running: new Set(await jobRunRepository.listRunningCodeGraphIndexRunIds(workspaceId, tx)),
    terminal: new Set(await jobRunRepository.listTerminalCodeGraphRunIds(workspaceId, tx)),
  }));
  const indexingRunId = repo.indexingRunId;
  return {
    indexingRunId,
    status: deriveMigrateIndexRepoState({
      hasSucceededIndex: false,
      hasRunningIndex: indexingRunId !== null && running.has(indexingRunId),
      refreshFailing: deriveRefreshFailing({ indexingRunId, terminalRunIds: terminal }),
      refusedForSize: false,
    }),
  };
}

/** Drive one queued run the way the worker does: re-enter while it defers. */
async function runToEnd(run: JobQueueRun, data: unknown): Promise<unknown> {
  for (let pass = 0; pass < 5_000; pass += 1) {
    try {
      await executeWithLedger(run, data);
      return undefined;
    } catch (err) {
      if (!isJobRunDefer(err)) return err;
    }
  }
  throw new Error('the index run never settled');
}

describe('the indexing claim on the Postgres engine', () => {
  it('stamps the job_run id, so a running index reads indexing and a failed one reads failed', async () => {
    const seeded = await seedIndexWorkspace('claim-ledger', 1);
    stubIndexFleet();
    const event = indexEventFor({
      installationId: seeded.installationId,
      workspaceId: seeded.workspaceId,
    });

    // While the container runs, read what the readers would show — then fail it.
    const whileRunning: Array<Awaited<ReturnType<typeof readerState>>> = [];
    const realPoll = codeGraphIndexDispatchService.pollIndexContainer.bind(
      codeGraphIndexDispatchService,
    );
    vi.spyOn(codeGraphIndexDispatchService, 'pollIndexContainer').mockImplementation(
      async (session, previous, options) => {
        whileRunning.push(await readerState(seeded.workspaceId));
        for (const id of fakeOrchestrator.liveContainerIds()) {
          fakeOrchestrator.completeJob(id, { exitCode: 1 });
        }
        return realPoll(session, previous, options);
      },
    );

    const jobEvent = await adminDb.jobEvent.create({
      data: { name: event.name, data: event.data, workspaceId: seeded.workspaceId },
    });
    const run = await adminDb.jobQueueRun.create({
      data: {
        jobId: codeGraphIndex.id,
        eventId: jobEvent.id,
        eventName: event.name,
        workspaceId: seeded.workspaceId,
        runAt: new Date(),
        maxAttempts: 1,
      },
    });

    const error = await runToEnd(run, event.data);
    expect(error).toBeInstanceOf(Error);
    // The attempt budget is spent: the worker's settle path writes the failure.
    await recordEngineTerminalFailure(run, error, event.data);

    const ledger = await adminDb.jobRun.findMany({ where: { functionId: codeGraphIndex.id } });
    expect(ledger).toHaveLength(1);
    const ledgerId = ledger[0]!.id;
    expect(ledgerId).not.toBe(run.id);

    expect(whileRunning.length).toBeGreaterThan(0);
    expect(whileRunning[0]).toEqual({ indexingRunId: ledgerId, status: 'indexing' });

    expect(ledger[0]!.status).toBe('failed');
    expect(await readerState(seeded.workspaceId)).toEqual({
      indexingRunId: ledgerId,
      status: 'failed',
    });
  }, 60_000);
});
