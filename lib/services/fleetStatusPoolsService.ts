import 'server-only';

import type { FleetShard, Prisma } from '@/generated/prisma/client';
import {
  createEc2VcpuQuotaReader,
  EC2_STANDARD_VCPU_QUOTA,
  type Ec2VcpuQuotaReader,
} from '@/lib/awsServices/ec2VcpuQuotaReader';
import { isCloud } from '@/lib/billing/availability';
import {
  INSTALL_FLEET_ELIGIBLE_KINDS,
  INSTALL_FLEET_TAG,
  installFleetMachineVcpu,
  installFleetTakesKind,
} from '@/lib/ciFleet/installFleet';
import { HEADROOM_ALERT_FRACTION, shardAdmissionCeiling } from '@/lib/ciFleet/shardTargets';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import type {
  InstallFleetBlockDTO,
  InstallPoolDTO,
  InstallQuotaDTO,
  ShardAccountDTO,
  ShardBlockDTO,
  ShardPoolDTO,
  ShardSizeSourceDTO,
} from '@/lib/dto/fleetStatusPools';
import type { PlatformPoolBlockDTO } from '@/lib/dto/platformFleetPools';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { platformAwsReadRepository } from '@/lib/repositories/platformAwsReadRepository';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { platformFleetPoolsService } from '@/lib/services/platformFleetPoolsService';
import { withSystemContext } from '@/lib/workspaces/context';

/**
 * THE FLEET STATUS PAGE'S POOLS SECTION (MOTIR-10887; design MOTIR-10885) — how
 * big each fleet pool is and how many machines run in it now. Superadmin only.
 * Read once per page load; nothing is cached and nothing polls.
 *
 * TWO BLOCKS, EACH READ ON ITS OWN. The page renders each behind its own
 * `<Suspense>` and each method below catches its own failure into
 * `{ status: 'unavailable' }`, so one source that does not answer leaves the
 * other block whole (Panel 9).
 *
 * THE INSTALL FLEET — Motir's own organisation's machines in core's own account
 * (MOTIR-10794). Its running counts are the records admission counts
 * (`FLEET_WORKLOADS`): a live `fleet_in_flight_slot` of the kind on NO account
 * (`fleet_shard_id` null — the pseudo-account id is never stored, MOTIR-10858)
 * held by the install's own org (the meta org on cloud, any org with cloud off),
 * the same pair `codeGraphIndexAdmissionService` exempts from the shared caps.
 * For the agent hoster those slots are the AWAKE instances; the hibernated ones
 * are its live instances on the install fleet's app in `hibernated`. A machine's
 * vCPU is its instance type's. The one quota is the account's EC2 On-Demand
 * standard vCPU quota, read from Service Quotas on each load; no pool has a size.
 *
 * THE ADD-SHARD ACCOUNTS — `platformFleetPoolsService` (Monitoring → Pools)
 * supplies each kind's switch, its shared accounts and spares and their granted
 * quota, so the two pages cannot disagree. Beside each account: its admission
 * ceiling (`effectiveCeiling` — the override, else the granted quota's ceiling),
 * its pause, and the machines admission counts on it
 * (`fleetShardAdmissionService.countInFlightOnShardInTx`, grouped by
 * `fleet_shard_id`).
 *
 * ⚠️ AN UNREAD FIGURE IS NEVER A NUMBER. An unread quota is `notRead` with the
 * time of its last good read (`platform_aws_read` keeps only WHEN); every figure
 * computed from it is null. A pool with an account whose size is unknown has no
 * size, never a partial sum.
 *
 * ⚠️ SYSTEM CONTEXT for the counts. They span every tenant: under a workspace
 * context they would come back smaller and still look believable.
 */

const QUOTA_SUBJECT = `servicequotas:${EC2_STANDARD_VCPU_QUOTA.serviceCode}/${EC2_STANDARD_VCPU_QUOTA.quotaCode}`;

/** Whole percent, rounded as Monitoring → Pools rounds it. */
function percentOf(part: number, whole: number): number {
  return Math.round((part * 100) / whole);
}

/** The pool's flag: at size from 100%, near from 70%. */
function sizeFlag(running: number, size: number | null): 'near' | 'atSize' | null {
  if (size === null || size <= 0) return null;
  if (running >= size) return 'atSize';
  return running >= size * HEADROOM_ALERT_FRACTION ? 'near' : null;
}

export interface FleetStatusPoolsReadOptions {
  now?: Date;
  reader?: Ec2VcpuQuotaReader;
}

// ── The install fleet ─────────────────────────────────────────────────────────

interface InstallCounts {
  running: Map<FleetWorkloadKind, number>;
  hibernated: number;
}

