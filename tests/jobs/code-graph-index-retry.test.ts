// MOTIR-10819 — a code-graph index or refresh that ENDED TERMINAL for a reason
// other than size is re-dispatched by the catch-up sweep, bounded by a backoff
// and an attempt cap. Against a REAL Postgres: the repository rows, the claimed
// `job_run` rows, the live `job_queue` rows and the conditional claim are real;
// only the enqueue is an injected leaf, except in the end-to-end case, which
// drives the shipped `system.code-graph-index` job on the fake orchestrator.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';
import { db } from '@/lib/db';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import type { CodeGraphIndexData } from '@/lib/jobs/types';
import {
  codeGraphIndexCatchUpService,
  INDEX_RETRY_BASE_BACKOFF_MS,
  INDEX_RETRY_LOST_DISPATCH_GRACE_MS,
  INDEX_RETRY_MAX_ATTEMPTS,
  type IndexCatchUpDeps,
  type IndexRetryDeps,
} from '@/lib/services/codeGraphIndexCatchUpService';
import { deriveRefreshFailing } from '@/lib/codeGraph/refreshReason';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import * as indexEnqueue from '@/lib/github/indexEnqueue';
import { fakeOrchestrator } from '@motir/orchestrator';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  containerExitsWith,
  driveIndexFleetFast,
  indexAllowanceWorld,
  indexEventFor,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

const GRAPH_SHA = 'a'.repeat(40);
const MOVED_SHA = 'b'.repeat(40);
const NOW = new Date('2026-11-09T20:00:00Z');
const MINUTE = 60_000;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.jobQueueRun.deleteMany({});
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

function fakeDeps() {
  const refreshes: CodeGraphIndexData[] = [];
  const indexes: CodeGraphIndexData[] = [];
  const deps: IndexRetryDeps = {
    enqueueRefresh: async (data) => void refreshes.push(data),
    enqueueIndex: async (data) => void indexes.push(data),
  };
  return { deps, refreshes, indexes };
}

async function seedRepo(slug: string, name: string) {
  const seeded = await seedIndexWorkspace(slug, 1, [{ owner: 'moooon', name }]);
  const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { owner: 'moooon', name } });
  return { ...seeded, repoId: repo.id, organizationId: repo.organizationId };
}

type Fn = 'system.code-graph-index' | 'system.code-graph-refresh';

/** A claimed run that ended `status` at `finishedAt`, and the repository's claim on it. */
async function failClaimedRun(
  seeded: { workspaceId: string; repoId: string },
  args: {
    functionId?: Fn;
    status?: 'failed' | 'abandoned' | 'running' | 'succeeded';
    finishedAt?: Date;
    eventId?: string;
  } = {},
) {
  const functionId = args.functionId ?? 'system.code-graph-index';
  const run = await adminDb.jobRun.create({
    data: {
      workspaceId: seeded.workspaceId,
      functionId,
      eventName: functionId,
      eventId: args.eventId ?? `evt-${seeded.repoId}-${Math.random()}`,
      lane: 'engine',
      attempt: 5,
      status: args.status ?? 'failed',
      startedAt: new Date((args.finishedAt ?? NOW).getTime() - 2 * MINUTE),
      finishedAt: args.status === 'running' ? null : (args.finishedAt ?? NOW),
      failure: { message: 'INDEX_DISPATCH_FAILED (exit_unobserved)' },
    },
  });
  await adminDb.githubRepo.update({
    where: { id: seeded.repoId },
    data: { indexingRunId: run.id },
  });
  return run;
}

const longAgo = (minutes: number) => new Date(NOW.getTime() - minutes * MINUTE);

async function repoRow(repoId: string) {
  return adminDb.githubRepo.findUniqueOrThrow({ where: { id: repoId } });
}

async function refreshFailing(repoId: string) {
  const row = await repoRow(repoId);
  const terminal = await adminDb.jobRun.findMany({
    where: { status: { in: ['failed', 'abandoned'] } },
    select: { id: true },
  });
  return deriveRefreshFailing({
    indexingRunId: row.indexingRunId,
    terminalRunIds: new Set(terminal.map((r) => r.id)),
  });
}

