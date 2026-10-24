import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';
import { db } from '@/lib/db';
import type { IndexAllowanceVerdict } from '@/lib/ciFleet/indexAllowance';
import { codeGraphRefresh } from '@/lib/jobs/definitions/codeGraphRefresh';
import {
  CODE_GRAPH_INDEX_CATCH_UP_CRON,
  codeGraphIndexCatchUp,
} from '@/lib/jobs/definitions/codeGraphIndexCatchUp';
import { jobServices } from '@/lib/jobs/services';
import { jobSchedules } from '@/lib/jobs/schedules';
import '@/lib/jobs/registry';
import type { CodeGraphIndexData } from '@/lib/jobs/types';
import {
  catchUpActionFor,
  codeGraphIndexCatchUpService,
  type IndexCatchUpDeps,
} from '@/lib/services/codeGraphIndexCatchUpService';
import { fakeOrchestrator } from '@motir/orchestrator';
import * as indexEnqueue from '@/lib/github/indexEnqueue';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  containerExitsWith,
  driveIndexFleetFast,
  indexAllowanceWorld,
  refreshEventFor,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// THE INDEX CATCH-UP SWEEP (MOTIR-5290 · Story MOTIR-4335), against a REAL
// Postgres. motir-ai's verdict and the queue are the injected leaves; the pause
// rows, the head columns and the selection are real.
//
// ⚠️ Motir does not charge for code indexing. The allowance is internal.

const GRAPH_SHA = 'a'.repeat(40);
const MOVED_SHA = 'b'.repeat(40);

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

function verdict(outcome: string): IndexAllowanceVerdict {
  return {
    outcome,
    window: '2026-10',
    grantedCredits: 400,
    consumedCredits: 0,
    attributedCredits: 0,
  };
}

/** Injected leaves that record what the sweep did. `answers` maps an organisation
 *  to its verdict outcome, or `null` for an ask that failed; `room` answers the
 *  indexer pool's headroom read (MOTIR-9451), a throw being a read that failed. */
function fakeDeps(
  answer: (organizationId: string) => string | null,
  room: (organizationId: string) => boolean = () => true,
) {
  const checks: string[] = [];
  const poolReads: string[] = [];
  const refreshes: CodeGraphIndexData[] = [];
  const indexes: CodeGraphIndexData[] = [];
  const deps: IndexCatchUpDeps = {
    check: async (organizationId) => {
      checks.push(organizationId);
      const outcome = answer(organizationId);
      return outcome === null ? null : verdict(outcome);
    },
    enqueueRefresh: async (data) => void refreshes.push(data),
    enqueueIndex: async (data) => void indexes.push(data),
    poolHasRoom: async (organizationId) => {
      poolReads.push(organizationId);
      return room(organizationId);
    },
  };
  return { deps, checks, poolReads, refreshes, indexes };
}

/** A workspace with `repos` connected, and the organisation that owns it. */
async function seedOrg(slug: string, repoNames: string[]) {
  const seeded = await seedIndexWorkspace(
    slug,
    1,
    repoNames.map((name) => ({ owner: 'moooon', name })),
  );
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: seeded.workspaceId },
  });
  return { ...seeded, organizationId };
}

async function setRepo(
  name: string,
  data: {
    paused?: string | null;
    indexedHeadSha?: string | null;
    defaultBranchHeadSha?: string | null;
  },
) {
  await adminDb.githubRepo.updateMany({
    where: { owner: 'moooon', name },
    data: {
      ...(data.paused !== undefined
        ? { indexPausedReason: data.paused, indexPausedAt: data.paused ? new Date() : null }
        : {}),
      ...(data.indexedHeadSha !== undefined ? { indexedHeadSha: data.indexedHeadSha } : {}),
      ...(data.defaultBranchHeadSha !== undefined
        ? { defaultBranchHeadSha: data.defaultBranchHeadSha }
        : {}),
    },
  });
}

async function pauseOf(name: string) {
  const row = await adminDb.githubRepo.findFirstOrThrow({
    where: { owner: 'moooon', name },
    select: { indexPausedReason: true },
  });
  return row.indexPausedReason;
}

