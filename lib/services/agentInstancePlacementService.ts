import {
  OrchestratorCapacityError,
  type PersistentContainerHandle,
  type PersistentContainerOrchestrator,
  type PersistentContainerSpec,
} from '@motir/orchestrator';
import type { AgentInstance, FleetShard } from '@/generated/prisma/client';
import { AgentInstancePlacementError } from '@/lib/agentInstances/errors';
import { fleetKindOnPool, SHARD_PAUSE_SECONDS } from '@/lib/ciFleet/shardTargets';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { toFleetShardDTO } from '@/lib/mappers/fleetShardMappers';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import {
  ciFleetAdmissionLockRepository as locks,
  FLEET_ADMISSION_SCOPE,
} from '@/lib/repositories/ciFleetAdmissionLockRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';

// WHERE A NEW AGENT INSTANCE LIVES (Story MOTIR-9361 · MOTIR-9471). One decision,
// three answers:
//
//   - the agent hoster's Fly↔AWS switch is off → `fly`: the process-wide Fly
//     orchestrator, no account recorded, exactly as before;
//   - it is on and an AWS hoster account has room → `aws`: the machine and its
//     disk are created on the account with the most headroom, in a zone fixed for
//     the instance's life, and the account and zone are recorded on the row;
//   - it is on and every account refused or is full → `pool_full`: nothing is
//     created and nothing is recorded. Never Fly.
//
// The switch is read ONCE, here, at create. A wake, a hibernate or a delete reads
// the account recorded on the row and never the switch (the routing card).
//
// THE SHAPE IS ADMISSION'S (`fleetShardAdmissionService` header): lock, decide,
// commit, then the provider call. The per-account count is read-derived, so the
// account and zone are RESERVED on the row inside the locked transaction that
// counted them; the provision comes after commit. A capacity refusal releases the
// reservation, pauses the account as admission does, and the next account is
// chosen under the lock again. Any other provider error releases it and is
// raised — never moved to the next account, never to Fly.
//
// The account's orchestrator is INJECTED (`deps.persistentOrchestratorForShard`):
// the composition-root wiring is the routing card's.

/** The instance to place. Its row exists, with no account and no machine. */
export interface AgentInstancePlacementInput {
  readonly instanceId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  /** The instance's spec; placement supplies the region and, on AWS, the zone. */
  readonly spec: Omit<PersistentContainerSpec, 'region' | 'availabilityZone'>;
}

export interface AgentInstancePlacementDeps {
  /** The persistent orchestrator for ONE account. */
  readonly persistentOrchestratorForShard: (
    shard: FleetShardDTO,
  ) => PersistentContainerOrchestrator;
  /** The process-wide Fly orchestrator — the switch-off path. */
  readonly flyOrchestrator: () => PersistentContainerOrchestrator;
  readonly now?: () => Date;
}

export type AgentInstancePlacementOutcome =
  /** The switch is off: provisioned on the process-wide Fly app, no account. */
  | { outcome: 'fly'; handle: PersistentContainerHandle }
  /**
   * Placed on an AWS hoster account. `handle` is null only when another
   * placement of the same instance already holds it (`placedElsewhere`): this
   * call created nothing that survives.
   */
  | {
      outcome: 'aws';
      fleetShardId: string;
      availabilityZone: string | null;
      handle: PersistentContainerHandle | null;
      placedElsewhere?: true;
    }
  /** Every account refused or had no headroom. Nothing created, nothing recorded. */
  | { outcome: 'pool_full'; refusedShardIds: string[] };

/**
 * The zone an account's new disks go in: the account's region's first zone. The
 * account record keeps no zone of its own; the lifecycle adapter refuses a spec
 * without one.
 */
export function placementZoneFor(shard: Pick<FleetShard, 'awsRegion'>): string {
  if (!shard.awsRegion) throw new Error('an AWS hoster account names no region');
  return `${shard.awsRegion}a`;
}

/** The existing placement on the row — the answer when another call won. */
function placedElsewhere(row: AgentInstance | null): AgentInstancePlacementOutcome {
  if (!row?.fleetShardId) return { outcome: 'pool_full', refusedShardIds: [] };
  const handle =
    row.flyApp && row.machineId && row.volumeId
      ? {
          provider: 'aws' as const,
          app: row.flyApp,
          machineId: row.machineId,
          volumeId: row.volumeId,
          region: row.region,
          createdAt: row.createdAt,
        }
      : null;
  return {
    outcome: 'aws',
    fleetShardId: row.fleetShardId,
    availabilityZone: row.availabilityZone,
    handle,
    placedElsewhere: true,
  };
}

