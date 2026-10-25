import { FleetPoolValueInvalidError } from '@/lib/ciFleet/errors';
import { GROWTH_CLAIM_STALE_MS } from '@/lib/ciFleet/poolGrowthPolicy';
import { FLEET_WORKLOAD_KINDS } from '@/lib/ciFleet/workloads';
import { fleetAutomationPrincipal } from '@/lib/fleetShards/fleetAutomationPrincipal';
import type { FleetGrowthEventDTO, FleetGrowthOutcomeDTO } from '@/lib/dto/fleetPools';
import { FLEET_GROWTH_OUTCOMES, toFleetGrowthEventDTO } from '@/lib/mappers/fleetPoolMappers';
import { fleetGrowthEventRepository } from '@/lib/repositories/fleetGrowthEventRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { withSystemContext } from '@/lib/workspaces/context';

// The POOL GROWTH record (Story MOTIR-9362 · MOTIR-9457): one row per growth
// decision — which account crossed 70%, its use and live granted quota, and
// what the pass did. The growth card (MOTIR-9461) writes them; the one-in-flight
// rule and `fleet-admin growth-events` read them. Holds no credential: a
// refusal reason is AWS's text only.

const DEFAULT_LIST_LIMIT = 50;
/** Enough newest events to see the backoff reach its cap (five refusals). */
const BACKOFF_READ_LIMIT = 8;

export interface RecordRefusedGrowthInput {
  fleetKind: string;
  triggeringShardId: string;
  vcpuInUse: number;
  grantedQuota: number;
  /** AWS's reason, as text. */
  reason: string;
  /** A spare promoted before the create was refused — it stays promoted. */
  spareShardId: string | null;
  /** When the pass saw the refusal — what the backoff counts from. */
  at: Date;
}

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

  /**
   * Record a REFUSED growth (MOTIR-9462): its one event and its one
   * `fleet.pool.grow` audit row, the audit appended while the event's
   * transaction is still open so a refused append rolls the event back. AWS's
   * reason is stored as text; nothing else from the refusal is.
   */
  async recordRefused(input: RecordRefusedGrowthInput): Promise<FleetGrowthEventDTO> {
    const fleetKind = validKind(input.fleetKind);
    const principal = await fleetAutomationPrincipal();
    const row = await withSystemContext(async (tx) => {
      const event = await fleetGrowthEventRepository.create(
        {
          fleetKind,
          triggeringShardId: input.triggeringShardId,
          vcpuInUse: input.vcpuInUse,
          grantedQuota: input.grantedQuota,
          outcome: 'refused',
          reason: input.reason,
          spareShardId: input.spareShardId,
          createdAt: input.at,
        },
        tx,
      );
      const trigger = await fleetShardRepository.findById(input.triggeringShardId, tx);
      await platformAuditService.record(principal, {
        action: 'fleet.pool.grow',
        targetKind: 'platform',
        targetId: input.triggeringShardId,
        targetLabel: trigger?.name ?? null,
        reason: `pool growth refused: ${fleetKind}: ${input.reason}`,
        metadata: {
          fleetKind,
          growthEventId: event.id,
          outcome: 'refused',
          triggeringShardId: input.triggeringShardId,
          vcpuInUse: input.vcpuInUse,
          grantedQuota: input.grantedQuota,
          spareShardId: input.spareShardId,
          refusal: input.reason,
        },
      });
      return event;
    });
    return toFleetGrowthEventDTO(row);
  },

  /** How many of the kind's newest growths in a row were refused, and when the
   *  newest of them was — what the refusal backoff is derived from. */
  async consecutiveRefusals(fleetKind: string): Promise<{ count: number; latestAt: Date | null }> {
    const rows = await withSystemContext((tx) =>
      fleetGrowthEventRepository.listByKind(validKind(fleetKind), BACKOFF_READ_LIMIT, tx),
    );
    const firstOther = rows.findIndex((row) => row.outcome !== 'refused');
    const count = firstOther === -1 ? rows.length : firstOther;
    return { count, latestAt: count > 0 ? rows[0]!.createdAt : null };
  },
};