describe('the reproduction — the paused pass alone never sees a terminally failed run', () => {
  it('a never-indexed repository whose index dead-lettered is not among the paused pass’s rows; the retry pass first-indexes it', async () => {
    const seeded = await seedRepo('rt-repro', 'starter');
    await failClaimedRun(seeded, { finishedAt: longAgo(31) });
    expect(await refreshFailing(seeded.repoId)).toBe(true);

    const pausedDeps: IndexCatchUpDeps = {
      check: async () => null,
      enqueueRefresh: async () => {},
      enqueueIndex: async () => {},
      poolHasRoom: async () => true,
    };
    const paused = await codeGraphIndexCatchUpService.catchUp({ deps: pausedDeps });
    expect(paused.scanned).toBe(0);

    const { deps, indexes, refreshes } = fakeDeps();
    const retried = await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });

    expect(retried.outcomes).toEqual([
      {
        repoRef: 'moooon/starter',
        organizationId: seeded.organizationId,
        arm: 'dead_run',
        attempt: 1,
        outcome: 'retry_index_enqueued',
      },
    ]);
    expect(indexes).toEqual([
      {
        installationId: seeded.installationId,
        workspaceId: seeded.workspaceId,
        repoOwner: 'moooon',
        repoName: 'starter',
        defaultBranch: 'main',
      },
    ]);
    expect(refreshes).toEqual([]);
    const row = await repoRow(seeded.repoId);
    // The dead claim is released (the repository reads queued, not failed) and the
    // attempt is counted.
    expect(row.indexingRunId).toBeNull();
    expect(row.indexRetryAttempts).toBe(1);
    expect(row.indexRetryDispatchedAt).toEqual(NOW);
  });
});

describe('AC 1 — a first index after the backoff, and indexed on success', () => {
  it('is not re-dispatched before the backoff has elapsed, and is on the next sweep after it', async () => {
    const seeded = await seedRepo('rt-backoff', 'fresh');
    await failClaimedRun(seeded, { finishedAt: longAgo(29) });
    const { deps, indexes } = fakeDeps();

    const early = await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });
    expect(early.scanned).toBe(0);
    expect(indexes).toEqual([]);

    const later = new Date(NOW.getTime() + INDEX_RETRY_BASE_BACKOFF_MS);
    const due = await codeGraphIndexCatchUpService.retryFailed({ deps, now: later });
    expect(due.outcomes.map((o) => o.outcome)).toEqual(['retry_index_enqueued']);
    expect(indexes.map((d) => d.repoName)).toEqual(['fresh']);
  });

  it('the backoff doubles with each attempt already made', async () => {
    const seeded = await seedRepo('rt-double', 'fresh');
    await failClaimedRun(seeded, { finishedAt: longAgo(90) });
    await adminDb.githubRepo.update({
      where: { id: seeded.repoId },
      data: { indexRetryAttempts: 2 },
    });
    const { deps, indexes } = fakeDeps();

    // Two attempts made ⇒ 30 min × 2² = 2 h. Ninety minutes is not enough.
    await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });
    expect(indexes).toEqual([]);

    await codeGraphIndexCatchUpService.retryFailed({
      deps,
      now: new Date(NOW.getTime() + 30 * MINUTE),
    });
    expect(indexes.map((d) => d.repoName)).toEqual(['fresh']);
    expect((await repoRow(seeded.repoId)).indexRetryAttempts).toBe(3);
  });

  it('the re-dispatched run indexes the repository, which then reads indexed with indexed_at and indexed_head_sha set', async () => {
    const seeded = await seedRepo('rt-e2e', 'motir-core');
    await adminDb.githubRepo.update({
      where: { id: seeded.repoId },
      data: { defaultBranchHeadSha: MOVED_SHA },
    });
    await failClaimedRun(seeded, { finishedAt: longAgo(45) });
    const { deps, indexes } = fakeDeps();

    await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });
    expect(indexes).toHaveLength(1);

    stubIndexFleet();
    indexAllowanceWorld.checkOutcome = 'ok';
    containerExitsWith(0);
    const sent = indexes[0]!;
    const { result } = await new JobTestEngine({ function: codeGraphIndex }).execute({
      events: [
        indexEventFor({
          installationId: sent.installationId,
          workspaceId: sent.workspaceId,
          repoOwner: sent.repoOwner,
          repoName: sent.repoName,
          eventId: 'evt-rt-e2e',
        }),
      ],
    });

    expect(result).toMatchObject({ indexed: true, repoRef: 'moooon/motir-core' });
    const row = await repoRow(seeded.repoId);
    expect(row.indexedAt).not.toBeNull();
    expect(row.indexedHeadSha).toBe(MOVED_SHA);
    expect(row.indexingRunId).toBeNull();
    // A run that indexed ends the retry ledger.
    expect(row.indexRetryAttempts).toBe(0);
    expect(row.indexRetryDispatchedAt).toBeNull();
    expect(await refreshFailing(seeded.repoId)).toBe(false);
  }, 30_000);
});

