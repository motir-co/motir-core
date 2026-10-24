import { randomUUID } from 'node:crypto';
import type { AwsManagementApi } from '@motir/orchestrator';
import {
  PoolGrowthRefusedError,
  QuotaRequestDeniedError,
  QuotaRequestSlowError,
} from '@/lib/ciFleet/headroomErrors';
import {
  refusalBackoffMs,
  SLOW_QUOTA_REQUEST_AGE_MS,
  type GrowthResult,
} from '@/lib/ciFleet/poolGrowthPolicy';
import { fleetKindOnPool } from '@/lib/ciFleet/shardTargets';
import { FLEET_WORKLOAD_KINDS, type FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import {
  alertFleetShardHeadroom,
  type FleetHeadroomAlert,
} from '@/lib/monitoring/fleetShardHeadroomAlert';
import { fleetGrowthPassLeaseRepository } from '@/lib/repositories/fleetGrowthPassLeaseRepository';
import { fleetQuotaRequestRepository } from '@/lib/repositories/fleetQuotaRequestRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { fleetGrowthEventService } from '@/lib/services/fleetGrowthEventService';
import {
  fleetPoolGrowthService,
  type FleetPoolGrowthDeps,
} from '@/lib/services/fleetPoolGrowthService';
import { fleetQuotaRaiseService } from '@/lib/services/fleetQuotaRaiseService';
import { fleetShardHeadroomService } from '@/lib/services/fleetShardHeadroomService';
import {
  fleetManagementApi,
  fleetShardQuotaService,
  type LiveQuotaReading,
} from '@/lib/services/fleetShardQuotaService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE GROWTH PASS (Story MOTIR-9362 · MOTIR-9462) — every minute, for every
// fleet kind switched to its AWS pool:
//   (a) read every shared account's LIVE granted quota, so the 70% comparison
//       never sees a stored value;
//   (b) refresh the open quota raises, and alert once on one open a day or one
//       AWS turned down;
//   (c) per kind: finish what earlier growths started (`settleGrantedSpares`),
//       then — unless the kind is backing off a refusal — run one growth.
// Kinds are isolated: a throw in one is logged and counted, and the rest still
// run. A refused growth is recorded as one `refused` event and one audit row,
// alerted, and backed off: 30 minutes, doubling per consecutive refusal, capped
// at 6 hours, derived from the stored events so a restart changes nothing.
// AWS is reached only through the services; nothing here returns, writes or
// logs a credential.

const LOG = '[fleetPoolGrowthPass]';
const LEASE_ID = 'fleet-pool-growth-pass';
/** Longer than any pass; a crashed run's lease expires after it. */
const LEASE_MS = 10 * 60_000;

/** What one kind's turn did — result names only. */
export type KindPassOutcome = GrowthResult['result'] | 'on_fly' | 'backing_off' | 'failed';

export interface GrowthPassSummary {
  /** False when another run held the pass. */
  ran: boolean;
  kinds: Partial<Record<FleetWorkloadKind, KindPassOutcome>>;
  /** Alerts raised for slow or turned-down quota raises. */
  requestAlerts: number;
  /** Refreshes that failed — the pass went on without them. */
  failures: number;
}

export interface GrowthPassDeps {
  now?: () => Date;
  onPool?: (kind: FleetWorkloadKind) => Promise<boolean>;
  /** The management API the live read and the raise refresh reach AWS with. */
  management?: () => AwsManagementApi;
  /** The growth's own seams (the unattended add-shard's AWS and env). */
  growth?: Pick<FleetPoolGrowthDeps, 'addSpare'>;
  /** Each shared account's vCPU in use — the headroom reading. */
  readUsage?: (now: Date) => Promise<Array<{ shardId: string; usedVcpu: number }>>;
  alert?: (alert: FleetHeadroomAlert) => void;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

/** Is the kind clear of its refusal backoff at `now`? */
export async function shouldAttemptGrowth(kind: FleetWorkloadKind, now: Date): Promise<boolean> {
  const { count, latestAt } = await fleetGrowthEventService.consecutiveRefusals(kind);
  if (count === 0 || !latestAt) return true;
  return now.getTime() - latestAt.getTime() >= refusalBackoffMs(count);
}

/** A refused growth: its event and audit row together, then one alert. */
async function recordRefusal(
  result: Extract<GrowthResult, { result: 'refused' }>,
  now: Date,
  alert: (a: FleetHeadroomAlert) => void,
): Promise<void> {
  await fleetGrowthEventService.recordRefused({
    fleetKind: result.fleetKind,
    triggeringShardId: result.triggeringShardId,
    vcpuInUse: result.vcpuInUse,
    grantedQuota: result.grantedQuota,
    reason: result.reason,
    spareShardId: result.promotedSpareId,
    at: now,
  });
  const names = await withSystemContext(async (tx) => ({
    trigger: (await fleetShardRepository.findById(result.triggeringShardId, tx))?.name,
    spare: result.promotedSpareId
      ? (await fleetShardRepository.findById(result.promotedSpareId, tx))?.name
      : null,
  }));
  alert(
    new PoolGrowthRefusedError(
      result.fleetKind,
      names.trigger ?? result.triggeringShardId,
      result.reason,
      names.spare ?? null,
    ),
  );
}

/** One alert per quota raise open a day, and one per raise that closed
 *  `denied` / `not_approved`; each marked so the next pass stays quiet. */
export async function alertQuotaRequests(
  now: Date,
  alert: (a: FleetHeadroomAlert) => void,
): Promise<number> {
  return withSystemContext(async (tx) => {
    const owed = await fleetQuotaRequestRepository.listToAlertInTx(
      new Date(now.getTime() - SLOW_QUOTA_REQUEST_AGE_MS),
      tx,
    );
    for (const request of owed) {
      alert(
        request.closedAt === null
          ? new QuotaRequestSlowError(
              request.id,
              request.shard.name,
              request.fleetKind,
              request.awsRequestId,
              Math.floor((now.getTime() - request.createdAt.getTime()) / 3_600_000),
            )
          : new QuotaRequestDeniedError(
              request.id,
              request.shard.name,
              request.fleetKind,
              request.awsRequestId,
              request.status,
            ),
      );
      await fleetQuotaRequestRepository.markAlertedInTx(request.id, now, tx);
    }
    return owed.length;
  });
}

/** One kind's turn: settle, check the backoff, grow, record a refusal. */
async function runKind(
  kind: FleetWorkloadKind,
  live: readonly LiveQuotaReading[],
  usage: Array<{ shardId: string; usedVcpu: number }>,
  now: Date,
  deps: Required<Pick<GrowthPassDeps, 'onPool' | 'alert'>> & GrowthPassDeps,
): Promise<KindPassOutcome> {
  await fleetPoolGrowthService.settleGrantedSpares(kind, { onPool: deps.onPool });
  if (!(await shouldAttemptGrowth(kind, now))) return 'backing_off';
  const result = await fleetPoolGrowthService.growKind(
    kind,
    { liveQuotas: live.filter((r) => r.fleetKind === kind), usage },
    { onPool: deps.onPool, now: () => now, addSpare: deps.growth?.addSpare },
  );
  if (result.result === 'refused') await recordRefusal(result, now, deps.alert);
  return result.result;
}

/** Run `fn` holding the pass's lease, or answer null when another run holds it. */
async function withPassLease<T>(now: Date, fn: () => Promise<T>): Promise<T | null> {
  const holder = randomUUID();
  const taken = await withSystemContext((tx) =>
    fleetGrowthPassLeaseRepository.tryAcquireInTx(
      LEASE_ID,
      holder,
      now,
      new Date(now.getTime() + LEASE_MS),
      tx,
    ),
  );
  if (!taken) return null;
  try {
    return await fn();
  } finally {
    await withSystemContext((tx) =>
      fleetGrowthPassLeaseRepository.releaseInTx(LEASE_ID, holder, tx),
    );
  }
}

export const fleetPoolGrowthPassService = {
  /** One growth pass. Never throws for one kind or one refresh. */
  async runGrowthPass(deps: GrowthPassDeps = {}): Promise<GrowthPassSummary> {
    const now = (deps.now ?? (() => new Date()))();
    const onPool = deps.onPool ?? fleetKindOnPool;
    const alert = deps.alert ?? alertFleetShardHeadroom;
    const management = deps.management ?? fleetManagementApi;
    const summary: GrowthPassSummary = { ran: true, kinds: {}, requestAlerts: 0, failures: 0 };

    const ran = await withPassLease(now, async () => {
      const awsKinds: FleetWorkloadKind[] = [];
      for (const kind of FLEET_WORKLOAD_KINDS) {
        if (await onPool(kind)) awsKinds.push(kind);
        else summary.kinds[kind] = 'on_fly';
      }
      if (awsKinds.length === 0) return;

      // (a) The live read — before any growth decision.
      let live: LiveQuotaReading[] = [];
      try {
        live = await fleetShardQuotaService.refreshLiveGrantedQuotas(undefined, {
          management,
          onPool,
          now: () => now,
        });
      } catch (err) {
        summary.failures += 1;
        console.error(`${LOG} live quota read failed`, { error: errorName(err) });
      }
      // (b) The open raises, then their alerts.
      try {
        await fleetQuotaRaiseService.refreshOpenRequests(undefined, { management, now: () => now });
        summary.requestAlerts = await alertQuotaRequests(now, alert);
      } catch (err) {
        summary.failures += 1;
        console.error(`${LOG} quota request refresh failed`, { error: errorName(err) });
      }
      const usage = await (deps.readUsage ?? readUsage)(now);

      // (c) Each kind on its own.
      for (const kind of awsKinds) {
        try {
          summary.kinds[kind] = await runKind(kind, live, usage, now, { ...deps, onPool, alert });
        } catch (err) {
          summary.kinds[kind] = 'failed';
          console.error(`${LOG} growth failed for a kind`, {
            fleetKind: kind,
            error: errorName(err),
          });
        }
      }
    });
    if (ran === null) return { ...summary, ran: false };
    return summary;
  },
};

async function readUsage(now: Date): Promise<Array<{ shardId: string; usedVcpu: number }>> {
  return (await fleetShardHeadroomService.readAccountHeadroom(now)).map((r) => ({
    shardId: r.shardId,
    usedVcpu: r.usedVcpu,
  }));
}