async function readInstallCounts(now: Date): Promise<InstallCounts> {
  return withSystemContext(async (tx) => {
    const orgIds = isCloud() ? await organizationRepository.listMetaIdsInTx(tx) : null;
    const running = new Map<FleetWorkloadKind, number>();
    for (const kind of INSTALL_FLEET_ELIGIBLE_KINDS) {
      if (!installFleetTakesKind(kind)) continue;
      running.set(
        kind,
        await fleetInFlightSlotRepository.countLiveUnplacedForWorkload(kind, orgIds, now, tx),
      );
    }
    const hibernated = installFleetTakesKind('agent_instance')
      ? await agentInstanceRepository.countLiveInUnshardedAppByState(
          INSTALL_FLEET_TAG,
          'hibernated',
          tx,
        )
      : 0;
    return { running, hibernated };
  });
}

/** The install block from its counts and its quota. Exported for its tests. */
export function judgeInstallBlock(
  counts: InstallCounts,
  quota: InstallQuotaDTO,
): Extract<InstallFleetBlockDTO, { status: 'ok' }> {
  const quotaVcpu = quota.status === 'ok' ? quota.vcpu : null;
  const pools = INSTALL_FLEET_ELIGIBLE_KINDS.map((kind): InstallPoolDTO => {
    const running = counts.running.get(kind);
    if (running === undefined) return { fleetKind: kind, enabled: false };
    const machineVcpu = installFleetMachineVcpu(kind);
    const vcpu = machineVcpu === null ? null : running * machineVcpu;
    return {
      fleetKind: kind,
      enabled: true,
      running,
      hibernated: kind === 'agent_instance' ? counts.hibernated : null,
      machineVcpu,
      vcpu,
      sharePercent:
        vcpu !== null && quotaVcpu !== null && quotaVcpu > 0 ? percentOf(vcpu, quotaVcpu) : null,
    };
  });

  let usedVcpu: number | null = 0;
  for (const pool of pools) {
    if (!pool.enabled) continue;
    usedVcpu = usedVcpu === null || pool.vcpu === null ? null : usedVcpu + pool.vcpu;
  }
  const known = usedVcpu !== null && quotaVcpu !== null && quotaVcpu > 0;
  return {
    status: 'ok',
    quota,
    usedVcpu,
    percent: known ? percentOf(usedVcpu!, quotaVcpu!) : null,
    nearQuota: known && usedVcpu! >= quotaVcpu! * HEADROOM_ALERT_FRACTION,
    leftVcpu: usedVcpu !== null && quotaVcpu !== null ? Math.max(0, quotaVcpu - usedVcpu) : null,
    pools,
  };
}

// ── The add-shard accounts ────────────────────────────────────────────────────

type AwsPoolBlock = Extract<PlatformPoolBlockDTO, { provider: 'aws' }>;

/**
 * Which limit sets the account's size: the override, else whichever of the
 * granted quota and the machine limit `shardAdmissionCeiling` took the minimum
 * of. A tie reads as the granted quota, the one Monitoring → Pools shows.
 */
function accountSizeSource(
  shard: FleetShard,
  override: number | null,
  sizeMachines: number | null,
): ShardSizeSourceDTO | null {
  if (override !== null) return 'override';
  if (sizeMachines === null) return null;
  if (shard.vcpuQuota === null) return 'machineLimit';
  const fromQuota = shardAdmissionCeiling({ vcpuQuota: shard.vcpuQuota, machineLimit: null });
  return fromQuota === sizeMachines ? 'granted' : 'machineLimit';
}

function accountRow(
  shard: FleetShard,
  role: 'shared' | 'spare',
  grantedVcpu: number | null,
  grantedReadAt: string | null,
  running: number,
  now: Date,
): ShardAccountDTO {
  const override = shard.admissionCeilingOverride;
  // The ceiling admission uses (`effectiveCeiling`), except that an account with
  // no override and no limit read has none — never admission's fallback of 0.
  const sizeMachines =
    override ??
    shardAdmissionCeiling({ vcpuQuota: shard.vcpuQuota, machineLimit: shard.machineLimit });
  const paused = shard.admissionPausedUntil !== null && shard.admissionPausedUntil > now;
  return {
    name: shard.name,
    role,
    state: shard.state,
    sizeMachines,
    sizeSource: accountSizeSource(shard, override, sizeMachines),
    grantedVcpu,
    grantedReadAt,
    running,
    pausedUntil: paused ? shard.admissionPausedUntil!.toISOString() : null,
    pausedReason: paused
      ? ((shard.admissionPausedReason as ShardAccountDTO['pausedReason']) ?? null)
      : null,
  };
}

