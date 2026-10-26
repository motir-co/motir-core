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

// ── `fleet-admin` pool views (MOTIR-9463) ────────────────────────────────────

/** One account's outcome of `request-quota`: the stored request, or the typed
 *  failure's text. */
export type FleetQuotaRaiseOutcomeDTO =
  | { name: string; ok: true; request: FleetQuotaRequestDTO; reused: boolean }
  | { name: string; ok: false; failure: string };

/** One shared account in `pool-status`: its STORED granted quota (the growth
 *  pass keeps it live) and its vCPU in use, when the kind has a reader. */
export interface FleetPoolAccountDTO {
  name: string;
  state: string;
  grantedVcpu: number | null;
  /** When the granted value was last read from the provider. */
  grantedReadAt: string | null;
  usedVcpu: number | null;
  /** `usedVcpu / grantedVcpu` as a whole percent. */
  percent: number | null;
  /** vCPU still to use before the account reaches 70%; 0 at or over it. */
  toThreshold: number | null;
}

export interface FleetPoolSpareDTO {
  name: string;
  state: string;
  vcpuQuota: number | null;
  /** When the granted value was last read from the provider (MOTIR-9562). */
  grantedReadAt: string | null;
}

export interface FleetPoolRequestDTO {
  account: string;
  quotaCode: string;
  desiredValue: number;
  awsRequestId: string;
  status: FleetQuotaRequestStatusDTO;
  grantedValue: number | null;
  createdAt: string;
  lastReadAt: string | null;
}

export type FleetPoolKindStatusDTO =
  | { fleetKind: FleetWorkloadKind; onPool: false }
  | {
      fleetKind: FleetWorkloadKind;
      onPool: true;
      accounts: FleetPoolAccountDTO[];
      spares: FleetPoolSpareDTO[];
      /** Open requests, and those closed in the last `RECENT_REQUEST_DAYS`. */
      requests: FleetPoolRequestDTO[];
      growthInFlight: boolean;
    };

/** One growth event in `growth-events`, its accounts by name. */
export interface FleetGrowthEventViewDTO {
  createdAt: string;
  triggeringAccount: string | null;
  vcpuInUse: number;
  grantedQuota: number;
  outcome: FleetGrowthOutcomeDTO;
  spareAccount: string | null;
  newAccount: string | null;
  reason: string | null;
}
