import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import { recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { fakeOrchestrator } from '@motir/orchestrator';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  containerExitsWith,
  INDEX_REPO_REF,
  indexEventFor,
  indexJobRuns,
  driveIndexFleetFast,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// THE ASSEMBLED DISPATCH → LEDGER SEAM (Story MOTIR-1981 · MOTIR-1992) — the
// story's motir-core test gate, driving the REAL job on the `fake` orchestrator
// against a REAL Postgres and reading the result back through the ledger's REAL
// CONSUMERS.
//
// ⚠️ WHY NOT ASSERT THE `job_run` ROW. `tests/jobs/code-graph-index.test.ts`
// covers the durable step SHAPE and does assert the row — correctly, because the
// shape is what writes it. This file exists for the failure that assertion
// CANNOT see: KEY DRIFT between what the job writes and what the readers
// `select` on. `listSucceededCodeGraphIndexRepoRefs` matches on
// `output.repoRef`, `findSucceededCodeGraphIndex` matches on the same key for
// ONE repo, and both filter `status = 'succeeded'` and `functionId =
// 'system.code-graph-index'`. Rename any of those on either side and a row
// assertion still passes while every downstream reader goes blind — the enqueue
// gate re-indexes forever and the onboarding wizard's Next button never
// enables. So every assertion here goes through the shipped reader.
//
// The four things it pins (`docs/decisions/code-graph-index-fleet.md` §6):
//   1. A dispatched index is visible to BOTH real consumers — the enqueue gate's
//      repoRef set AND `MigrateIndexStatusDto`.
//   2. N repos produce N runs with N DISTINCT `output.repoRef`s — the contract
//      that forbids batching. Batching makes N−1 repos read as never-indexed.
//   3. The three no-op verdicts reach the ledger as `succeeded` and STILL do not
//      count as an index — the dangerous case, because those rows ARE succeeded.
//   4. A container failure's exit class is legible in the FAILURE RECORD, which
//      is written by `onFailure` (a separate Inngest invocation — PRODECT_FINDINGS
//      #39), not by the handler's own throw.

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  // The admission slots are real rows and no FK cascade reaches them; a file
  // that left them behind would slowly fill the index lane and start deferring
  // its own later cases.
  await adminDb.fleetInFlightSlot.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetTarballBodyTrap();
  // The supervision loop is a real `await` since MOTIR-3484, so a job-level
  // test would otherwise sleep at the shipped cadence.
  driveIndexFleetFast();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // ⚠️ AND AFTER, NOT ONLY BEFORE. `fleet_in_flight_slot` is FLEET-WIDE — nullable
  // `workspace_id`, no foreign key, by design, so a slot outlives whatever it
  // pointed at — which means no `TRUNCATE "workspace" CASCADE` reaches it and the
  // NEXT FILE IN THIS WORKER does not clean up after this one. A slot this file
  // leaves behind is counted by `fleetCeilingService.census`, which unions EVERY
  // workload, so it defers an unrelated file's CI-runner admission with no visible
  // cause. Clearing it before our own tests protects us; clearing it after protects
  // everyone else.
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The enqueue gate's view: the workspace's indexed repoRef set. */
function indexedRepoRefs(workspaceId: string): Promise<string[]> {
  return withSystemContext((tx) =>
    jobRunRepository.listSucceededCodeGraphIndexRepoRefs(workspaceId, tx),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · DISPATCH → LEDGER, through BOTH real readers.
// ─────────────────────────────────────────────────────────────────────────────

describe('a dispatched index is visible to the ledger’s REAL consumers', () => {
  it('the enqueue gate finds the repo AND the wizard’s status DTO shows it indexed', async () => {
    const { workspaceId, ownerUserId, projectIds, installationId } = await seedIndexWorkspace(
      'seam-both',
      1,
    );
    stubIndexFleet();
    containerExitsWith(0);

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result } = await engine.execute({
      events: [indexEventFor({ installationId, workspaceId })],
    });
    expect(result).toMatchObject({ indexed: true, repoRef: INDEX_REPO_REF });

    // READER 1 — the enqueue gate (`enqueueFirstIndexForRepos` /
    // `sweepReposMissingFirstIndex` both build their indexed SET from this).
    expect(await indexedRepoRefs(workspaceId)).toEqual([INDEX_REPO_REF]);

    // READER 2 — the onboarding wizard's per-repo rows, through the SERVICE that
    // builds `MigrateIndexStatusDto`. It matches on a DIFFERENT repository method
    // (`findSucceededCodeGraphIndex`, keyed by repoRef) than reader 1, so a key
    // change that kept one working could still blind the other.
    const ctx = { userId: ownerUserId, workspaceId };
    const run = await migrateOnboardingService.startMigration(projectIds[0]!, ctx);
    const status = await migrateOnboardingService.getIndexStatus(run.id, ctx);

    expect(status.repos).toEqual([
      { provider: 'github', repoRef: INDEX_REPO_REF, status: 'indexed' },
    ]);
    expect(status.indexedCount).toBe(1);
    expect(status.total).toBe(1);
    // The wizard's Next button. A drifted key leaves this false forever, and the
    // migrate onboarding cannot be completed at all.
    expect(status.allIndexed).toBe(true);
  }, 30_000);

  it('a repo with no run reads as QUEUED through the same DTO — the assertion is not vacuous', async () => {
    const { workspaceId, ownerUserId, projectIds } = await seedIndexWorkspace('seam-pending', 1);

    const ctx = { userId: ownerUserId, workspaceId };
    const run = await migrateOnboardingService.startMigration(projectIds[0]!, ctx);
    const status = await migrateOnboardingService.getIndexStatus(run.id, ctx);

    expect(status.repos).toEqual([
      { provider: 'github', repoRef: INDEX_REPO_REF, status: 'queued' },
    ]);
    expect(status.allIndexed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · ONE RUN, ONE repoRef, N REPOS — the contract that forbids batching (§6).
// ─────────────────────────────────────────────────────────────────────────────

describe('four repos produce four runs with four DISTINCT repoRefs', () => {
  it('never batches repos into one run — every repo carries its own claim', async () => {
    const repos = [
      { owner: 'moooon', name: 'motir-core' },
      { owner: 'moooon', name: 'motir-ai' },
      { owner: 'moooon', name: 'motir-gateway' },
      { owner: 'moooon', name: 'motir-meta' },
    ];
    const { workspaceId, ownerUserId, projectIds, installationId, repoRefs } =
      await seedIndexWorkspace('seam-four', 1, repos);
    stubIndexFleet();
    containerExitsWith(0);

    for (const repo of repos) {
      const engine = new JobTestEngine({ function: codeGraphIndex });
      const { result } = await engine.execute({
        events: [
          indexEventFor({
            installationId,
            workspaceId,
            repoOwner: repo.owner,
            repoName: repo.name,
          }),
        ],
      });
      expect(result).toEqual({
        indexed: true,
        repoRef: `${repo.owner}/${repo.name}`,
        projectsIndexed: 1,
        coreTimings: expect.any(Array),
        indexModes: expect.any(Array),
      });
    }

    // FOUR rows, all succeeded, with FOUR distinct repoRefs. A run that batched
    // would leave one row claiming one ref, and the other three repos would read
    // as never-indexed to every consumer below — silently, forever.
    const runs = await indexJobRuns();
    expect(runs).toHaveLength(4);
    expect(runs.every((run) => run.status === 'succeeded')).toBe(true);
    const written = runs.map((run) => (run.output as { repoRef?: string } | null)?.repoRef);
    expect(new Set(written).size).toBe(4);

    // And the consumers agree, which is the point: the gate sees all four…
    expect((await indexedRepoRefs(workspaceId)).sort()).toEqual([...repoRefs].sort());
    // …and the wizard ticks all four, so its Next button enables.
    const ctx = { userId: ownerUserId, workspaceId };
    const run = await migrateOnboardingService.startMigration(projectIds[0]!, ctx);
    const status = await migrateOnboardingService.getIndexStatus(run.id, ctx);
    expect(status.total).toBe(4);
    expect(status.indexedCount).toBe(4);
    expect(status.allIndexed).toBe(true);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2b · A CONTAINER THAT DID NOT INDEX LEAVES NOTHING A READER CAN READ AS A
//      CLAIM (MOTIR-4519).
// ─────────────────────────────────────────────────────────────────────────────

describe('a container that did not exit 0 writes no claim the ledger’s readers can see', () => {
  // ⚠️ THE ROW THIS FILE EXISTS FOR, AND THE ONE IT DID NOT COVER. Section 3
  // below pins the no-op verdicts — `succeeded` rows that carry no `repoRef`.
  // This is the other half: a container that RAN, was billed, and FAILED. For
  // eight days it produced `succeeded` rows carrying `{ indexed: true, repoRef,
  // projectsIndexed }` — indistinguishable from an earned index to both readers
  // — because the exit code reaching `classifyIndexExit` was not the container's
  // (`packages/orchestrator/src/adapters/fly/flyMachines.ts`'s `exitCodeOfEvent`,
  // corrected by MOTIR-4519). 313 such rows stood against a motir-ai pointer
  // table whose newest row predated every one of them.
  //
  // Both arms drive the SHIPPED job on a real Postgres and read back through the
  // SHIPPED consumers, because the claim §6 forbids is a claim a READER makes:
  // "no output" is not the assertion, "the enqueue gate does not see this repo"
  // is.
  it.each([
    [40, 'upload_failed', 'the graph was built and object storage refused it'],
    [null, 'exit_unobserved', 'the machine destroyed itself before its code was read'],
  ] as const)(
    'exit %s (%s) leaves the repo un-indexed to every reader — %s',
    async (exitCode, _exitClass, _why) => {
      const { workspaceId, ownerUserId, projectIds, installationId } = await seedIndexWorkspace(
        `seam-noclaim${exitCode ?? 'null'}`,
        1,
      );
      stubIndexFleet();
      containerExitsWith(exitCode);

      const engine = new JobTestEngine({ function: codeGraphIndex });
      const { result } = (await engine.execute({
        events: [indexEventFor({ installationId, workspaceId })],
      })) as { result?: unknown };

      // The handler THREW, so there is no `IndexRepoResult` at all — the ledger
      // contract's own mechanism (`indexEveryProject` refuses a non-`indexed`
      // verdict) rather than a diminished success.
      expect(result).toBeUndefined();

      // READER 1 — the enqueue gate. An entry here is a permanent claim, and the
      // sweep would stop re-indexing a repo that has no graph at all.
      expect(await indexedRepoRefs(workspaceId)).toEqual([]);

      // READER 2 — the onboarding wizard's per-repo rows, keyed by a DIFFERENT
      // repository method. The Next button must stay disabled.
      //
      // ⚠️ `indexing`, NOT `queued` (MOTIR-9454). The claim names the run's own
      // ledger row, and `JobTestEngine` leaves a throwing run's row `running` —
      // the state of an attempt the worker will retry. It read `queued` only
      // while the claim carried an id no reader could resolve. What matters here
      // is that it is never `indexed`.
      const ctx = { userId: ownerUserId, workspaceId };
      const run = await migrateOnboardingService.startMigration(projectIds[0]!, ctx);
      const status = await migrateOnboardingService.getIndexStatus(run.id, ctx);
      expect(status.repos).toEqual([
        { provider: 'github', repoRef: INDEX_REPO_REF, status: 'indexing' },
      ]);
      expect(status.allIndexed).toBe(false);

      // And the row itself carries no output to be read the wrong way later.
      const rows = await indexJobRuns();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).not.toBe('succeeded');
      expect(rows[0]!.output).toBeNull();
    },
    30_000,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · THE NO-OP VERDICTS — `succeeded`, and still NOT an index.
// ─────────────────────────────────────────────────────────────────────────────

describe('a no-op verdict reaches the ledger and still does not count as an index', () => {
  // ⚠️ THE DANGEROUS SHAPE. These rows are `status: 'succeeded'` — the same
  // status a real index writes — and differ only in carrying no `output.repoRef`.
  // A reader that filtered on status alone would treat a vanished installation
  // as a built code graph and never index the repo again.
  it.each([
    ['installation_missing', 'the installation vanished before the job ran'],
    ['no_projects', 'the workspace has no project to index into'],
  ] as const)(
    '%s: a succeeded row with no repoRef is not a graph (%s)',
    async (reason, _why) => {
      const projectCount = reason === 'no_projects' ? 0 : 1;
      const { workspaceId, installationId } = await seedIndexWorkspace(
        `seam-${reason.slice(0, 6)}`,
        projectCount,
      );
      stubIndexFleet();

      const engine = new JobTestEngine({ function: codeGraphIndex });
      const { result } = await engine.execute({
        events: [
          indexEventFor({
            // `installation_missing` is driven by naming an installation that is
            // not there; `no_projects` by a real one over an empty workspace.
            installationId: reason === 'installation_missing' ? 'inst-gone' : installationId,
            workspaceId,
          }),
        ],
      });
      expect(result).toEqual({ indexed: false, reason });

      // The row IS there, and it IS succeeded — the contract that the ledger
      // records WHY nothing was indexed.
      const runs = await indexJobRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('succeeded');
      expect(runs[0]!.output).toEqual({ indexed: false, reason });

      // And NEITHER consumer counts it. The enqueue gate still sees nothing…
      expect(await indexedRepoRefs(workspaceId)).toEqual([]);
      // …so the operator sweep still finds the repo missing and would re-enqueue it.
      const report = await codeGraphIndexService.sweepReposMissingFirstIndex({
        workspaceId,
        dryRun: true,
      });
      expect(report.scanned).toBe(1);
      expect(report.alreadyIndexed).toBe(0);
      expect(report.missing.map((repo) => repo.repoRef)).toEqual([INDEX_REPO_REF]);
    },
    30_000,
  );

  it('workspace_missing writes no row at all, and the repo stays un-indexed', async () => {
    const { workspaceId, installationId } = await seedIndexWorkspace('seam-nows', 1);
    stubIndexFleet();

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, error } = (await engine.execute({
      events: [indexEventFor({ installationId, workspaceId: 'ws-gone' })],
    })) as { result?: unknown; error?: unknown };

    // A vanished tenant is a clean no-op, never a throw — and `job_run`'s
    // workspace FK means there is no row to write for it (MOTIR-1545).
    expect(error).toBeUndefined();
    expect(result).toEqual({ indexed: false, reason: 'workspace_missing' });
    expect(await indexJobRuns()).toEqual([]);

    expect(await indexedRepoRefs(workspaceId)).toEqual([]);
    const report = await codeGraphIndexService.sweepReposMissingFirstIndex({
      workspaceId,
      dryRun: true,
    });
    expect(report.missing.map((repo) => repo.repoRef)).toEqual([INDEX_REPO_REF]);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · A FAILED CONTAINER'S REASON IS LEGIBLE IN THE FAILURE RECORD.
// ─────────────────────────────────────────────────────────────────────────────

describe('a container failure is legible in the ledger, not an opaque code', () => {
  // ⚠️ THE FAILURE RECORD IS WRITTEN BY A TERMINAL-FAILURE HOOK, NOT BY THE
  // THROW. A step scheduled from a try/catch after the terminally-failed step
  // never executes on a real durable executor (PRODECT_FINDINGS #39), so the
  // dead-letter write lives OUTSIDE the handler — in
  // `recordEngineTerminalFailure`, which the worker calls once when a run's
  // `attempts` reach `maxAttempts`. Asserting only the thrown error therefore
  // proves nothing about what an operator actually reads off the run. So this
  // drives the handler to its throw, then calls the SHIPPED hook with the run row
  // the worker would have been holding. (It used to reach into the vendor
  // function object's `opts.onFailure`, which was the same shape one lane over.)
  it.each([
    [30, 'graph_unbuildable'],
    [137, 'out_of_memory'],
  ] as const)(
    'exit %i lands in the failure record as %s',
    async (exitCode, exitClass) => {
      const { workspaceId, installationId } = await seedIndexWorkspace(`seam-fail${exitCode}`, 1);
      stubIndexFleet();
      containerExitsWith(exitCode);
      const event = indexEventFor({ installationId, workspaceId });

      const engine = new JobTestEngine({ function: codeGraphIndex });
      const { result, error } = (await engine.execute({
        events: [event],
      })) as { result?: unknown; error?: { message?: string } };

      expect(result).toBeUndefined();
      // The handler threw, so the row it started is still `running` — the
      // intended UX for a retrying run, and the row `onFailure` correlates to.
      const running = await indexJobRuns();
      expect(running).toHaveLength(1);
      expect(running[0]!.status).toBe('running');

      // Now the terminal-failure call, with the row the worker would hold: the
      // same `eventId` the `running` row above was keyed on, so the correlation
      // flips that row rather than writing a second one.
      await recordEngineTerminalFailure(
        {
          id: 'run-terminal',
          jobId: 'system.code-graph-index',
          eventId: running[0]!.eventId,
          eventName: running[0]!.eventName,
          workspaceId,
          attempts: 5,
        } as unknown as JobQueueRun,
        new Error(String(error?.message)),
        event.data,
      );

      // ⚠️ WHAT THE OPERATOR READS. The exit code is the container's entire
      // diagnostic channel, so the record names the class — "the parser died on
      // this tree" and "the kernel OOM-killed it" are different on-call responses,
      // and a bare `137` sends the wrong one to the repo instead of the fleet.
      const [failed] = await indexJobRuns();
      expect(failed!.status).toBe('failed');
      const failure = failed!.failure as { message?: string } | null;
      expect(failure?.message).toContain(exitClass);
      expect(failure?.message).toContain(INDEX_REPO_REF);
      expect(failure?.message).not.toBe(String(exitCode));

      // And the failed run still claims nothing: it carries no output, so no
      // consumer can read the repo as indexed.
      expect(failed!.output).toBeNull();
      expect(await indexedRepoRefs(workspaceId)).toEqual([]);
    },
    30_000,
  );
});
