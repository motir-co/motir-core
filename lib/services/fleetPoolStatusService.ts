import type { FleetQuotaRequest, FleetShard } from '@/generated/prisma/client';
import { HOST_ACCOUNT_STATES, stateFromTimes } from '@/lib/ciFleet/hostAccountState';
import { HEADROOM_ALERT_FRACTION, fleetKindOnPool } from '@/lib/ciFleet/shardTargets';
import { FLEET_WORKLOAD_KINDS, type FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import { FleetPoolValueInvalidError } from '@/lib/ciFleet/errors';
import type {
  FleetGrowthEventViewDTO,
  FleetGrowthOutcomeDTO,
  FleetOrgAccountDTO,
  FleetPoolAccountDTO,
  FleetPoolKindStatusDTO,
  FleetPoolRequestDTO,
  FleetQuotaRequestStatusDTO,
} from '@/lib/dto/fleetPools';
import { DEFAULT_FLEET_QUOTA_CODE } from '@/lib/mappers/fleetPoolMappers';
import { fleetGrowthEventRepository } from '@/lib/repositories/fleetGrowthEventRepository';
import { fleetQuotaRequestRepository } from '@/lib/repositories/fleetQuotaRequestRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { fleetGrowthEventService } from '@/lib/services/fleetGrowthEventService';
import { fleetShardHeadroomService } from '@/lib/services/fleetShardHeadroomService';
import { withSystemContext } from '@/lib/workspaces/context';

// WHAT A POOL LOOKS LIKE NOW (Story MOTIR-9362 · MOTIR-9463) — the view behind
// `fleet-admin pool-status` and `growth-events`. It reads only what is stored
// (the growth pass keeps the granted values live) and the headroom reading's
// vCPU in use; it never calls AWS, and nothing it returns is a credential.

/** A closed request stays in `pool-status` for this long. */
const RECENT_REQUEST_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;
/** The trigger in tenths, as the growth decision reads it. */
const TRIGGER_TENTHS = Math.round(HEADROOM_ALERT_FRACTION * 10);

export interface FleetPoolStatusDeps {
  onPool?: (kind: FleetWorkloadKind) => Promise<boolean>;
  now?: () => Date;
  readUsage?: (now: Date) => Promise<Array<{ shardId: string; usedVcpu: number }>>;
}

function validKind(kind: string): FleetWorkloadKind {
  if (!(FLEET_WORKLOAD_KINDS as string[]).includes(kind)) {
    throw new FleetPoolValueInvalidError('fleetKind', kind);
  }
  return kind as FleetWorkloadKind;
}

/** When the account's granted vCPU was last read, from its limits source. */
function grantedReadAt(shard: FleetShard): string | null {
  const source = shard.limitsSource as Record<string, unknown> | null;
  return source && typeof source['vcpuQuota'] === 'string' && shard.limitsVerifiedAt
    ? shard.limitsVerifiedAt.toISOString()
    : null;
}

function accountView(shard: FleetShard, usedVcpu: number | undefined): FleetPoolAccountDTO {
  const granted = shard.vcpuQuota;
  const used = usedVcpu === undefined ? null : Math.ceil(usedVcpu);
  const known = granted !== null && used !== null;
  return {
    name: shard.name,
    state: shard.state,
    grantedVcpu: granted,
    grantedReadAt: grantedReadAt(shard),
    usedVcpu: used,
    percent: known && granted > 0 ? Math.round((used * 100) / granted) : null,
    toThreshold: known ? Math.max(0, Math.ceil((granted * TRIGGER_TENTHS) / 10) - used) : null,
  };
}

async function kindStatus(
  kind: FleetWorkloadKind,
  usage: ReadonlyMap<string, number>,
  now: Date,
): Promise<FleetPoolKindStatusDTO> {
  const { shared, spares, requests } = await withSystemContext(async (tx) => ({
    shared: await fleetShardRepository.listByRole('primary', { fleetKind: kind }, tx),
    spares: await fleetShardRepository.listSparesForKind(kind, tx),
    requests: await fleetQuotaRequestRepository.listRecentByKindInTx(
      kind,
      new Date(now.getTime() - RECENT_REQUEST_DAYS * DAY_MS),
      tx,
    ),
  }));
  const spareRaising = requests.some(
    (r) => r.closedAt === null && spares.some((spare) => spare.id === r.shardId),
  );
  return {
    fleetKind: kind,
    onPool: true,
    accounts: shared
      .filter((shard) => shard.state !== 'disabled')
      .map((shard) => accountView(shard, usage.get(shard.id))),
    spares: spares.map((s) => ({
      name: s.name,
      state: s.state,
      vcpuQuota: s.vcpuQuota,
      grantedReadAt: grantedReadAt(s),
    })),
    requests: requests.map(
      (r): FleetPoolRequestDTO => ({
        account: r.shard.name,
        quotaCode: r.quotaCode,
        desiredValue: r.desiredValue,
        awsRequestId: r.awsRequestId,
        status: r.status as FleetQuotaRequestStatusDTO,
        grantedValue: r.grantedValue,
        createdAt: r.createdAt.toISOString(),
        lastReadAt: r.lastReadAt?.toISOString() ?? null,
      }),
    ),
    // The growth decision's own rule: an unfinished growth, or a spare still
    // waiting on its raise.
    growthInFlight: spareRaising || (await fleetGrowthEventService.hasUnfinishedGrowth(kind, now)),
  };
}

/** One own AWS account's rows (the merged pair is two), printed alike: the most
 *  advanced state either row records, the latest vCPU raise's ask and status,
 *  and the largest granted value read for the account. */
function orgAccountViews(
  rows: readonly FleetShard[],
  requests: readonly FleetQuotaRequest[],
): FleetOrgAccountDTO[] {
  const vcpu = requests.filter((r) => r.quotaCode === DEFAULT_FLEET_QUOTA_CODE);
  const latest = vcpu[0] ?? null;
  const granted = vcpu
    .map((r) => r.grantedValue)
    .filter((value): value is number => value !== null);
  const state = rows
    .map((row) => stateFromTimes(row))
    .reduce((a, b) => (HOST_ACCOUNT_STATES.indexOf(b) > HOST_ACCOUNT_STATES.indexOf(a) ? b : a));
  const earliest = (column: 'quotaRequestedAt' | 'grantedAt' | 'liveAt') => {
    const times = rows.map((row) => row[column]?.getTime()).filter((t) => t !== undefined);
    return times.length > 0 ? new Date(Math.min(...times)).toISOString() : null;
  };
  return rows.map((row) => ({
    organizationId: row.ownerOrganizationId ?? '',
    fleetKind: row.fleetKind as FleetWorkloadKind,
    name: row.name,
    awsAccountId: row.awsAccountId,
    state,
    requestedVcpu: latest?.desiredValue ?? null,
    grantedVcpu: granted.length > 0 ? Math.max(...granted) : null,
    quotaRequestStatus: (latest?.status as FleetQuotaRequestStatusDTO | undefined) ?? null,
    quotaRequestedAt: earliest('quotaRequestedAt'),
    grantedAt: earliest('grantedAt'),
    liveAt: earliest('liveAt'),
  }));
}

export const fleetPoolStatusService = {
  /**
   * Every Host organisation's own account rows (MOTIR-9588), optionally of one
   * organisation or one kind, from stored records only — never AWS.
   *
   * @throws FleetPoolValueInvalidError on an unknown fleet kind.
   */
  async listOrgAccounts(
    filter: { organizationId?: string; fleetKind?: string } = {},
  ): Promise<FleetOrgAccountDTO[]> {
    const fleetKind = filter.fleetKind === undefined ? undefined : validKind(filter.fleetKind);
    return withSystemContext(async (tx) => {
      const listed = await fleetShardRepository.listOrgOwned(
        {
          ...(filter.organizationId !== undefined ? { organizationId: filter.organizationId } : {}),
          ...(fleetKind !== undefined ? { fleetKind } : {}),
        },
        tx,
      );
      const out: FleetOrgAccountDTO[] = [];
      const seen = new Set<string>();
      for (const row of listed) {
        const account = row.awsAccountId ?? `row:${row.id}`;
        if (seen.has(account)) continue;
        seen.add(account);
        // Both rows of the AWS account decide its figures, even when a filter
        // lists only one of them.
        const rows = row.awsAccountId
          ? (await fleetShardRepository.listByAwsAccountInTx(row.awsAccountId, tx)).filter(
              (r) => r.role === 'org_owned',
            )
          : [row];
        const requests = await fleetQuotaRequestRepository.listByShardIdsInTx(
          rows.map((r) => r.id),
          tx,
        );
        const listedIds = new Set(listed.map((r) => r.id));
        out.push(...orgAccountViews(rows, requests).filter((_, i) => listedIds.has(rows[i]!.id)));
      }
      return out;
    });
  },

  /** One kind's pool, or every kind's; a kind on Fly says so and no more. */
  async getPoolStatus(
    kind?: string,
    deps: FleetPoolStatusDeps = {},
  ): Promise<FleetPoolKindStatusDTO[]> {
    const kinds = kind ? [validKind(kind)] : [...FLEET_WORKLOAD_KINDS];
    const onPool = deps.onPool ?? fleetKindOnPool;
    const now = (deps.now ?? (() => new Date()))();
    const readUsage =
      deps.readUsage ?? ((at: Date) => fleetShardHeadroomService.readAccountHeadroom(at));
    const usage = new Map((await readUsage(now)).map((r) => [r.shardId, r.usedVcpu]));

    const out: FleetPoolKindStatusDTO[] = [];
    for (const fleetKind of kinds) {
      out.push(
        (await onPool(fleetKind))
          ? await kindStatus(fleetKind, usage, now)
          : { fleetKind, onPool: false },
      );
    }
    return out;
  },

  /** A kind's growth events, newest first, their accounts by name. */
  async listGrowthEvents(kind: string, limit = 20): Promise<FleetGrowthEventViewDTO[]> {
    const fleetKind = validKind(kind);
    return withSystemContext(async (tx) => {
      const events = await fleetGrowthEventRepository.listByKind(fleetKind, limit, tx);
      const shards = await fleetShardRepository.listByRole(null, { fleetKind }, tx);
      const nameOf = (id: string | null) =>
        id === null ? null : (shards.find((s) => s.id === id)?.name ?? id);
      return events.map((e) => ({
        createdAt: e.createdAt.toISOString(),
        triggeringAccount: nameOf(e.triggeringShardId),
        vcpuInUse: e.vcpuInUse,
        grantedQuota: e.grantedQuota,
        outcome: e.outcome as FleetGrowthOutcomeDTO,
        spareAccount: nameOf(e.spareShardId),
        newAccount: nameOf(e.newShardId),
        reason: e.reason,
      }));
    });
  },
};
