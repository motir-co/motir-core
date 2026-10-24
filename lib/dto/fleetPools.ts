import type { FleetWorkloadKind } from '@motir/orchestrator';

// The records a fleet pool's growth writes (Story MOTIR-9362 · MOTIR-9457): the
// quota raises filed for an account, and what each growth decision did.
//
// ⚠️ Neither carries a credential or secret field: a request names AWS's own
// request id, and a refusal is AWS's text only.

/** The seven values Service Quotas' `RequestStatus` returns. */
export type FleetQuotaRequestStatusDTO =
  | 'pending'
  | 'case_opened'
  | 'approved'
  | 'denied'
  | 'not_approved'
  | 'case_closed'
  | 'invalid_request';

export interface FleetQuotaRequestDTO {
  id: string;
  shardId: string;
  fleetKind: FleetWorkloadKind;
  quotaCode: string;
  desiredValue: number;
  awsRequestId: string;
  status: FleetQuotaRequestStatusDTO;
  grantedValue: number | null;
  createdAt: string;
  lastReadAt: string | null;
  /** Set by the read that answered a terminal status; null while open. */
  closedAt: string | null;
}

/** What one growth decision did. */
export type FleetGrowthOutcomeDTO =
  | 'spare_promoted'
  | 'account_created'
  | 'waiting_for_quota'
  | 'refused';

export interface FleetGrowthEventDTO {
  id: string;
  fleetKind: FleetWorkloadKind;
  triggeringShardId: string | null;
  /** The triggering account's vCPU in use, and its live granted quota. */
  vcpuInUse: number;
  grantedQuota: number;
  outcome: FleetGrowthOutcomeDTO;
  /** AWS's refusal text, when there is one. */
  reason: string | null;
  spareShardId: string | null;
  newShardId: string | null;
  quotaRequestId: string | null;
  createdAt: string;
}
