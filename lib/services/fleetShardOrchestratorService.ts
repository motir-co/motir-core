import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { OrchestratorNotConfiguredError } from '@motir/orchestrator';
import {
  getOrchestrator,
  getPersistentOrchestrator,
  orchestratorForShard,
  persistentOrchestratorForShard,
  type ContainerOrchestrator,
  type PersistentContainerOrchestrator,
} from '@/lib/orchestrator';
import { fleetShardService } from '@/lib/services/fleetShardService';

// WHICH ORCHESTRATOR a CI-runner container is reached through (Story MOTIR-8953 ·
// MOTIR-8964) — the one seam every container path (boot, poll, settle, stop,
// reap, the volume sweep) resolves through.
//
// `null` is a first-class account: "the process-wide fleet". It is what every
// intent and memoised session from before accounts existed resolves to, what
// every non-CI workload keeps using, and what a fleet kind whose switch is Fly
// boots on. Which account a NEW boot goes to is admission's choice, written at
// the claim (`fleetShardAdmissionService`, MOTIR-8968); this only resolves it.

interface CachedOrchestrator {
  updatedAt: string;
  orchestrator: ContainerOrchestrator;
}

/** Per process, keyed on the account id and rebuilt when its row changes, so a
 *  rotated credential or a moved app is picked up without a deploy. */
const cache = new Map<string, CachedOrchestrator>();

export const fleetShardOrchestratorService = {
  /** The orchestrator for an account row. */
  forShardRow(shard: FleetShardDTO): ContainerOrchestrator {
    const cached = cache.get(shard.id);
    if (cached && cached.updatedAt === shard.updatedAt) return cached.orchestrator;
    const orchestrator = orchestratorForShard(shard);
    cache.set(shard.id, { updatedAt: shard.updatedAt, orchestrator });
    return orchestrator;
  },

  /** The orchestrator for an account id — `null` is the process-wide fleet. An
   *  account is reached whatever its state: a `disabled` one still has
   *  containers to poll, settle and reap. */
  async forShard(shardId: string | null): Promise<ContainerOrchestrator> {
    if (shardId === null) return getOrchestrator();
    return this.forShardRow(await fleetShardService.getShard(shardId));
  },

  /** The orchestrator for the account an intent's container was booted in. */
  async forIntent(
    intent: Pick<CiRunnerProvisioningIntent, 'fleetShardId'>,
  ): Promise<ContainerOrchestrator> {
    return this.forShard(intent.fleetShardId);
  },

  /**
   * THE PERSISTENT orchestrator for ONE agent instance, from the account recorded
   * on its row (Story MOTIR-9361 · MOTIR-9472) — never the agent hoster's switch,
   * which only placement reads, at create. A null account is the process-wide
   * Fly app (or the fake), exactly {@link getPersistentOrchestrator}. A recorded
   * account that cannot be read is a typed not-configured error naming it, and is
   * never routed to Fly. A disabled account is still reached: its instances still
   * have to be stopped and deleted where their disks are.
   */
  async persistentOrchestratorFor(placement: {
    fleetShardId: string | null;
  }): Promise<PersistentContainerOrchestrator> {
    if (placement.fleetShardId === null) return getPersistentOrchestrator();
    let shard: FleetShardDTO;
    try {
      shard = await fleetShardService.getShard(placement.fleetShardId);
    } catch {
      throw new OrchestratorNotConfiguredError(
        `fleet account ${placement.fleetShardId} is not on record`,
      );
    }
    return persistentOrchestratorForShard(shard);
  },

  /** Forget every cached account orchestrator — for tests. */
  resetCache(): void {
    cache.clear();
  },
};