describe('the drift rule', () => {
  it('refreshes a moved head, clears a current graph, first-indexes a never-indexed repo, and never guesses on an unknown head', () => {
    expect(catchUpActionFor({ indexedHeadSha: GRAPH_SHA, defaultBranchHeadSha: MOVED_SHA })).toBe(
      'refresh_enqueued',
    );
    expect(catchUpActionFor({ indexedHeadSha: GRAPH_SHA, defaultBranchHeadSha: GRAPH_SHA })).toBe(
      'pause_cleared',
    );
    expect(catchUpActionFor({ indexedHeadSha: null, defaultBranchHeadSha: MOVED_SHA })).toBe(
      'index_enqueued',
    );
    expect(catchUpActionFor({ indexedHeadSha: GRAPH_SHA, defaultBranchHeadSha: null })).toBe(
      'head_unknown',
    );
  });
});

describe('a TOP-UP resumes indexing within one sweep — only where the head moved (AC 1)', () => {
  it('refreshes the moved repository and FAILS if the unchanged one is refreshed', async () => {
    const org = await seedOrg('cu-topup', ['moved', 'still']);
    await setRepo('moved', {
      paused: 'paused_index_no_credit',
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: MOVED_SHA,
    });
    await setRepo('still', {
      paused: 'paused_index_no_credit',
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: GRAPH_SHA,
    });
    // The balance went zero → non-zero in motir-ai: the verdict is no longer a stop.
    const { deps, refreshes, indexes } = fakeDeps(() => 'ok');

    const summary = await codeGraphIndexCatchUpService.catchUp({ deps });

    expect(refreshes.map((r) => r.repoName)).toEqual(['moved']);
    expect(refreshes[0]).toEqual({
      installationId: org.installationId,
      workspaceId: org.workspaceId,
      repoOwner: 'moooon',
      repoName: 'moved',
      defaultBranch: 'main',
    });
    expect(indexes).toEqual([]);
    // The unchanged repository's graph is current: pause cleared, nothing spent.
    expect(await pauseOf('still')).toBeNull();
    // The moved one stays paused until the run it was handed boots and lifts it.
    expect(await pauseOf('moved')).toBe('paused_index_no_credit');
    expect(summary.outcomes.map((o) => o.outcome).sort()).toEqual([
      'pause_cleared',
      'refresh_enqueued',
    ]);
  });
});

describe('a paid tier’s NEW PERIOD resumes on the same condition; the Free tier has none (AC 2)', () => {
  it('an org whose repos did not change over the frozen period gets no refresh', async () => {
    await seedOrg('cu-period', ['quiet']);
    await setRepo('quiet', {
      paused: 'paused_index_no_credit',
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: GRAPH_SHA,
    });
    // `invoice.paid` renewed the pool and granted credit: `ok` again.
    const { deps, refreshes, indexes } = fakeDeps(() => 'ok');

    await codeGraphIndexCatchUpService.catchUp({ deps });

    expect(refreshes).toEqual([]);
    expect(indexes).toEqual([]);
    expect(await pauseOf('quiet')).toBeNull();
  });

  it('a Free org still stopped across a period boundary stays paused and is not refreshed', async () => {
    await seedOrg('cu-free', ['drifted']);
    await setRepo('drifted', {
      paused: 'paused_index_allowance_exhausted',
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: MOVED_SHA,
    });
    // Nothing renews a one-time pool (MOTIR-5284): the verdict is still the stop.
    const { deps, refreshes } = fakeDeps(() => 'hard_stop_allowance_exhausted');

    for (let tick = 0; tick < 2; tick += 1) await codeGraphIndexCatchUpService.catchUp({ deps });

    expect(refreshes).toEqual([]);
    expect(await pauseOf('drifted')).toBe('paused_index_allowance_exhausted');
  });
});

describe('an UPGRADE from a stopped Free org resumes indexing (AC 3)', () => {
  it('refreshes the drifted repository once the verdict lifts', async () => {
    await seedOrg('cu-upgrade', ['app']);
    await setRepo('app', {
      paused: 'paused_index_allowance_exhausted',
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: MOVED_SHA,
    });
    let upgraded = false;
    const { deps, refreshes } = fakeDeps(() => (upgraded ? 'ok' : 'hard_stop_allowance_exhausted'));

    await codeGraphIndexCatchUpService.catchUp({ deps });
    expect(refreshes).toEqual([]);

    upgraded = true;
    await codeGraphIndexCatchUpService.catchUp({ deps });
    expect(refreshes.map((r) => r.repoName)).toEqual(['app']);
  });
});

