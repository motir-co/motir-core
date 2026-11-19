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

// ── CI Spot use (MOTIR-11729; design MOTIR-11726) ─────────────────────────────
//
// The CI runners BOOTED in the last 7 days, by the capacity each boot recorded
// and by how many EC2 reclaimed, beside the CI Spot setting's on/off. Three
// sources, each read on its own: the counts, the setting, and the pool around
// them. UNKNOWN, NONE AND ZERO ARE THREE DIFFERENT THINGS here:
//
//   - `{ status: 'unavailable' }` — the counts were not read: no figure at all;
//   - `launched: 0` — read, and nothing launched in the window;
//   - `interrupted: 0` with launches — a read zero;
//   - an account's `ciSpot: null` — read, and that account launched nothing.

/** The window the counts cover, in days. */
export const CI_SPOT_WINDOW_DAYS = 7;

/** One population's launches in the window. `notRecorded` is never on-demand. */
export interface CiSpotCountsDTO {
  /** Every CI runner booted in the window: `spot + onDemand + notRecorded`. */
  launched: number;
  spot: number;
  onDemand: number;
  /** Booted with no recorded capacity (before MOTIR-11716 recorded it). */
  notRecorded: number;
  /** Of `launched`, the ones that settled `spot_interrupted`. */
  interrupted: number;
}

/** The CI Spot setting as this read found it — its own read, never inferred. */
export type CiSpotSettingReadDTO = 'on' | 'off' | 'notRead';

export type CiSpotBlockDTO =
  /** The counts were not read. The setting is its own read, so its pill still shows. */
  | { status: 'unavailable'; setting: CiSpotSettingReadDTO }
  | {
      status: 'ok';
      windowDays: typeof CI_SPOT_WINDOW_DAYS;
      setting: CiSpotSettingReadDTO;
      counts: CiSpotCountsDTO;
      /** Spot is on, something launched, and none of it got Spot. */
      allFellBack: boolean;
    };

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
      /** CI Spot use on the install fleet — the `ci_runner` pool only. */
      ciSpot?: CiSpotBlockDTO;
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
  /** `shardAdmissionCeiling`, bound by the granted vCPU quota. */
  | 'granted'
  /** `shardAdmissionCeiling`, bound by the account's machine limit (or no quota read). */
  | 'machineLimit'
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
  /**
   * CI runner pool only: this account's launches in the window; null when it
   * launched none. Absent on every other pool, and when the pool's CI Spot read
   * failed.
   */
  ciSpot?: CiSpotCountsDTO | null;
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
      /** CI Spot use over the pool's accounts — the `ci_runner` pool only. */
      ciSpot?: CiSpotBlockDTO;
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
