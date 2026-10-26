// Importing it wires the agent runner's and the agent hoster's switches, so this
// read answers each kind's switch as admission does.
import '@/lib/ciFleet/fleetKindSwitches';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import type { FleetPoolAccountDTO, FleetQuotaRequestStatusDTO } from '@/lib/dto/fleetPools';
import {
  PLATFORM_POOL_KIND_ORDER,
  type PlatformPoolAccountDTO,
  type PlatformPoolBlockDTO,
  type PlatformPoolRequestDTO,
  type PlatformPoolSpareDTO,
  type PlatformPoolTotalDTO,
  type PlatformPoolsDTO,
} from '@/lib/dto/platformFleetPools';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { fleetQuotaRequestRepository } from '@/lib/repositories/fleetQuotaRequestRepository';
import { spareReady } from '@/lib/services/fleetPoolGrowthService';
import { fleetPoolStatusService } from '@/lib/services/fleetPoolStatusService';
import { fleetShardHeadroomService } from '@/lib/services/fleetShardHeadroomService';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE POOLS READ (Story MOTIR-9367 · MOTIR-9562) — what the Pools section of
// /admin/monitoring renders: each fleet kind's switch, and for a kind on its AWS
// pool the shared accounts, the pool total, the Motir spares, every quota raise
// and the growth events.
//
// ⚠️ IT COMPOSES `fleetPoolStatusService`, the view behind `fleet-admin
// pool-status`, so the page and the terminal can never disagree. The use figure
// is the headroom pass's own peak (`readAccountHeadroom`), read ONCE for all
// four kinds.
//
// ⚠️ IT CALLS NO AWS API. The granted quota is the one the growth pass last
// stored, with its read time; loading the page spends no Service Quotas call.
//
// ⚠️ SYSTEM CONTEXT. The counts span every tenant: under a workspace context they
// would come back smaller and still look believable.
//
// ⚠️ ONE KIND'S FAILURE STAYS IN ITS BLOCK (`provider: 'unavailable'`), and a
// null is never defaulted to 0 anywhere below.

/** The growth events each block lists. */
const GROWTH_EVENTS_LIMIT = 50;

/** The terminal statuses — a request that has one is no longer open. */
const CLOSED_STATUSES: ReadonlySet<FleetQuotaRequestStatusDTO> = new Set([
  'approved',
  'denied',
  'not_approved',
  'case_closed',
  'invalid_request',
]);

function sharedAccount(account: FleetPoolAccountDTO): PlatformPoolAccountDTO {
  return {
    name: account.name,
    role: 'shared',
    state: account.state,
    grantedVcpu: account.grantedVcpu,
    grantedReadAt: account.grantedReadAt,
    usedVcpu: account.usedVcpu,
    percent: account.percent,
    toThreshold: account.toThreshold,
    overThreshold: account.grantedVcpu !== null && account.toThreshold === 0,
  };
}

/** The pool total. A partial sum is never the pool's capacity: `complete` says
 *  whether every shared account's quota and use are known. */
export function poolTotal(accounts: readonly PlatformPoolAccountDTO[]): PlatformPoolTotalDTO {
  let grantedVcpu = 0;
  let usedVcpu = 0;
  let complete = accounts.length > 0;
  for (const account of accounts) {
    if (account.grantedVcpu === null || account.usedVcpu === null) complete = false;
    grantedVcpu += account.grantedVcpu ?? 0;
    usedVcpu += account.usedVcpu ?? 0;
  }
  return {
    grantedVcpu,
    usedVcpu,
    percent: complete && grantedVcpu > 0 ? Math.round((usedVcpu * 100) / grantedVcpu) : null,
    complete,
  };
}

async function awsBlock(
  kind: FleetWorkloadKind,
  status: Extract<
    Awaited<ReturnType<typeof fleetPoolStatusService.getPoolStatus>>[number],
    { onPool: true }
  >,
): Promise<PlatformPoolBlockDTO> {
  const [rows, growthEvents] = await Promise.all([
    withSystemContext((tx) => fleetQuotaRequestRepository.listByKindInTx(kind, tx)),
    fleetPoolStatusService.listGrowthEvents(kind, GROWTH_EVENTS_LIMIT),
  ]);

  const requests = rows.map(
    (r): PlatformPoolRequestDTO => ({
      account: r.shard.name,
      desiredValue: r.desiredValue,
      status: r.status as FleetQuotaRequestStatusDTO,
      grantedValue: r.grantedValue,
      open: r.closedAt === null && !CLOSED_STATUSES.has(r.status as FleetQuotaRequestStatusDTO),
      createdAt: r.createdAt.toISOString(),
      lastReadAt: r.lastReadAt?.toISOString() ?? null,
    }),
  );
  // Open first, then newest first (the repository's order, kept by a stable sort).
  requests.sort((a, b) => Number(b.open) - Number(a.open));

  const spares = status.spares.map((spare): PlatformPoolSpareDTO => {
    // The rows are newest first, so the first one on the spare is its latest raise.
    const latest = rows.find((r) => r.shard.name === spare.name) ?? null;
    return {
      name: spare.name,
      state: spare.state,
      grantedVcpu: spare.vcpuQuota,
      grantedReadAt: spare.grantedReadAt,
      ready: spareReady(
        {
          state: spare.state as 'provisioning' | 'active' | 'disabled',
          vcpuQuota: spare.vcpuQuota,
          fleetKind: kind,
        },
        latest,
      ),
    };
  });

  const accounts = status.accounts.map(sharedAccount);
  return {
    fleetKind: kind,
    provider: 'aws',
    pool: poolTotal(accounts),
    accounts,
    spares,
    requests,
    growthEvents,
    growthInFlight: status.growthInFlight,
  };
}

export const platformFleetPoolsService = {
  /**
   * Every fleet kind's pool, for a platform admin. One `estate.read` audit entry
   * per call; one block per kind in {@link PLATFORM_POOL_KIND_ORDER}.
   */
  async listPools(principal: PlatformPrincipal, now: Date = new Date()): Promise<PlatformPoolsDTO> {
    await requirePlatformStaff('support');
    await platformAuditService.record(principal, { action: 'estate.read', targetKind: 'platform' });

    // ONE headroom read serves every kind.
    let usage: ReturnType<typeof fleetShardHeadroomService.readAccountHeadroom> | undefined;
    const readUsage = (at: Date) => (usage ??= fleetShardHeadroomService.readAccountHeadroom(at));

    const settled = await Promise.allSettled(
      PLATFORM_POOL_KIND_ORDER.map(async (kind): Promise<PlatformPoolBlockDTO> => {
        const [status] = await fleetPoolStatusService.getPoolStatus(kind, {
          now: () => now,
          readUsage,
        });
        if (!status || !status.onPool) return { fleetKind: kind, provider: 'fly' };
        return awsBlock(kind, status);
      }),
    );

    return {
      blocks: settled.map((result, i) => {
        const kind = PLATFORM_POOL_KIND_ORDER[i]!;
        if (result.status === 'fulfilled') return result.value;
        console.error(`[platformFleetPools] the ${kind} pool read failed`, {
          detail: result.reason instanceof Error ? result.reason.message.slice(0, 300) : 'unknown',
        });
        return { fleetKind: kind, provider: 'unavailable' };
      }),
    };
  },
};