describe('an org that was never stopped gets NOTHING (AC 4)', () => {
  it('selects no repository without a recorded pause — no ask, no enqueue, even when drifted', async () => {
    await seedOrg('cu-never', ['busy']);
    await setRepo('busy', { indexedHeadSha: GRAPH_SHA, defaultBranchHeadSha: MOVED_SHA });
    const { deps, checks, refreshes, indexes } = fakeDeps(() => 'ok');

    const summary = await codeGraphIndexCatchUpService.catchUp({ deps });

    expect(summary.scanned).toBe(0);
    expect(checks).toEqual([]);
    expect(refreshes).toEqual([]);
    expect(indexes).toEqual([]);
  });

  it('a never-indexed paused repository gets its FIRST index, not a refresh', async () => {
    await seedOrg('cu-first', ['fresh']);
    await setRepo('fresh', {
      paused: 'paused_index_no_credit',
      indexedHeadSha: null,
      defaultBranchHeadSha: null,
    });
    const { deps, refreshes, indexes } = fakeDeps(() => 'ok');

    await codeGraphIndexCatchUpService.catchUp({ deps });

    expect(indexes.map((r) => r.repoName)).toEqual(['fresh']);
    expect(refreshes).toEqual([]);
  });
});

describe('asked ONCE per organisation; a failed ask changes nothing (AC 6, 7)', () => {
  it('three paused repositories of one org cost one ask, two orgs cost two', async () => {
    const a = await seedOrg('cu-once-a', ['a1', 'a2', 'a3']);
    await Promise.all(
      ['a1', 'a2', 'a3'].map((name) =>
        setRepo(name, {
          paused: 'paused_index_no_credit',
          indexedHeadSha: GRAPH_SHA,
          defaultBranchHeadSha: GRAPH_SHA,
        }),
      ),
    );
    const b = await seedIndexWorkspace('cu-once-b', 1, [{ owner: 'other', name: 'b1' }]);
    await adminDb.githubRepo.updateMany({
      where: { owner: 'other', name: 'b1' },
      data: { indexPausedReason: 'paused_index_no_credit', indexPausedAt: new Date() },
    });
    const { deps, checks } = fakeDeps(() => 'hard_stop_no_credit');

    const summary = await codeGraphIndexCatchUpService.catchUp({ deps });

    const bOrg = (await adminDb.workspace.findUniqueOrThrow({ where: { id: b.workspaceId } }))
      .organizationId;
    expect(summary.scanned).toBe(4);
    expect(checks.sort()).toEqual([a.organizationId, bOrg].sort());
  });

  it('an ask that failed leaves every pause in place and enqueues nothing; the next sweep asks again', async () => {
    await seedOrg('cu-fail', ['x']);
    await setRepo('x', {
      paused: 'paused_index_no_credit',
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: MOVED_SHA,
    });
    let reachable = false;
    const { deps, checks, refreshes } = fakeDeps(() => (reachable ? 'ok' : null));

    const first = await codeGraphIndexCatchUpService.catchUp({ deps });
    expect(first.outcomes.map((o) => o.outcome)).toEqual(['ask_failed']);
    expect(refreshes).toEqual([]);
    expect(await pauseOf('x')).toBe('paused_index_no_credit');

    reachable = true;
    await codeGraphIndexCatchUpService.catchUp({ deps });
    expect(checks).toHaveLength(2);
    expect(refreshes.map((r) => r.repoName)).toEqual(['x']);
  });
});

