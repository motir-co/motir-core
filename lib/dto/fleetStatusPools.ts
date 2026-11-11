import type { FleetWorkloadKind } from '@motir/orchestrator';

// THE FLEET STATUS PAGE'S POOLS SECTION (MOTIR-10887; design MOTIR-10885) — how
// big each fleet pool is and how many machines run in it now. Two blocks, each
// read and settled on its own so one unanswered source never blanks the other:
//
//   - the INSTALL FLEET in Motir's own AWS account: its three pools against the
//     account's one EC2 vCPU quota (no pool has a size of its own);
//   - the ADD-SHARD accounts, one pool per fleet kind, sized by the sum of its
//     shared accounts' admission ceilings.
//
// ⚠️ A FIGURE NOBODY ANSWERED FOR IS NULL, NEVER ZERO. An unread quota is
// `notRead`, and every figure computed from it (a percent, a share, a pool size)
// is null; a pool with an account whose size is unknown has no size at all,
// never a partial sum.
//
// ⚠️ NO CREDENTIAL, SECRET OR AWS ACCOUNT ID has a field here: Motir's own
// account is named in words, an add-shard account by its shard name.

/** vCPU of one fleet machine on an add-shard account (`FLEET_CONTAINER_SIZE`). */
export const SHARD_MACHINE_VCPU = 2;

// ── The install fleet ─────────────────────────────────────────────────────────

/** The account's EC2 vCPU quota, or when it was last read when AWS did not answer. */
export type InstallQuotaDTO =
  | { status: 'ok'; vcpu: number; readAt: string }
  | { status: 'notRead'; lastReadAt: string | null };

/** One install-fleet pool. */
export type InstallPoolDTO =
  | { fleetKind: FleetWorkloadKind; enabled: false }
  | {
      fleetKind: FleetWorkloadKind;
      enabled: true;
      /** Machines running now — for the agent hoster, the awake ones. */
      running: number;
      /** Agent hoster only: hibernated instances, not counted. Null for the other kinds. */
      hibernated: number | null;
      /** vCPU of one machine, from its instance type; null when the type's size is unknown. */
      machineVcpu: number | null;
      /** `running × machineVcpu`; null when the machine's size is unknown. */
      vcpu: number | null;
      /** Whole percent of the quota; null when the quota is not read or vCPU unknown. */
      sharePercent: number | null;
    };

export type InstallFleetBlockDTO =
  | { status: 'unavailable' }
  | {
      status: 'ok';
      quota: InstallQuotaDTO;
      /** vCPU in use by the three pools; null when any running pool's size is unknown. */
      usedVcpu: number | null;
      /** Whole percent of the quota in use; null unless both are known. */
      percent: number | null;
      /** At or past 70% of a KNOWN quota. */
      nearQuota: boolean;
      /** vCPU left under the quota for all three pools; null unless both are known. */
      leftVcpu: number | null;
      /** In page order: agent runner, indexer, agent hoster. */
      pools: InstallPoolDTO[];
    };

// ── The add-shard accounts ────────────────────────────────────────────────────

/** Where an account's size comes from. */
export type ShardSizeSourceDTO =
  /** `shardAdmissionCeiling` over the granted vCPU quota. */
  | 'granted'
  /** `admissionCeilingOverride`, set by a platform admin. */
  | 'override';

/** One account of an add-shard pool — a shared account or the Motir spare. */
export interface ShardAccountDTO {
  name: string;
  role: 'shared' | 'spare';
  state: string;
  /** The account's admission ceiling in machines; null when its quota is not read. */
  sizeMachines: number | null;
  sizeSource: ShardSizeSourceDTO | null;
  /** The granted vCPU quota Monitoring → Pools shows; null when not read. */
  grantedVcpu: number | null;
  /** The last successful quota read, or null. */
  grantedReadAt: string | null;
  /** Machines admission counts on the account now. */
  running: number;
  /** Paused admission, when the pause has not passed yet. */
  pausedUntil: string | null;
  pausedReason: 'capacity_refused' | 'provider_unavailable' | null;
}

export type ShardPoolDTO =
  | { fleetKind: FleetWorkloadKind; provider: 'fly' }
  | { fleetKind: FleetWorkloadKind; provider: 'unavailable' }
  | {
      fleetKind: FleetWorkloadKind;
      provider: 'aws';
      /** Shared accounts first (in Monitoring's order), then the spares. */
      accounts: ShardAccountDTO[];
      /** The shared accounts counted in the size. */
      sharedCount: number;
      /** The spares' names, shown and never counted. */
      spareNames: string[];
      /** The pool's size in machines; null with no shared account, or one whose size is unknown. */
      sizeMachines: number | null;
      /** Shared accounts whose quota is not read. */
      notReadCount: number;
      /** Machines running on the shared accounts. */
      running: number;
      /** Whole percent of the size in use; null when the size is null or 0. */
      percent: number | null;
      /** `near` from 70%, `atSize` at 100%: admission defers new jobs. */
      flag: 'near' | 'atSize' | null;
    };

export type ShardBlockDTO =
  | { status: 'unavailable' }
  | {
      status: 'ok';
      /** One per fleet kind, in Monitoring's order. */
      pools: ShardPoolDTO[];
      /** Pools whose flag is set. */
      nearCount: number;
    };
