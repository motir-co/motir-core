import type { FleetGrowthEvent, FleetQuotaRequest } from '@/generated/prisma/client';
import type { FleetWorkloadKind } from '@motir/orchestrator';
import type {
  FleetGrowthEventDTO,
  FleetGrowthOutcomeDTO,
  FleetQuotaRequestDTO,
  FleetQuotaRequestStatusDTO,
} from '@/lib/dto/fleetPools';

/** The Service Quotas code a fleet raise asks for by default: Running On-Demand
 *  Standard (A, C, D, H, I, M, R, T, Z) instances, in vCPUs. */
export const DEFAULT_FLEET_QUOTA_CODE = 'L-1216C47A';

export const FLEET_QUOTA_REQUEST_STATUSES: readonly FleetQuotaRequestStatusDTO[] = [
  'pending',
  'case_opened',
  'approved',
  'denied',
  'not_approved',
  'case_closed',
  'invalid_request',
];

/** The statuses that close a request: AWS will not move it again. The refresh
 *  (MOTIR-9459) stops reading a request once it answers one of these. */
export const FLEET_QUOTA_REQUEST_TERMINAL_STATUSES: readonly FleetQuotaRequestStatusDTO[] = [
  'approved',
  'denied',
  'not_approved',
  'case_closed',
  'invalid_request',
];

export const FLEET_GROWTH_OUTCOMES: readonly FleetGrowthOutcomeDTO[] = [
  'spare_promoted',
  'account_created',
  'waiting_for_quota',
  'refused',
];

export function isTerminalQuotaRequestStatus(status: FleetQuotaRequestStatusDTO): boolean {
  return FLEET_QUOTA_REQUEST_TERMINAL_STATUSES.includes(status);
}

export function toFleetQuotaRequestDTO(row: FleetQuotaRequest): FleetQuotaRequestDTO {
  return {
    id: row.id,
    shardId: row.shardId,
    // The CHECK constraint holds the column to the four kinds.
    fleetKind: row.fleetKind as FleetWorkloadKind,
    quotaCode: row.quotaCode,
    desiredValue: row.desiredValue,
    awsRequestId: row.awsRequestId,
    status: row.status,
    grantedValue: row.grantedValue,
    createdAt: row.createdAt.toISOString(),
    lastReadAt: row.lastReadAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

export function toFleetGrowthEventDTO(row: FleetGrowthEvent): FleetGrowthEventDTO {
  return {
    id: row.id,
    fleetKind: row.fleetKind as FleetWorkloadKind,
    triggeringShardId: row.triggeringShardId,
    vcpuInUse: row.vcpuInUse,
    grantedQuota: row.grantedQuota,
    outcome: row.outcome,
    reason: row.reason,
    spareShardId: row.spareShardId,
    newShardId: row.newShardId,
    quotaRequestId: row.quotaRequestId,
    createdAt: row.createdAt.toISOString(),
  };
}