describe('a FULL INDEXER POOL is re-asked of the pool, never of the allowance (MOTIR-9451)', () => {
  const POOL_FULL = 'paused_index_pool_full';

  it('while the pool is still full: the pause stays, nothing is enqueued, and no allowance is asked', async () => {
    const org = await seedOrg('cu-pool-full', ['waiting']);
    await setRepo('waiting', {
      paused: POOL_FULL,
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: MOVED_SHA,
    });
    const { deps, checks, poolReads, refreshes, indexes } = fakeDeps(
      () => 'ok',
      () => false,
    );

    const summary = await codeGraphIndexCatchUpService.catchUp({ deps });

    expect(summary.outcomes.map((o) => o.outcome)).toEqual(['pool_still_full']);
    expect(checks).toEqual([]);
    expect(summary.organizationsAsked).toBe(0);
    expect(poolReads).toEqual([org.organizationId]);
    expect(refreshes).toEqual([]);
    expect(indexes).toEqual([]);
    expect(await pauseOf('waiting')).toBe(POOL_FULL);
  });

  it('once the pool has room it acts on the drift rule: refresh a moved head, first-index a new repo, clear a current graph', async () => {
    await seedOrg('cu-pool-room', ['moved', 'fresh', 'still']);
    await setRepo('moved', {
      paused: POOL_FULL,
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: MOVED_SHA,
    });
    await setRepo('fresh', { paused: POOL_FULL, indexedHeadSha: null });
    await setRepo('still', {
      paused: POOL_FULL,
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: GRAPH_SHA,
    });
    const { deps, checks, poolReads, refreshes, indexes } = fakeDeps(() => 'hard_stop_no_credit');

    await codeGraphIndexCatchUpService.catchUp({ deps });

    // A hard-stop verdict would have held these; it was never asked.
    expect(checks).toEqual([]);
    // One pool read for the organisation, not one per repository.
    expect(poolReads).toHaveLength(1);
    expect(refreshes.map((r) => r.repoName)).toEqual(['moved']);
    expect(indexes.map((r) => r.repoName)).toEqual(['fresh']);
    expect(await pauseOf('still')).toBeNull();
    // Enqueued, not lifted: the dispatched run lifts it when it boots.
    expect(await pauseOf('moved')).toBe(POOL_FULL);
  });

  it('an organisation with both kinds of pause: each row answers to its own question', async () => {
    await seedOrg('cu-pool-mixed', ['pooled', 'stopped']);
    await setRepo('pooled', {
      paused: POOL_FULL,
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: MOVED_SHA,
    });
    await setRepo('stopped', {
      paused: 'paused_index_no_credit',
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: MOVED_SHA,
    });
    const { deps, checks, poolReads, refreshes } = fakeDeps(() => 'hard_stop_no_credit');

    const summary = await codeGraphIndexCatchUpService.catchUp({ deps });

    expect(checks).toHaveLength(1);
    expect(poolReads).toHaveLength(1);
    expect(summary.organizationsAsked).toBe(1);
    expect(refreshes.map((r) => r.repoName)).toEqual(['pooled']);
    expect(Object.fromEntries(summary.outcomes.map((o) => [o.repoRef, o.outcome]))).toEqual({
      'moooon/pooled': 'refresh_enqueued',
      'moooon/stopped': 'still_stopped',
    });
    expect(await pauseOf('stopped')).toBe('paused_index_no_credit');
  });

  it('a pool read that throws is not room: the pause stays and the next sweep reads again', async () => {
    await seedOrg('cu-pool-throws', ['waiting']);
    await setRepo('waiting', { paused: POOL_FULL, indexedHeadSha: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, indexes } = fakeDeps(
      () => 'ok',
      () => {
        throw new Error('database unavailable');
      },
    );

    const summary = await codeGraphIndexCatchUpService.catchUp({ deps });

    expect(summary.outcomes.map((o) => o.outcome)).toEqual(['pool_still_full']);
    expect(indexes).toEqual([]);
    expect(await pauseOf('waiting')).toBe(POOL_FULL);
  });
});

describe('no manual intervention re-arms indexing (AC 5)', () => {
  it('paused → the sweep enqueues → the refresh it enqueued indexes and LIFTS the pause', async () => {
    const org = await seedOrg('cu-e2e', ['motir-core']);
    await setRepo('motir-core', {
      paused: 'paused_index_no_credit',
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: MOVED_SHA,
    });
    const { deps, refreshes } = fakeDeps(() => 'ok');

    await codeGraphIndexCatchUpService.catchUp({ deps });
    expect(refreshes).toHaveLength(1);

    stubIndexFleet();
    indexAllowanceWorld.checkOutcome = 'ok';
    containerExitsWith(0);
    const refresh = refreshes[0]!;
    const { result } = await new JobTestEngine({ function: codeGraphRefresh }).execute({
      events: [
        refreshEventFor({
          installationId: refresh.installationId,
          workspaceId: refresh.workspaceId,
          repoOwner: refresh.repoOwner,
          repoName: refresh.repoName,
          eventId: 'evt-cu-e2e',
        }),
      ],
    });

    expect(org.installationId).toBe(refresh.installationId);
    expect(result).toMatchObject({ indexed: true, repoRef: 'moooon/motir-core' });
    expect(await pauseOf('motir-core')).toBeNull();
  }, 30_000);
});

describe('the job', () => {
  it('is registered every 5 minutes and drives the service through one memoized step', async () => {
    expect(CODE_GRAPH_INDEX_CATCH_UP_CRON).toBe('*/5 * * * *');
    expect(jobSchedules()).toContainEqual({
      functionId: 'system.code-graph-index-catch-up',
      cron: CODE_GRAPH_INDEX_CATCH_UP_CRON,
    });
    const sweep = vi
      .spyOn(jobServices.codeGraphIndexCatchUp, 'catchUp')
      .mockResolvedValue({ scanned: 0, organizationsAsked: 0, outcomes: [] });
    const { ctx } = await new JobTestEngine({ function: codeGraphIndexCatchUp }).execute({
      events: [{ name: 'system.code-graph-index-catch-up', data: {} }],
    } as never);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(
      (ctx as { step: { run: { mock: { calls: unknown[][] } } } }).step.run.mock.calls.map(
        (c) => c[0],
      ),
    ).toContain('catch-up-paused-indexes');
  });
});

describe('the words (AC 8)', () => {
  it('no identifier, log line, job name or test name describes indexing as charged, billed or priced', () => {
    const affirmative = /\b(charg\w*|bill(ed|ing|s)?|pric(e|ed|es|ing))\b/i;
    const negated = /\b(not|never|no|nothing|none)\b/i;
    const files = [
      'lib/services/codeGraphIndexCatchUpService.ts',
      'lib/jobs/definitions/codeGraphIndexCatchUp.ts',
      'lib/ciFleet/indexAllowance.ts',
    ];
    for (const file of files) {
      const offending = readFileSync(join(process.cwd(), file), 'utf8')
        .split('\n')
        .filter((line) => affirmative.test(line) && !negated.test(line));
      expect(offending, file).toEqual([]);
    }
    const testNames = readFileSync(
      join(process.cwd(), 'tests/jobs/code-graph-index-catch-up.test.ts'),
      'utf8',
    )
      .split('\n')
      .filter((line) => /^\s*(it|describe)\(/.test(line))
      .filter((line) => affirmative.test(line) && !negated.test(line));
    expect(testNames).toEqual([]);
  });
});

describe('the sweep’s own seams (MOTIR-4544 top-up)', () => {
  it('with NO injected deps it asks the real client and enqueues through the real enqueue functions', async () => {
    await seedOrg('cu-defaults', ['moved', 'fresh']);
    await setRepo('moved', {
      paused: 'paused_index_no_credit',
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: MOVED_SHA,
    });
    await setRepo('fresh', { paused: 'paused_index_no_credit', indexedHeadSha: null });
    stubIndexFleet();
    indexAllowanceWorld.checkOutcome = 'ok';
    const refresh = vi.spyOn(indexEnqueue, 'enqueueCodeGraphRefresh').mockResolvedValue();
    const index = vi.spyOn(indexEnqueue, 'enqueueCodeGraphIndex').mockResolvedValue();

    await codeGraphIndexCatchUpService.catchUp();

    expect(indexAllowanceWorld.checks).toHaveLength(1);
    expect(refresh.mock.calls.map(([data]) => data.repoName)).toEqual(['moved']);
    expect(index.mock.calls.map(([data]) => data.repoName)).toEqual(['fresh']);
  });

  it('one repository whose action throws is reported and keeps its pause; the rest proceed', async () => {
    await seedOrg('cu-throw', ['bad', 'good']);
    await setRepo('bad', {
      paused: 'paused_index_no_credit',
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: MOVED_SHA,
    });
    await setRepo('good', {
      paused: 'paused_index_no_credit',
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: GRAPH_SHA,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = fakeDeps(() => 'ok');
    deps.enqueueRefresh = async () => {
      throw new Error('queue down');
    };

    const summary = await codeGraphIndexCatchUpService.catchUp({ deps });

    const byRepo = Object.fromEntries(summary.outcomes.map((o) => [o.repoRef, o.outcome]));
    expect(byRepo).toEqual({ 'moooon/bad': 'action_failed', 'moooon/good': 'pause_cleared' });
    expect(await pauseOf('bad')).toBe('paused_index_no_credit');
    expect(await pauseOf('good')).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('honours a per-tick limit, oldest pause first', async () => {
    await seedOrg('cu-limit', ['older', 'newer']);
    await setRepo('older', {
      paused: 'paused_index_no_credit',
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: GRAPH_SHA,
    });
    await adminDb.githubRepo.updateMany({
      where: { owner: 'moooon', name: 'older' },
      data: { indexPausedAt: new Date('2026-01-01T00:00:00Z') },
    });
    await setRepo('newer', {
      paused: 'paused_index_no_credit',
      indexedHeadSha: GRAPH_SHA,
      defaultBranchHeadSha: GRAPH_SHA,
    });
    const { deps } = fakeDeps(() => 'ok');

    const summary = await codeGraphIndexCatchUpService.catchUp({ deps, limit: 1 });

    expect(summary.scanned).toBe(1);
    expect(summary.outcomes.map((o) => o.repoRef)).toEqual(['moooon/older']);
    expect(await pauseOf('newer')).toBe('paused_index_no_credit');
  });
});
