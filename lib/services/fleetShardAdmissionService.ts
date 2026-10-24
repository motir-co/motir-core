import type {
  FleetShard,
  FleetShardMoveReason,
  FleetShardRole,
  FleetShardPauseReason,
  Prisma,
} from '@/generated/prisma/client';
import {
  OrchestratorApiError,
  OrchestratorCapacityError,
  OrchestratorImageUnpullableError,
  OrchestratorNotConfiguredError,
  OrchestratorTimeoutError,
  type FleetWorkloadKind,
} from '@motir/orchestrator';
import {
  fleetKindOnPool,
  SHARD_PAUSE_SECONDS,
  shardAdmissionCeiling,
} from '@/lib/ciFleet/shardTargets';
import { isUnlimitedAgentOrg } from '@/lib/agentInstances/config';
import { ciRunnerProvisioningIntentRepository as intents } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';

// WHICH ACCOUNT A JOB'S MACHINE BOOTS ON (Story MOTIR-8953 · MOTIR-8968) — the
// admission order of `docs/decisions/fleet-per-org-pool.md` AMENDMENT 1:
//
//   1. a kind whose Fly↔AWS switch is Fly takes today's path: no account, the
//      process-wide Fly fleet;
//   2. a kind on its pool takes the active shared account of that kind with the
//      most headroom under its effective ceiling, skipping paused accounts;
//   3. no account has room → defer `shard_capacity`. Never lost, never Fly.
//
// ⚠️ CALLED ONLY FROM INSIDE THE ADMISSION'S LOCKED TRANSACTION (it already holds
// `FLEET_ADMISSION_SCOPE`). The per-account count is read-derived, so it is exact
// only if the account is written in the same transaction that counted it — that
// is the claim's. No lock is taken here.
//
// The selection set — WHICH accounts a job may use — is one method,
// `selectionSetInTx`, so the pool-growth story (a Motir spare only for Motir's
// orgs) and the Host-accounts story (a Host org's own account) change the set,
// never the choice.

/** The job admission places. */
export interface ShardPlacementJob {
  fleetKind: FleetWorkloadKind;
  organizationId: string;
}

export type ShardPlacement =
  /** Boot on this account. */
  | { shardId: string }
  /** The kind's switch is Fly: boot on the process-wide fleet, as today. */
  | { shardId: null }
  /** Every account of the kind is full, paused or excluded. */
  | { deferred: 'shard_capacity'; detail: string };

/** How a provision error is read for the in-boot move. */
export type ProvisionRefusal = FleetShardMoveReason | 'job_fault';

/** The words a `shard_capacity` deferral carries. */
export const SHARD_CAPACITY_DETAIL =
  "Motir's CI capacity is full right now. This job starts when a runner finishes.";

/** Counts one kind's containers in flight on one account. */
type ShardInFlightCounter = (shardId: string, tx: Prisma.TransactionClient) => Promise<number>;

/** Each kind's per-account counter. CI is wired here; the agent runner, indexer
 *  and agent hoster stories add theirs when they put their kind on its pool. */
const IN_FLIGHT_ON_SHARD: Partial<Record<FleetWorkloadKind, ShardInFlightCounter>> = {
  ci_runner: (shardId, tx) => intents.countInFlightForShardInTx(shardId, tx),
};

/**
 * Read a provision error for the in-boot move. `capacity_refused` — the
 * provider is full (`OrchestratorCapacityError`); `provider_unavailable` — the
 * provider is down or the account cannot be reached (a timeout, an API error with
 * no status or a 5xx, an account orchestrator that is not configured);
 * `job_fault` — anything else, which keeps today's settle path. An unpullable
 * image is a `job_fault`: it is about the deployment, not the account.
 */
export function classifyProvisionRefusal(err: unknown): ProvisionRefusal {
  if (err instanceof OrchestratorCapacityError) return 'capacity_refused';
  if (err instanceof OrchestratorTimeoutError) return 'provider_unavailable';
  if (err instanceof OrchestratorNotConfiguredError) return 'provider_unavailable';
  if (
    err instanceof OrchestratorApiError &&
    !(err instanceof OrchestratorImageUnpullableError) &&
    (err.status === null || err.status >= 500)
  ) {
    return 'provider_unavailable';
  }
  return 'job_fault';
}

