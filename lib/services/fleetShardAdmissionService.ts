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
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { ciRunnerProvisioningIntentRepository as intents } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { fleetInFlightSlotRepository as slots } from '@/lib/repositories/fleetInFlightSlotRepository';
import { fleetQuotaRequestRepository } from '@/lib/repositories/fleetQuotaRequestRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { withSystemContext } from '@/lib/workspaces/context';
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
//
// A HOST ORGANISATION'S OWN ACCOUNT (Story MOTIR-9365 · MOTIR-9586), per kind:
// once the job's org has a LIVE own account of the job's kind, that account is
// the whole set — the job waits for it when it is full, paused or already tried,
// and never spills to the shared pool or to Fly. Until then the org is on the
// shared floor, the set as before. The Fly switch is still read first. The owner
// is the account row's against the job's own org id, never a caller flag, and the
// shared set never holds an `org_owned` row (it lists `primary` and `spare` only).

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
  /** Every account of the kind is full, paused or excluded. `own`: the account
   *  was the org's own (MOTIR-9586), and `detail` says so. */
  | { deferred: 'shard_capacity'; detail: string; own?: true };

/** How a provision error is read for the in-boot move. */
export type ProvisionRefusal = FleetShardMoveReason | 'job_fault';

/** The words a `shard_capacity` deferral carries. */
export const SHARD_CAPACITY_DETAIL =
  "Motir's CI capacity is full right now. This job starts when a runner finishes.";

/** The words a hosted run's `shard_capacity` deferral carries (MOTIR-9421). */
export const HOSTED_AGENT_SHARD_CAPACITY_DETAIL =
  "Motir's agent-run capacity is full right now. This run starts when another run finishes.";

/** Each kind's `shard_capacity` words; a kind with none uses CI's. */
const SHARD_CAPACITY_DETAIL_BY_KIND: Partial<Record<FleetWorkloadKind, string>> = {
  hosted_agent: HOSTED_AGENT_SHARD_CAPACITY_DETAIL,
};

/** The words for a Host org's job whose OWN account of the kind is full
 *  (MOTIR-9586) — it waits for that account, never the shared pool. */
export const OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND: Record<FleetWorkloadKind, string> = {
  ci_runner:
    "Your organization's own CI capacity is full right now. This job starts when one of your runners finishes.",
  hosted_agent:
    "Your organization's own agent-run capacity is full right now. This run starts when another of your runs finishes.",
  code_graph_index:
    "Your organization's own indexing capacity is full right now. This index starts when another of yours finishes.",
  agent_instance:
    "Your organization's own agent-hosting capacity is full right now. This agent starts when one of yours stops.",
};

/** Counts one kind's containers in flight on one account. */
type ShardInFlightCounter = (
  shardId: string,
  now: Date,
  tx: Prisma.TransactionClient,
) => Promise<number>;

/** Each kind's per-account counter. CI, the agent runner (MOTIR-9421), the
 *  agent hoster (MOTIR-9471) and the indexer (MOTIR-9445) are wired here. A
 *  slot-backed kind counts its live fleet slots on the account, never another
 *  workload's. */