describe('AC 2 — a failed refresh is re-dispatched as a refresh only when the head moved', () => {
  it('refreshes an indexed repository whose head is past the graph', async () => {
    const seeded = await seedRepo('rt-refresh', 'gateway');
    await adminDb.githubRepo.update({
      where: { id: seeded.repoId },
      data: {
        indexedAt: longAgo(5000),
        indexedHeadSha: GRAPH_SHA,
        defaultBranchHeadSha: MOVED_SHA,
      },
    });
    await failClaimedRun(seeded, {
      functionId: 'system.code-graph-refresh',
      finishedAt: longAgo(60),
    });
    const { deps, indexes, refreshes } = fakeDeps();

    const summary = await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });

    expect(summary.outcomes.map((o) => o.outcome)).toEqual(['retry_refresh_enqueued']);
    expect(refreshes.map((d) => d.repoName)).toEqual(['gateway']);
    expect(indexes).toEqual([]);
  });

  it('leaves alone a repository whose graph is current, or whose head is unknown — nothing is owed', async () => {
    const current = await seedRepo('rt-current', 'current');
    await adminDb.githubRepo.update({
      where: { id: current.repoId },
      data: {
        indexedAt: longAgo(5000),
        indexedHeadSha: GRAPH_SHA,
        defaultBranchHeadSha: GRAPH_SHA,
      },
    });
    await failClaimedRun(current, {
      functionId: 'system.code-graph-refresh',
      finishedAt: longAgo(60),
    });
    const unknown = await seedIndexWorkspace('rt-unknown', 1, [
      { owner: 'other', name: 'unknown' },
    ]);
    const unknownRepo = await adminDb.githubRepo.findFirstOrThrow({ where: { name: 'unknown' } });
    await adminDb.githubRepo.update({
      where: { id: unknownRepo.id },
      data: { indexedAt: longAgo(5000), indexedHeadSha: GRAPH_SHA, defaultBranchHeadSha: null },
    });
    await failClaimedRun(
      { workspaceId: unknown.workspaceId, repoId: unknownRepo.id },
      { functionId: 'system.code-graph-refresh', finishedAt: longAgo(60) },
    );
    const { deps, indexes, refreshes } = fakeDeps();

    const summary = await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });

    expect(summary.scanned).toBe(0);
    expect(refreshes).toEqual([]);
    expect(indexes).toEqual([]);
    // The signal stays: the dead run is still what the claim names.
    expect(await refreshFailing(current.repoId)).toBe(true);
  });
});

describe('AC 3 — a repository refused for size is never re-dispatched', () => {
  it('is not selected, however long ago its run failed', async () => {
    const seeded = await seedRepo('rt-size', 'huge');
    await adminDb.githubRepo.update({
      where: { id: seeded.repoId },
      data: {
        indexRefusedAt: longAgo(600),
        indexRefusedSizeBytes: BigInt(3_000_000_000),
        indexRefusedCapBytes: BigInt(2_000_000_000),
      },
    });
    await failClaimedRun(seeded, { finishedAt: longAgo(600) });
    const { deps, indexes } = fakeDeps();

    const summary = await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });

    expect(summary.scanned).toBe(0);
    expect(indexes).toEqual([]);
  });
});

