import type { FleetWorkloadKind } from '@motir/orchestrator';
import type { FleetGrowthEventViewDTO, FleetQuotaRequestStatusDTO } from '@/lib/dto/fleetPools';

// MONITORING · POOLS (Story MOTIR-9367 · MOTIR-9562) — what the platform admin's
// Pools section reads: one block per fleet kind, in the page's fixed order.
//
// ⚠️ A FIGURE AWS HAS NOT ANSWERED FOR IS NULL, NEVER ZERO. An account whose
// granted quota was never read, or whose read failed, carries `grantedVcpu`,
// `percent` and `toThreshold` null; a pool with any such account is
// `complete: false` and its `percent` is null, so a partial sum never reads as
// the pool's capacity.
//
// ⚠️ NO CREDENTIAL, SECRET, AWS ACCOUNT ID OR MEMBER EMAIL has a field here: an
// account is named by its shard name only.

/** The blocks' order on the page: CI runner, agent runner, indexer, agent hoster. */
export const PLATFORM_POOL_KIND_ORDER: readonly FleetWorkloadKind[] = [
  'ci_runner',
  'hosted_agent',
  'code_graph_index',
  'agent_instance',
];

/** One shared account of a pool. */
export interface PlatformPoolAccountDTO {
  name: string;
  role: 'shared';
  state: string;
  /** The stored granted vCPU quota; null when never read or the read failed. */
  grantedVcpu: number | null;
  /** The last successful read of the granted quota, or null. */
  grantedReadAt: string | null;
  /** vCPU in use, from the headroom pass's own peak; null when the kind has no reader. */
  usedVcpu: number | null;
  /** `usedVcpu / grantedVcpu` as a whole percent; null when either is unknown. */
  percent: number | null;
  /** vCPU still to use before 70%; 0 at or past it; null when unknown. */
  toThreshold: number | null;
  /** At or past 70% of a KNOWN granted quota. */
  overThreshold: boolean;
}

/** The pool's total over its shared accounts (the spare and disabled accounts excluded). */
export interface PlatformPoolTotalDTO {
  /** The sum of the KNOWN granted quotas. Read it only when `complete`. */
  grantedVcpu: number;
  /** The sum of the KNOWN use. */
  usedVcpu: number;
  /** Whole percent; null unless `complete`. */
  percent: number | null;
  /** Every shared account has a known granted quota and use, and there is at least one. */
  complete: boolean;
}

/** One Motir spare of a kind. */
export interface PlatformPoolSpareDTO {
  name: string;
  state: string;
  grantedVcpu: number | null;
  grantedReadAt: string | null;
  /** Ready to join the shared pool — the growth decision's own rule (quota granted). */
  ready: boolean;
}

/** One quota raise asked of AWS for an account of the kind. */
export interface PlatformPoolRequestDTO {
  account: string;
  desiredValue: number;
  status: FleetQuotaRequestStatusDTO;
  grantedValue: number | null;
  /** Not yet answered with a terminal status. */
  open: boolean;
  createdAt: string;
  lastReadAt: string | null;
}

export type PlatformPoolBlockDTO =
  | { fleetKind: FleetWorkloadKind; provider: 'fly' }
  | { fleetKind: FleetWorkloadKind; provider: 'unavailable' }
  | {
      fleetKind: FleetWorkloadKind;
      provider: 'aws';
      pool: PlatformPoolTotalDTO;
      accounts: PlatformPoolAccountDTO[];
      spares: PlatformPoolSpareDTO[];
      /** Every request of the kind: open first, then newest first. */
      requests: PlatformPoolRequestDTO[];
      /** Newest first. */
      growthEvents: FleetGrowthEventViewDTO[];
      growthInFlight: boolean;
    };

export interface PlatformPoolsDTO {
  blocks: PlatformPoolBlockDTO[];
}
