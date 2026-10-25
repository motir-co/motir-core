import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeGraphIndexData } from '@/lib/jobs/types';
import { JobTestEngine } from '../helpers/jobs';
import { db } from '@/lib/db';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import { INDEX_POOL_FULL_PAUSE_REASON } from '@/lib/ciFleet/indexAllowance';
import { fakeOrchestratorForShard, resetShardFakes } from '@/lib/orchestrator';
import { codeGraphIndexAdmissionService } from '@/lib/services/codeGraphIndexAdmissionService';
import {
  codeGraphIndexCatchUpService,
  indexPoolHasRoom,
} from '@/lib/services/codeGraphIndexCatchUpService';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { fakeOrchestrator } from '@motir/orchestrator';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';
import {
  INDEX_REPO_REF,
  driveIndexFleetFast,
  indexEventFor,
  indexJobRuns,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// A FULL INDEXER POOL LEAVES THE INDEX PENDING (MOTIR-9451 · Story MOTIR-9360).
//
// With the code_graph_index switch on, an index whose admission stays `pool_full`
// for its whole budget is a recorded wait: the run succeeds as a no-op, the
// repository carries the pool-full pause, and the catch-up sweep re-dispatches
// it once an account has room. Real job, dispatch service, admission and
// Postgres; the per-account fake orchestrators stand in for the indexer pool.

const [REPO_OWNER, REPO_NAME] = INDEX_REPO_REF.split('/') as [string, string];

function repoRow() {
  return adminDb.githubRepo.findFirstOrThrow({
    where: { owner: REPO_OWNER, name: REPO_NAME },
    select: { indexPausedReason: true, indexingRunId: true },
  });
}

/** One indexer-pool account; a `full` one is admission-paused, which the chooser
 *  skips exactly as it skips an account with no headroom. */
async function account(full: boolean) {
  const slug = randomToken(6).toLowerCase();
  return adminDb.fleetShard.create({
    data: {
      name: `idx-${slug}`,
      fleetKind: 'code_graph_index',
      provider: 'fly',
      state: 'active',
      githubOrg: 'motir-projects',
      githubInstallationId: '556677',
      flyOrg: 'motir',
      flyApp: `motir-idx-${slug}`,
      flyRegion: 'iad',
      credentialRef: 'FLEET_SHARD_TEST_TOKEN',
      machineLimit: 4,
      admissionPausedUntil: full ? new Date(Date.now() + 3_600_000) : null,
    },
  });
}

/** Every container booted on `shardId` exits `exitCode` at its first poll. */
function accountContainersExit(shardId: string, exitCode: number): void {
  const realPoll = codeGraphIndexDispatchService.pollIndexContainer.bind(
    codeGraphIndexDispatchService,
  );
  vi.spyOn(codeGraphIndexDispatchService, 'pollIndexContainer').mockImplementation(
    async (session, previous, options) => {
      const fake = fakeOrchestratorForShard(shardId);
      for (const id of fake.liveContainerIds()) fake.completeJob(id, { exitCode });
      return realPoll(session, previous, options);
    },
  );
}

async function runIndex(seeded: { installationId: string; workspaceId: string }, eventId: string) {
  const engine = new JobTestEngine({ function: codeGraphIndex });
  return (await engine.execute({
    events: [indexEventFor({ ...seeded, eventId })],
  })) as { result?: unknown; error?: { name?: string; message?: string } };
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetShardFakes();
  fleetShardOrchestratorService.resetCache();
  resetTarballBodyTrap();
  driveIndexFleetFast();
  stubIndexFleet();
  vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', 'aws');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  resetShardFakes();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a full indexer pool is a recorded wait, not a failed run (MOTIR-9451)', () => {
  it('ends as a no-op carrying the pool-full reason: paused, claim released, nothing booted, no slot', async () => {
    await account(true);
    const seeded = await seedIndexWorkspace('pool-full', 1);

    const { result, error } = await runIndex(seeded, 'evt-pool-full');

    expect(error).toBeUndefined();
    expect(result).toEqual({ indexed: false, reason: INDEX_POOL_FULL_PAUSE_REASON });
    const runs = await indexJobRuns();
    expect(runs.map((r) => r.status)).toEqual(['succeeded']);
    // No `output.repoRef`: §6's "this repo is indexed" claim is never made.
    expect(runs[0]!.output).toEqual({ indexed: false, reason: INDEX_POOL_FULL_PAUSE_REASON });
    const row = await repoRow();
    expect(row.indexPausedReason).toBe(INDEX_POOL_FULL_PAUSE_REASON);
    expect(row.indexingRunId).toBeNull();
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  }, 60_000);

  it.each(['index_cap', 'org_index_cap', 'repo_index_in_flight', 'fleet_ceiling'] as const)(
    'admission_deferred %s still fails the run after the budget, exactly as before',
    async (reason) => {
      vi.spyOn(codeGraphIndexAdmissionService, 'admit').mockResolvedValue({
        outcome: 'deferred',
        reason,
        detail: `deferred for ${reason}`,
      } as Awaited<ReturnType<typeof codeGraphIndexAdmissionService.admit>>);
      const seeded = await seedIndexWorkspace(`other-${reason.replace(/_/g, '-')}`, 1);

      const { error } = await runIndex(seeded, `evt-${reason}`);

      expect(error?.name).toBe('IndexDispatchFailedError');
      expect((await repoRow()).indexPausedReason).toBeNull();
    },
    60_000,
  );

  it('the catch-up sweep leaves it paused while the pool is full, then re-dispatches it onto the account with room', async () => {
    const full = await account(true);
    const seeded = await seedIndexWorkspace('pool-lift', 1);
    await runIndex(seeded, 'evt-pool-lift-1');
    expect((await repoRow()).indexPausedReason).toBe(INDEX_POOL_FULL_PAUSE_REASON);

    const enqueued: CodeGraphIndexData[] = [];
    const check = vi.fn();
    // The shipped pool read: admission's own chooser, read-only.
    const sweep = () =>
      codeGraphIndexCatchUpService.catchUp({
        deps: {
          check,
          enqueueRefresh: async (data) => void enqueued.push(data),
          enqueueIndex: async (data) => void enqueued.push(data),
          poolHasRoom: indexPoolHasRoom,
        },
      });

    const still = await sweep();
    expect(still.outcomes).toEqual([
      expect.objectContaining({ repoRef: INDEX_REPO_REF, outcome: 'pool_still_full' }),
    ]);
    expect(enqueued).toEqual([]);
    expect(check).not.toHaveBeenCalled();
    expect((await repoRow()).indexPausedReason).toBe(INDEX_POOL_FULL_PAUSE_REASON);

    // An account gains room.
    await adminDb.fleetShard.update({
      where: { id: full.id },
      data: { admissionPausedUntil: null },
    });
    const lifted = await sweep();
    expect(lifted.outcomes).toEqual([
      expect.objectContaining({ repoRef: INDEX_REPO_REF, outcome: 'index_enqueued' }),
    ]);
    expect(enqueued).toHaveLength(1);
    expect(check).not.toHaveBeenCalled();

    // The dispatched run boots on that account, indexes, and lifts the pause.
    accountContainersExit(full.id, 0);
    const { result } = await runIndex(
      { installationId: enqueued[0]!.installationId, workspaceId: enqueued[0]!.workspaceId },
      'evt-pool-lift-2',
    );
    expect(result).toMatchObject({ indexed: true, repoRef: INDEX_REPO_REF });
    expect(fakeOrchestratorForShard(full.id).provisioned).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    const row = await repoRow();
    expect(row.indexPausedReason).toBeNull();
  }, 90_000);
});