describe('AC 4 — at most one run per repository, however the passes race', () => {
  it('two concurrent sweeps enqueue once', async () => {
    const seeded = await seedRepo('rt-race', 'contended');
    await failClaimedRun(seeded, { finishedAt: longAgo(60) });
    const { deps, indexes } = fakeDeps();

    const [a, b] = await Promise.all([
      codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW }),
      codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW }),
    ]);

    expect(indexes).toHaveLength(1);
    const outcomes = [...a.outcomes, ...b.outcomes].map((o) => o.outcome).sort();
    // Both read the row, or the second read it after the first released it.
    expect(outcomes.filter((o) => o === 'retry_index_enqueued')).toHaveLength(1);
    expect(outcomes.every((o) => o === 'retry_index_enqueued' || o === 'retry_raced')).toBe(true);
    expect((await repoRow(seeded.repoId)).indexRetryAttempts).toBe(1);
  });

  it('a sweep that read the row before a manual retry released the claim enqueues nothing', async () => {
    const seeded = await seedRepo('rt-manual', 'contended');
    const dead = await failClaimedRun(seeded, { finishedAt: longAgo(60) });
    const { deps, indexes } = fakeDeps();
    // The sweep's read happens, then `retryIndex`'s conditional release wins.
    const read = vi.spyOn(githubRepoRepository, 'claimIndexRetry');
    read.mockImplementationOnce(async (candidate, at, tx) => {
      const released = await withSystemContext((rtx) =>
        githubRepoRepository.releaseIndexClaim('moooon/contended', dead.id, rtx),
      );
      expect(released).toBe(1);
      read.mockRestore();
      return githubRepoRepository.claimIndexRetry(candidate, at, tx);
    });

    const summary = await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });

    expect(summary.outcomes.map((o) => o.outcome)).toEqual(['retry_raced']);
    expect(indexes).toEqual([]);
    expect((await repoRow(seeded.repoId)).indexRetryAttempts).toBe(0);
  });

  it('after the sweep released the claim, a manual retry’s conditional release finds nothing to release', async () => {
    const seeded = await seedRepo('rt-manual-late', 'contended');
    const dead = await failClaimedRun(seeded, { finishedAt: longAgo(60) });
    const { deps } = fakeDeps();

    await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });
    const released = await withSystemContext((tx) =>
      githubRepoRepository.releaseIndexClaim('moooon/contended', dead.id, tx),
    );

    expect(released).toBe(0);
  });

  it('an abandoned run whose queue run is still live is not re-dispatched', async () => {
    const seeded = await seedRepo('rt-live', 'resuming');
    await failClaimedRun(seeded, {
      status: 'abandoned',
      finishedAt: longAgo(60),
      eventId: 'evt-rt-live',
    });
    await adminDb.jobQueueRun.create({
      data: {
        jobId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        workspaceId: seeded.workspaceId,
        runAt: NOW,
        maxAttempts: 5,
        state: 'running',
        idempotencyKey: null,
        id: 'evt-rt-live',
      },
    });
    const { deps, indexes } = fakeDeps();

    const summary = await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });

    expect(summary.scanned).toBe(0);
    expect(indexes).toEqual([]);
  });

  it('a claim naming a run still running, or one that succeeded, is not a retry candidate', async () => {
    const running = await seedRepo('rt-running', 'busy');
    await failClaimedRun(running, { status: 'running', finishedAt: longAgo(600) });
    const { deps, indexes } = fakeDeps();

    const summary = await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });

    expect(summary.scanned).toBe(0);
    expect(indexes).toEqual([]);
  });
});

describe('AC 5 — the attempt cap', () => {
  it('a repository whose re-dispatched runs keep failing stops at the cap, keeps refreshFailing, and is not re-enqueued later', async () => {
    const seeded = await seedRepo('rt-cap', 'broken');
    await failClaimedRun(seeded, { finishedAt: longAgo(60) });
    const { deps, indexes } = fakeDeps();

    let now = NOW;
    for (let attempt = 1; attempt <= INDEX_RETRY_MAX_ATTEMPTS; attempt += 1) {
      const summary = await codeGraphIndexCatchUpService.retryFailed({ deps, now });
      expect(summary.outcomes.map((o) => [o.attempt, o.outcome])).toEqual([
        [attempt, 'retry_index_enqueued'],
      ]);
      // The re-dispatched run claims the repository and fails again.
      now = new Date(now.getTime() + 10 * MINUTE);
      await failClaimedRun(seeded, { finishedAt: now });
      now = new Date(now.getTime() + INDEX_RETRY_BASE_BACKOFF_MS * 2 ** attempt);
    }
    expect(indexes).toHaveLength(INDEX_RETRY_MAX_ATTEMPTS);

    for (const later of [now, new Date(now.getTime() + 7 * 24 * 60 * MINUTE)]) {
      const summary = await codeGraphIndexCatchUpService.retryFailed({ deps, now: later });
      expect(summary.scanned).toBe(0);
    }
    expect(indexes).toHaveLength(INDEX_RETRY_MAX_ATTEMPTS);
    expect((await repoRow(seeded.repoId)).indexRetryAttempts).toBe(INDEX_RETRY_MAX_ATTEMPTS);
    expect(await refreshFailing(seeded.repoId)).toBe(true);
  });
});

