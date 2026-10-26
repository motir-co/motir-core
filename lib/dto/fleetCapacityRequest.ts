import type { FleetWorkloadKind } from '@motir/orchestrator';
import type { FleetQuotaRequestStatusDTO } from '@/lib/dto/fleetPools';

// A Host organisation's ask for more capacity on one of its own accounts (Story
// MOTIR-9365 · MOTIR-9583). Ids and numbers only: no credential, secret or
// member-account email.

export type FleetCapacityRequestStatusDTO = 'open' | 'filed' | 'closed';

/** The linked quota request as it stands NOW — read at read time, so the two
 *  records can never disagree about what AWS answered. */
export interface FleetCapacityRequestOutcomeDTO {
  quotaRequestId: string;
  status: FleetQuotaRequestStatusDTO;
  grantedValue: number | null;
  lastReadAt: string | null;
}

export interface FleetCapacityRequestDTO {
  id: string;
  organizationId: string;
  shardId: string;
  awsAccountId: string;
  /** The kind the organisation named. */
  fleetKind: FleetWorkloadKind;
  quotaCode: string;
  desiredVcpu: number;
  reasonMd: string;
  status: FleetCapacityRequestStatusDTO;
  requestedByUserId: string;
  closedNote: string | null;
  createdAt: string;
  filedAt: string | null;
  closedAt: string | null;
  /** Null while no quota request is linked. */
  outcome: FleetCapacityRequestOutcomeDTO | null;
}

/**
 * The TENANT's view of one capacity request (Story MOTIR-9368 · MOTIR-9662) —
 * what the org's owner and admins read on Billing & plans' Fleet use section and
 * what the Request more capacity POST answers. No AWS account id, shard id,
 * organisation id, quota code, quota request id or user id: the org names its
 * account by fleet kind (`toOrgFleetCapacityRequestDTO` picks field by field, so
 * a field added above never reaches a tenant by default).
 */
export interface OrgFleetCapacityRequestDTO {
  id: string;
  fleetKind: FleetWorkloadKind;
  desiredVcpu: number;
  reasonMd: string;
  status: FleetCapacityRequestStatusDTO;
  closedNote: string | null;
  createdAt: string;
  filedAt: string | null;
  closedAt: string | null;
  /** What AWS answered on the linked raise; null while none is linked. */
  outcome: {
    status: FleetQuotaRequestStatusDTO;
    grantedValue: number | null;
    lastReadAt: string | null;
  } | null;
}