const IN_FLIGHT_ON_SHARD: Partial<Record<FleetWorkloadKind, ShardInFlightCounter>> = {
  ci_runner: (shardId, _now, tx) => intents.countInFlightForShardInTx(shardId, tx),
  hosted_agent: (shardId, now, tx) =>
    slots.countLiveForWorkloadOnShardInTx('hosted_agent', shardId, now, tx),
  // The agent hoster (MOTIR-9471): every live instance placed on the account,
  // a reservation included — placement writes it inside the counting transaction.
  agent_instance: (shardId, _now, tx) => agentInstanceRepository.countLiveOnFleetShard(shardId, tx),
  code_graph_index: (shardId, now, tx) =>
    slots.countLiveForWorkloadOnShardInTx('code_graph_index', shardId, now, tx),
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
   * The accounts a job may use: its org's own LIVE account of the kind alone,
   * when it has one (MOTIR-9586) — else the active shared accounts of the kind —
   * and, for a job of one of Motir's own exempt orgs (meta or internal, the
   * {@link isUnlimitedAgentOrg} predicate), that kind's active spare too
   * (MOTIR-9456). Exemption is read here, per job, from the job's own org row in
   * the admission's transaction — never from a caller-supplied flag — so no other
   * org's job can ever be placed on a spare. The agent hoster's are its AWS
   * accounts only (MOTIR-9471): with its switch on, an instance never lands on Fly.
   */
  async selectionSetInTx(
    job: ShardPlacementJob,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard[]> {
    // The org's own LIVE account of the kind is the whole set (MOTIR-9586).
    const own = await fleetShardRepository.findLiveOrgOwnedInTx(
      job.organizationId,
      job.fleetKind,
      tx,
    );
    if (own) return [own];
    return this.sharedSetInTx(job, tx);
  },

  /** The shared accounts a job may use — `primary`, and `spare` for an exempt org. */
  async sharedSetInTx(job: ShardPlacementJob, tx: Prisma.TransactionClient): Promise<FleetShard[]> {
    const org = await organizationRepository.findByIdInTx(job.organizationId, tx);
    const roles: FleetShardRole[] =
      org && isUnlimitedAgentOrg(org) ? ['primary', 'spare'] : ['primary'];
    const shards = await fleetShardRepository.listActiveForKindInTx(job.fleetKind, roles, tx);
    return job.fleetKind === 'agent_instance'
      ? shards.filter((shard) => shard.provider === 'aws')
      : shards;
  },

  /**
   * Choose the job's account. Reads the kind's switch first; then takes the
   * account in the selection set, not paused and not excluded, with the largest
   * `effectiveCeiling − in-flight`. Ties go to the lowest id, so the choice is
   * deterministic. `switchRead: true` is a caller that already read the switch as
   * on, once, for the whole decision (the agent placement, MOTIR-9471).
   */
  async chooseInTx(
    job: ShardPlacementJob,
    now: Date,
    tx: Prisma.TransactionClient,
    options: { exclude?: ReadonlySet<string>; switchRead?: true } = {},
  ): Promise<ShardPlacement> {
    if (!options.switchRead && !(await fleetKindOnPool(job.fleetKind))) return { shardId: null };

    const countInFlight = IN_FLIGHT_ON_SHARD[job.fleetKind];
    if (!countInFlight) {
      throw new Error(`fleet kind ${job.fleetKind} has no per-account in-flight count yet`);
    }

    let best: { shardId: string; headroom: number } | null = null;
    const shards = await this.selectionSetInTx(job, tx);
    // The set is the org's own account or shared accounts, never a mix.
    const own = shards.some((shard) => shard.role === 'org_owned');
    for (const shard of shards) {
      if (options.exclude?.has(shard.id)) continue;
      if (shard.admissionPausedUntil && shard.admissionPausedUntil > now) continue;
      const ceiling = own ? await this.ownCeilingInTx(shard, tx) : this.effectiveCeiling(shard);
      const headroom = ceiling - (await countInFlight(shard.id, now, tx));
      if (headroom <= 0) continue;
      if (
        best === null ||
        headroom > best.headroom ||
        (headroom === best.headroom && shard.id < best.shardId)
      ) {
        best = { shardId: shard.id, headroom };
      }
    }
    if (best) return { shardId: best.shardId };
    if (own) {
      return {
        deferred: 'shard_capacity',
        detail: OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND[job.fleetKind],
        own: true,
      };
    }
    return {
      deferred: 'shard_capacity',
      detail: SHARD_CAPACITY_DETAIL_BY_KIND[job.fleetKind] ?? SHARD_CAPACITY_DETAIL,
    };
  },

  /**
   * An own account's ceiling (MOTIR-9586): the platform admin's override, else
   * its AWS ACCOUNT's largest granted vCPU ÷ 2 (one job is 2 vCPU), rounded down.
   * The granted value is read across every row of the account, because the
   * tracker records it on the row the raise was filed on — the merged account's
   * indexer row — and the hoster row's own `vcpuQuota` stays null. No known
   * grant ⇒ no job. The merged account's two ceilings are refined by its own card.
   */
  async ownCeilingInTx(
    shard: Pick<FleetShard, 'admissionCeilingOverride' | 'awsAccountId'>,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (shard.admissionCeilingOverride !== null) return shard.admissionCeilingOverride;
    if (!shard.awsAccountId) return 0;
    const granted = await fleetQuotaRequestRepository.maxGrantedForAwsAccountInTx(
      shard.awsAccountId,
      tx,
    );
    return shardAdmissionCeiling({ vcpuQuota: granted, machineLimit: null }) ?? 0;
  },

  /** The `shard_capacity` words for a job no account could take — its own
   *  account's when its org has a live one of the kind (MOTIR-9586). For a boot
   *  whose in-boot move found no account left, outside the admission's lock. */
  async capacityDetail(job: ShardPlacementJob): Promise<string> {
    const own = await withSystemContext((tx) =>
      fleetShardRepository.findLiveOrgOwnedInTx(job.organizationId, job.fleetKind, tx),
    );
    if (own) return OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND[job.fleetKind];
    return SHARD_CAPACITY_DETAIL_BY_KIND[job.fleetKind] ?? SHARD_CAPACITY_DETAIL;
  },

  /**
   * After `refusedShardId` refused a claim's provision: pause it for
   * `SHARD_PAUSE_SECONDS`, choose again among the job's kind excluding every
   * account this boot has tried, and move the claim there through `reassign`
   * with the reason. Null when no account is left. Inside the admission's locked
   * transaction, like the first choice.
   *
   * `reassign` is the one thing a CI move (the intent row) and a hosted-agent
   * move (the `fleet_in_flight_slot` row, MOTIR-9423) differ in; the pause, the
   * exclusion set and the choice stay this one implementation.
   */
  async moveAfterRefusalInTx(
    job: ShardPlacementJob,
    refusedShardId: string,
    reason: FleetShardMoveReason & FleetShardPauseReason,
    tried: ReadonlySet<string>,
    now: Date,
    tx: Prisma.TransactionClient,
    reassign: (
      nextShardId: string,
      reason: FleetShardMoveReason,
      tx: Prisma.TransactionClient,
    ) => Promise<unknown>,
  ): Promise<string | null> {
    await fleetShardRepository.pauseInTx(
      refusedShardId,
      new Date(now.getTime() + SHARD_PAUSE_SECONDS * 1000),
      reason,
      tx,
    );
    const next = await this.chooseInTx(job, now, tx, { exclude: tried });
    if (!('shardId' in next) || next.shardId === null) return null;
    await reassign(next.shardId, reason, tx);
    return next.shardId;
  },
};