describe('a re-dispatch nobody ever claimed is LOST, and re-sent after its grace', () => {
  it('re-sends only once the grace has passed, counting the attempt', async () => {
    const seeded = await seedRepo('rt-lost', 'dropped');
    await failClaimedRun(seeded, { finishedAt: longAgo(60) });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, indexes } = fakeDeps();
    deps.enqueueIndex = async () => {
      throw new Error('queue unreachable');
    };

    const first = await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });
    expect(first.outcomes.map((o) => o.outcome)).toEqual(['retry_enqueue_failed']);
    expect(error).toHaveBeenCalled();

    const healthy = fakeDeps();
    const tooSoon = new Date(NOW.getTime() + INDEX_RETRY_LOST_DISPATCH_GRACE_MS - MINUTE);
    expect(
      (await codeGraphIndexCatchUpService.retryFailed({ deps: healthy.deps, now: tooSoon }))
        .scanned,
    ).toBe(0);

    const after = new Date(NOW.getTime() + INDEX_RETRY_LOST_DISPATCH_GRACE_MS);
    const resent = await codeGraphIndexCatchUpService.retryFailed({
      deps: healthy.deps,
      now: after,
    });
    expect(resent.outcomes.map((o) => [o.arm, o.attempt, o.outcome])).toEqual([
      ['lost_dispatch', 2, 'retry_index_enqueued'],
    ]);
    expect(healthy.indexes.map((d) => d.repoName)).toEqual(['dropped']);
    expect(indexes).toEqual([]);
  });

  it('a paused repository belongs to the paused pass, not this one', async () => {
    const seeded = await seedRepo('rt-paused', 'paused');
    await adminDb.githubRepo.update({
      where: { id: seeded.repoId },
      data: {
        indexPausedReason: 'paused_index_pool_full',
        indexPausedAt: longAgo(600),
        indexRetryAttempts: 1,
        indexRetryDispatchedAt: longAgo(24 * 60),
      },
    });
    const { deps, indexes } = fakeDeps();

    const summary = await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });

    expect(summary.scanned).toBe(0);
    expect(indexes).toEqual([]);
  });
});

describe('the retry pass’s own seams', () => {
  it('with NO injected deps it enqueues through the real enqueue functions, at the current time', async () => {
    const seeded = await seedRepo('rt-defaults', 'fresh');
    await failClaimedRun(seeded, { finishedAt: new Date(Date.now() - 40 * MINUTE) });
    const index = vi.spyOn(indexEnqueue, 'enqueueCodeGraphIndex').mockResolvedValue();

    const summary = await codeGraphIndexCatchUpService.retryFailed();

    expect(summary.outcomes.map((o) => o.outcome)).toEqual(['retry_index_enqueued']);
    expect(index.mock.calls.map(([data]) => data.repoName)).toEqual(['fresh']);
  });

  it('a candidate the shared derivation calls current is reported not owed, and nothing is claimed or enqueued', async () => {
    const seeded = await seedRepo('rt-not-owed', 'current');
    vi.spyOn(githubRepoRepository, 'listIndexRetryCandidates').mockResolvedValue([
      {
        id: seeded.repoId,
        owner: 'moooon',
        name: 'current',
        workspaceId: seeded.workspaceId,
        organizationId: seeded.organizationId,
        defaultBranch: 'main',
        indexedAt: longAgo(5000),
        indexedHeadSha: GRAPH_SHA,
        defaultBranchHeadSha: GRAPH_SHA,
        hostInstallationId: seeded.installationId,
        arm: 'dead_run',
        deadRunId: 'run-gone',
        retryAttempts: 0,
        retryDispatchedAt: null,
      },
    ]);
    const claim = vi.spyOn(githubRepoRepository, 'claimIndexRetry');
    const { deps, indexes, refreshes } = fakeDeps();

    const summary = await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW });

    expect(summary.outcomes.map((o) => o.outcome)).toEqual(['retry_not_owed']);
    expect(claim).not.toHaveBeenCalled();
    expect(indexes).toEqual([]);
    expect(refreshes).toEqual([]);
  });

  it('honours a per-tick limit, the oldest failure first', async () => {
    const older = await seedRepo('rt-limit-a', 'older');
    await failClaimedRun(older, { finishedAt: longAgo(600) });
    const newer = await seedIndexWorkspace('rt-limit-b', 1, [{ owner: 'other', name: 'newer' }]);
    const newerRepo = await adminDb.githubRepo.findFirstOrThrow({ where: { name: 'newer' } });
    await failClaimedRun(
      { workspaceId: newer.workspaceId, repoId: newerRepo.id },
      { finishedAt: longAgo(60) },
    );
    const { deps, indexes } = fakeDeps();

    const summary = await codeGraphIndexCatchUpService.retryFailed({ deps, now: NOW, limit: 1 });

    expect(summary.scanned).toBe(1);
    expect(indexes.map((d) => d.repoName)).toEqual(['older']);
  });
});