/** Read the row inside a system transaction bound to its workspace. */
async function readRow(input: AgentInstancePlacementInput): Promise<AgentInstance | null> {
  return withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, input.workspaceId);
    return agentInstanceRepository.findById(input.instanceId, tx);
  });
}

type Reservation =
  | { kind: 'reserved'; shard: FleetShard; availabilityZone: string }
  | { kind: 'full' }
  | { kind: 'taken' };

/** Lock, choose the account with most headroom, and reserve it on the row. */
async function reserve(
  input: AgentInstancePlacementInput,
  tried: ReadonlySet<string>,
  now: Date,
): Promise<Reservation> {
  return withSystemContext(async (tx) => {
    await locks.ensureScope(FLEET_ADMISSION_SCOPE, tx);
    if (!(await locks.lockScope(FLEET_ADMISSION_SCOPE, tx))) {
      throw new Error('the fleet admission lock could not be taken');
    }
    const choice = await fleetShardAdmissionService.chooseInTx(
      { fleetKind: 'agent_instance', organizationId: input.organizationId },
      now,
      tx,
      { exclude: tried, switchRead: true },
    );
    if (!('shardId' in choice) || choice.shardId === null) return { kind: 'full' as const };
    const shard = await fleetShardRepository.findById(choice.shardId, tx);
    /* v8 ignore next -- chosen from the same locked read: the row is there. */
    if (!shard) return { kind: 'full' as const };
    const availabilityZone = placementZoneFor(shard);
    // Every count is behind us: from here the transaction writes the tenant row.
    await bindWorkspaceContext(tx, input.workspaceId);
    const { applied } = await agentInstanceRepository.recordPlacement(
      input.instanceId,
      { fleetShardId: shard.id, availabilityZone },
      tx,
    );
    return applied
      ? { kind: 'reserved' as const, shard, availabilityZone }
      : { kind: 'taken' as const };
  });
}

/** Give a refused reservation back; on a capacity refusal, pause the account too. */
async function release(
  input: AgentInstancePlacementInput,
  shardId: string,
  pauseUntil: Date | null,
): Promise<void> {
  await withSystemContext(async (tx) => {
    if (pauseUntil) {
      await fleetShardRepository.pauseInTx(shardId, pauseUntil, 'capacity_refused', tx);
    }
    await bindWorkspaceContext(tx, input.workspaceId);
    await agentInstanceRepository.releasePlacement(input.instanceId, shardId, tx);
  });
}

export const agentInstancePlacementService = {
  /** Place one new agent instance and create its machine and disk there. */
  async placeAndProvision(
    input: AgentInstancePlacementInput,
    deps: AgentInstancePlacementDeps,
  ): Promise<AgentInstancePlacementOutcome> {
    const now = deps.now ?? (() => new Date());
    // THE ONE READ OF THE SWITCH.
    if (!(await fleetKindOnPool('agent_instance'))) {
      const fly = deps.flyOrchestrator();
      const handle = await fly.provisionPersistent({ ...input.spec, region: fly.defaultRegion() });
      return { outcome: 'fly', handle };
    }

    const tried = new Set<string>();
    for (;;) {
      const reservation = await reserve(input, tried, now());
      if (reservation.kind === 'full') return { outcome: 'pool_full', refusedShardIds: [...tried] };
      if (reservation.kind === 'taken') return placedElsewhere(await readRow(input));

      const { shard, availabilityZone } = reservation;
      tried.add(shard.id);
      const orchestrator = deps.persistentOrchestratorForShard(toFleetShardDTO(shard));
      let handle: PersistentContainerHandle;
      try {
        handle = await orchestrator.provisionPersistent({
          ...input.spec,
          region: shard.awsRegion!,
          availabilityZone,
        });
      } catch (err) {
        if (err instanceof OrchestratorCapacityError) {
          await release(input, shard.id, new Date(now().getTime() + SHARD_PAUSE_SECONDS * 1000));
          continue;
        }
        await release(input, shard.id, null);
        throw new AgentInstancePlacementError(shard.id, err);
      }

      const { applied } = await withSystemContext(async (tx) => {
        await bindWorkspaceContext(tx, input.workspaceId);
        return agentInstanceRepository.setPlacedHandle(
          input.instanceId,
          shard.id,
          { flyApp: handle.app, machineId: handle.machineId, volumeId: handle.volumeId },
          tx,
        );
      });
      if (!applied) {
        // The placement is no longer this call's: leave no machine and no disk.
        await orchestrator.destroyPersistent(handle);
        return placedElsewhere(await readRow(input));
      }
      return { outcome: 'aws', fleetShardId: shard.id, availabilityZone, handle };
    }
  },
};