async function shardPool(
  block: AwsPoolBlock,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<ShardPoolDTO> {
  const kind = block.fleetKind;
  const rows = await fleetShardRepository.listByRole(null, { fleetKind: kind }, tx);
  const byName = new Map(rows.map((row) => [row.name, row]));
  const running = (shard: FleetShard) =>
    fleetShardAdmissionService.countInFlightOnShardInTx(kind, shard.id, now, tx);

  const accounts: ShardAccountDTO[] = [];
  for (const account of block.accounts) {
    const shard = byName.get(account.name);
    if (!shard) continue;
    accounts.push(
      accountRow(
        shard,
        'shared',
        account.grantedVcpu,
        account.grantedReadAt,
        await running(shard),
        now,
      ),
    );
  }
  const shared = accounts.length;
  for (const spare of block.spares) {
    const shard = byName.get(spare.name);
    if (!shard) continue;
    accounts.push(
      accountRow(shard, 'spare', spare.grantedVcpu, spare.grantedReadAt, await running(shard), now),
    );
  }

  // The size is the sum of the ACTIVE shared accounts' ceilings — admission's
  // candidates (`listActiveForKindInTx`); a partial sum is never the size.
  const counted = accounts.filter((a) => a.role === 'shared' && a.state === 'active');
  const notReadCount = counted.filter((a) => a.sizeMachines === null).length;
  const sizeMachines =
    counted.length === 0 || notReadCount > 0
      ? null
      : counted.reduce((n, a) => n + a.sizeMachines!, 0);
  const runningShared = accounts
    .filter((a) => a.role === 'shared')
    .reduce((n, a) => n + a.running, 0);

  return {
    fleetKind: kind,
    provider: 'aws',
    accounts,
    sharedCount: shared,
    spareNames: block.spares.map((s) => s.name),
    sizeMachines,
    notReadCount,
    running: runningShared,
    percent:
      sizeMachines !== null && sizeMachines > 0 ? percentOf(runningShared, sizeMachines) : null,
    flag: sizeFlag(runningShared, sizeMachines),
  };
}

export const fleetStatusPoolsService = {
  /**
   * The install-fleet block: the three pools' running machines and vCPU against
   * the account's EC2 vCPU quota. One `fleet.status.read` audit row per call,
   * written with the quota's read mark.
   */
  async readInstallFleet(
    principal: PlatformPrincipal,
    options: FleetStatusPoolsReadOptions = {},
  ): Promise<InstallFleetBlockDTO> {
    await requirePlatformStaff('superadmin');
    const now = options.now ?? new Date();
    const reader = options.reader ?? createEc2VcpuQuotaReader();

    // The AWS call runs BEFORE the audited transaction, which holds the audit
    // chain lock until it commits (`platformServicesService`'s order).
    const [countsRead, quotaRead] = await Promise.allSettled([
      readInstallCounts(now),
      reader.readStandardVcpuQuota(),
    ]);
    if (quotaRead.status === 'rejected') logFailure('install quota', quotaRead.reason);
    if (countsRead.status === 'rejected') {
      logFailure('install fleet', countsRead.reason);
      return { status: 'unavailable' };
    }

    try {
      const mark = await withPlatformRead(
        principal,
        {
          action: 'fleet.status.read',
          targetKind: 'platform',
          targetId: 'fleet_pools.install',
          metadata: { quotaRead: quotaRead.status === 'fulfilled' },
        },
        async (tx) => {
          if (quotaRead.status === 'fulfilled') {
            return platformAwsReadRepository.markRead({ subject: QUOTA_SUBJECT, readAt: now }, tx);
          }
          const [row] = await platformAwsReadRepository.findMany([QUOTA_SUBJECT], tx);
          return row ?? null;
        },
      );
      const quota: InstallQuotaDTO =
        quotaRead.status === 'fulfilled'
          ? { status: 'ok', vcpu: quotaRead.value, readAt: now.toISOString() }
          : { status: 'notRead', lastReadAt: mark?.readAt.toISOString() ?? null };
      return judgeInstallBlock(countsRead.value, quota);
    } catch (err) {
      logFailure('install fleet', err);
      return { status: 'unavailable' };
    }
  },

  /**
   * The add-shard block: per fleet kind, its size, accounts, spare and running
   * machines, and each account's size, running count and pause. Monitoring →
   * Pools' read underneath (its own `estate.read` audit row).
   */
  async readAddShard(
    principal: PlatformPrincipal,
    options: { now?: Date } = {},
  ): Promise<ShardBlockDTO> {
    await requirePlatformStaff('superadmin');
    const now = options.now ?? new Date();
    try {
      const { blocks } = await platformFleetPoolsService.listPools(principal, now);
      const pools: ShardPoolDTO[] = [];
      for (const block of blocks) {
        if (block.provider !== 'aws') {
          pools.push({ fleetKind: block.fleetKind, provider: block.provider });
          continue;
        }
        try {
          pools.push(await withSystemContext((tx) => shardPool(block, now, tx)));
        } catch (err) {
          logFailure(`${block.fleetKind} add-shard pool`, err);
          pools.push({ fleetKind: block.fleetKind, provider: 'unavailable' });
        }
      }
      return {
        status: 'ok',
        pools,
        nearCount: pools.filter((p) => p.provider === 'aws' && p.flag !== null).length,
      };
    } catch (err) {
      logFailure('add-shard pools', err);
      return { status: 'unavailable' };
    }
  },
};

/** The failure, by its error NAME only — an AWS message can carry ARNs and request ids. */
function logFailure(what: string, reason: unknown): void {
  console.error(`[admin] fleet status ${what} read failed`, {
    error: reason instanceof Error ? reason.name : 'unknown',
  });
}
