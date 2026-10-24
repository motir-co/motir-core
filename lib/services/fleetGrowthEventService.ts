import { FleetPoolValueInvalidError } from '@/lib/ciFleet/errors';
import { GROWTH_CLAIM_STALE_MS } from '@/lib/ciFleet/poolGrowthPolicy';
import { FLEET_WORKLOAD_KINDS } from '@/lib/ciFleet/workloads';
import type { FleetGrowthEventDTO, FleetGrowthOutcomeDTO } from '@/lib/dto/fleetPools';
import { FLEET_GROWTH_OUTCOMES, toFleetGrowthEventDTO } from '@/lib/mappers/fleetPoolMappers';
import { fleetGrowthEventRepository } from '@/lib/repositories/fleetGrowthEventRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// The POOL GROWTH record (Story MOTIR-9362 · MOTIR-9457): one row per growth
// decision — which account crossed 70%, its use and live granted quota, and
// what the pass did. The growth card (MOTIR-9461) writes them; the one-in-flight
// rule and `fleet-admin growth-events` read them. Holds no credential: a
// refusal reason is AWS's text only.

const DEFAULT_LIST_LIMIT = 50;

export interface RecordFleetGrowthEventInput {
  fleetKind: string;
  triggeringShardId: string | null;
  vcpuInUse: number;
  grantedQuota: number;
  outcome: string;
  reason?: string | null;
  spareShardId?: string | null;
  newShardId?: string | null;
  /** The quota raise this growth waits on — what keeps it unfinished. */
  quotaRequestId?: string | null;
}

function validKind(kind: string): string {
  if (!(FLEET_WORKLOAD_KINDS as string[]).includes(kind)) {
    throw new FleetPoolValueInvalidError('fleetKind', kind);
  }
  return kind;
}

export const fleetGrowthEventService = {
  async recordEvent(input: RecordFleetGrowthEventInput): Promise<FleetGrowthEventDTO> {
    const fleetKind = validKind(input.fleetKind);
    if (!FLEET_GROWTH_OUTCOMES.includes(input.outcome as FleetGrowthOutcomeDTO)) {
      throw new FleetPoolValueInvalidError('outcome', input.outcome);
    }
    for (const figure of [input.vcpuInUse, input.grantedQuota]) {
      if (!Number.isInteger(figure) || figure < 0) {
        throw new FleetPoolValueInvalidError('figures', figure);
      }
    }
    const row = await withSystemContext((tx) =>
      fleetGrowthEventRepository.create(
        {
          fleetKind,
          triggeringShardId: input.triggeringShardId,
          vcpuInUse: input.vcpuInUse,
          grantedQuota: input.grantedQuota,
          outcome: input.outcome as FleetGrowthOutcomeDTO,
          reason: input.reason ?? null,
          spareShardId: input.spareShardId ?? null,
          newShardId: input.newShardId ?? null,
          quotaRequestId: input.quotaRequestId ?? null,
        },
        tx,
      ),
    );
    return toFleetGrowthEventDTO(row);
  },

  /** One kind's growths, newest first. */
  async listByKind(fleetKind: string, limit = DEFAULT_LIST_LIMIT): Promise<FleetGrowthEventDTO[]> {
    const rows = await withSystemContext((tx) =>
      fleetGrowthEventRepository.listByKind(validKind(fleetKind), limit, tx),
    );
    return rows.map(toFleetGrowthEventDTO);
  },

  /** The kind's newest unfinished growth — not `refused` and its quota raise
   *  still open, or a claim younger than `GROWTH_CLAIM_STALE_MS` (MOTIR-9461) —
   *  or null. The growth pass holds one growth in flight per kind on it. */
  async findUnfinishedGrowth(
    fleetKind: string,
    now: Date = new Date(),
  ): Promise<FleetGrowthEventDTO | null> {
    const claimFreshAfter = new Date(now.getTime() - GROWTH_CLAIM_STALE_MS);
    const row = await withSystemContext((tx) =>
      fleetGrowthEventRepository.findLatestUnfinishedByKind(
        validKind(fleetKind),
        tx,
        claimFreshAfter,
      ),
    );
    return row ? toFleetGrowthEventDTO(row) : null;
  },

  /** Does this kind have a growth in flight? */
  async hasUnfinishedGrowth(fleetKind: string, now: Date = new Date()): Promise<boolean> {
    return (await fleetGrowthEventService.findUnfinishedGrowth(fleetKind, now)) !== null;
  },
};
