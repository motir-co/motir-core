import type { FleetCapacityRequest, FleetQuotaRequest } from '@/generated/prisma/client';
import type { FleetWorkloadKind } from '@motir/orchestrator';
import type { FleetCapacityRequestDTO } from '@/lib/dto/fleetCapacityRequest';

/** A capacity request row, with its linked quota request when it has one. */
export type FleetCapacityRequestRow = FleetCapacityRequest & {
  quotaRequest: FleetQuotaRequest | null;
};

export function toFleetCapacityRequestDTO(row: FleetCapacityRequestRow): FleetCapacityRequestDTO {
  const quota = row.quotaRequest;
  return {
    id: row.id,
    organizationId: row.organizationId,
    shardId: row.shardId,
    awsAccountId: row.awsAccountId,
    fleetKind: row.fleetKind as FleetWorkloadKind,
    quotaCode: row.quotaCode,
    desiredVcpu: row.desiredVcpu,
    reasonMd: row.reasonMd,
    status: row.status,
    requestedByUserId: row.requestedByUserId,
    closedNote: row.closedNote,
    createdAt: row.createdAt.toISOString(),
    filedAt: row.filedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    outcome: quota
      ? {
          quotaRequestId: quota.id,
          status: quota.status,
          grantedValue: quota.grantedValue,
          lastReadAt: quota.lastReadAt?.toISOString() ?? null,
        }
      : null,
  };
}