export const fleetShardAdmissionService = {
  /**
   * An account's ceiling: the platform admin's override, else the one derived
   * from its recorded limits. An account with neither has no known ceiling and
   * takes no job — an unknown limit is treated as a full account.
   */
  effectiveCeiling(
    shard: Pick<FleetShard, 'admissionCeilingOverride' | 'vcpuQuota' | 'machineLimit'>,
  ): number {
    return (
      shard.admissionCeilingOverride ??
      shardAdmissionCeiling({ vcpuQuota: shard.vcpuQuota, machineLimit: shard.machineLimit }) ??
      0
    );
  },

  /**
   * The accounts a job may use: the active shared accounts of its fleet kind —
   * and, for a job of one of Motir's own exempt orgs (meta or internal, the
   * {@link isUnlimitedAgentOrg} predicate), that kind's active spare too
   * (MOTIR-9456). Exemption is read here, per job, from the job's own org row in
   * the admission's transaction — never from a caller-supplied flag — so no other
   * org's job can ever be placed on a spare.
   */
  async selectionSetInTx(
    job: ShardPlacementJob,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard[]> {
    const org = await organizationRepository.findByIdInTx(job.organizationId, tx);
    const roles: FleetShardRole[] =
      org && isUnlimitedAgentOrg(org) ? ['primary', 'spare'] : ['primary'];
    return fleetShardRepository.listActiveForKindInTx(job.fleetKind, roles, tx);
  },

  /**
   * Choose the job's account. Reads the kind's switch first; then takes the
   * account in the selection set, not paused and not excluded, with the largest
   * `effectiveCeiling − in-flight`. Ties go to the lowest id, so the choice is
   * deterministic.
   */
  async chooseInTx(
    job: ShardPlacementJob,
    now: Date,
    tx: Prisma.TransactionClient,
    options: { exclude?: ReadonlySet<string> } = {},
  ): Promise<ShardPlacement> {
    if (!(await fleetKindOnPool(job.fleetKind))) return { shardId: null };

    const countInFlight = IN_FLIGHT_ON_SHARD[job.fleetKind];
    if (!countInFlight) {
      throw new Error(`fleet kind ${job.fleetKind} has no per-account in-flight count yet`);
    }

    let best: { shardId: string; headroom: number } | null = null;
    for (const shard of await this.selectionSetInTx(job, tx)) {
      if (options.exclude?.has(shard.id)) continue;
      if (shard.admissionPausedUntil && shard.admissionPausedUntil > now) continue;
      const headroom = this.effectiveCeiling(shard) - (await countInFlight(shard.id, tx));
      if (headroom <= 0) continue;
      if (
        best === null ||
        headroom > best.headroom ||
        (headroom === best.headroom && shard.id < best.shardId)
      ) {
        best = { shardId: shard.id, headroom };
      }
    }
    return best
      ? { shardId: best.shardId }
      : { deferred: 'shard_capacity', detail: SHARD_CAPACITY_DETAIL };
  },

  /**
   * After `refusedShardId` refused a CI intent's provision: pause it for
   * `SHARD_PAUSE_SECONDS`, choose again excluding every account this boot has
   * tried, and move the claim there with the reason. Null when no account is
   * left. Inside the admission's locked transaction, like the first choice.
   */
  async moveAfterRefusalInTx(
    intent: { id: string; organizationId: string },
    refusedShardId: string,
    reason: FleetShardMoveReason & FleetShardPauseReason,
    tried: ReadonlySet<string>,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    await fleetShardRepository.pauseInTx(
      refusedShardId,
      new Date(now.getTime() + SHARD_PAUSE_SECONDS * 1000),
      reason,
      tx,
    );
    const next = await this.chooseInTx(
      { fleetKind: 'ci_runner', organizationId: intent.organizationId },
      now,
      tx,
      { exclude: tried },
    );
    if (!('shardId' in next) || next.shardId === null) return null;
    await intents.reassignShardInTx(intent.id, next.shardId, reason, tx);
    return next.shardId;
  },
};
