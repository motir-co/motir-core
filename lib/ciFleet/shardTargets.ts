// THE FLEET'S SIZING TARGETS AND THE DERIVATIONS FROM THEM (Story MOTIR-8953 ·
// MOTIR-8963) — pure configuration, no database.
//
// `docs/decisions/fleet-per-org-pool.md` AMENDMENT 1 is why the numbers are what
// they are. This module holds every target ONCE; everything that depends on one
// is COMPUTED from it here, never typed a second time:
//
//   * `TENANT_TARGET` — what one target-sized tenant may use (≤ ¼ of Motir's
//     own measured usage). PRE-LAUNCH TARGETS, NOT MEASUREMENTS.
//   * `tenantsPerShard` — how many such tenants a set of recorded limits carries,
//     and which limit binds. The GitHub limits are counted per GitHub ORG,
//     whichever account boots the machine, so a GitHub org's limits alone give the
//     number of tenants that org can carry.
//   * `shardAdmissionCeiling` — an account's concurrent-container ceiling, from its
//     own granted vCPU quota and the container size.
//
// ⚠️ DERIVED, NEVER SEPARATELY CONFIGURED — the rule `orgIndexInFlightCap` states
// in `limits.ts`. There is deliberately no `MOTIR_*` env var for a target or for
// an account's ceiling: two independent numbers drift, and the invariant that
// matters — *one tenant takes at most what it was sized for* — is only
// expressible as a relation between them.

import { FLEET_CONTAINER_SIZE, type FleetWorkloadKind } from '@motir/orchestrator';
import { GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN } from '@/lib/github/runnerJitConfig';

const FIVE_MINUTES_SECONDS = 5 * 60;
const HOUR_SECONDS = 60 * 60;

/**
 * ONE TARGET TENANT (ADR AMENDMENT 1, *The targets*) — at most a quarter of
 * Motir's own measured CI usage. Pre-launch targets, not measurements.
 *
 * `peakVcpu` is DERIVED from `peakRunners` and the fleet's container size, so a
 * change to either moves it; it is never typed as a literal.
 */
export const TENANT_TARGET = (() => {
  const peakRunners = 26;
  return {
    /** Runners one tenant has in flight at once. Also the per-org pool default. */
    peakRunners,
    /** Runner starts one tenant makes in any 5 minutes. */
    startsPer5Min: 31,
    /** Runner starts one tenant makes in any hour. */
    startsPerHour: 40,
    /** GitHub API calls per runner: the `generate-jitconfig` mint and the settle `DELETE`. */
    githubCallsPerRunner: 2,
    /** vCPU one tenant holds at its peak — `peakRunners × FLEET_CONTAINER_SIZE.cpus`. */
    peakVcpu: peakRunners * FLEET_CONTAINER_SIZE.cpus,
  } as const;
})();

/**
 * THE TARGET ACCOUNT's granted EC2 on-demand standard vCPU quota (`L-1216C47A`).
 * A pre-launch target: not measured here — see MOTIR-9274 / MOTIR-9275.
 */
export const SHARD_VCPU_QUOTA_TARGET = 2500;

/**
 * GitHub's primary REST limit for an App installation in an Enterprise Cloud org,
 * per hour — the `core` resource MOTIR-8959 read on every mint
 * (`x-ratelimit-limit: 15000`).
 */
export const GITHUB_INSTALLATION_API_PER_HOUR = 15_000;

/**
 * The share of a limit at which an account or GitHub org reads as running out of
 * headroom (ADR AMENDMENT 1, *Headroom*): 70% of the granted vCPU quota, and of
 * each GitHub limit per GitHub org. The headroom reading (MOTIR-8969) and the
 * pool-growth trigger read it.
 */
export const HEADROOM_ALERT_FRACTION = 0.7;

/** Sustained deferral (MOTIR-8969) — a pre-launch target: the window read. */
export const SUSTAINED_DEFERRAL_WINDOW_MINUTES = 60;
/** A pre-launch target: fewer deferred jobs than this in the window never alert. */
export const SUSTAINED_DEFERRAL_MIN_JOBS = 10;
/** A pre-launch target: the share of the window's jobs deferred that alerts. */
export const SUSTAINED_DEFERRAL_FRACTION = 0.2;

/** A GitHub secondary limit runner minting is held to. */
export interface GithubSecondaryLimit {
  /** What the limit is, for the `boundBy` answer and the headroom reading. */
  readonly name: string;
  /** How many counted calls GitHub allows per period, per GitHub org. */
  readonly perPeriod: number;
  /** The period, in seconds. */
  readonly periodSeconds: number;
  /** How many of a runner's GitHub calls count toward it. */
  readonly callsCountedPerRunner: number;
  /** Which runner calls count toward it — what the headroom pass counts
   *  (MOTIR-8969). Its length is `callsCountedPerRunner`. */
  readonly countsCalls: readonly ('mint' | 'delete')[];
  /**
   * `applies` — measured to bind; `assumed` — not measured, so counted as binding
   * (ADR AMENDMENT 1: an unknown limit is written "assumed to apply").
   */
  readonly verdict: 'applies' | 'assumed';
}

/**
 * THE SECONDARY LIMITS RUNNER MINTING IS HELD TO — every limit MOTIR-8959 found to
 * apply, and every one it left unmeasured (ADR AMENDMENT 1, *GitHub's secondary
 * limits*). The published content-creating (80/min, 500/h) and points (900/min)
 * limits were measured NOT to apply and are not here.
 */
export const GITHUB_SECONDARY_LIMITS = {
  /**
   * The unpublished per-org limit on `generate-jitconfig`: refused at ~340 mints
   * in a rolling minute, 300/min sustained cleanly (MOTIR-8959, 2026-10-23). The
   * settle `DELETE` does not count toward it. Counting the 5-minute target spread
   * evenly over its minutes is the PACED reading: admission paces mints to it.
   */
  jitconfigMintsPerMinute: {
    name: 'github_jitconfig_mints_per_minute',
    perPeriod: 300,
    periodSeconds: 60,
    callsCountedPerRunner: 1,
    countsCalls: ['mint'],
    verdict: 'applies',
  },
  /**
   * 100 concurrent requests, shared across REST and GraphQL. Mints were measured
   * not to reach it (107 in flight passed); the `DELETE` was not tested above ~5
   * in flight, so it is assumed to apply to both calls. Counted as calls over one
   * second — Little's law at the measured ~1 s per call.
   */
  concurrentRequests: {
    name: 'github_concurrent_requests',
    perPeriod: 100,
    periodSeconds: 1,
    callsCountedPerRunner: 2,
    countsCalls: ['mint', 'delete'],
    verdict: 'assumed',
  },
} as const satisfies Record<string, GithubSecondaryLimit>;

/**
 * The limits a set of tenants is sized against. Every one is optional: a limit
 * not given is not counted, so a GitHub org's limits alone (no vCPU, no machines)
 * give the number of tenants that org can carry.
 */
export interface ShardLimits {
  /** The account's granted vCPU quota. */
  readonly vcpuQuota?: number | null;
  /** The account's machine limit, where its provider records one. */
  readonly machineLimit?: number | null;
  /** GitHub runner registrations per 5 minutes, per GitHub org. */
  readonly registrationsPer5Min?: number | null;
  /** GitHub installation API calls per hour, per GitHub org. */
  readonly installationApiPerHour?: number | null;
  /** The GitHub secondary limits that apply, per GitHub org. */
  readonly secondaryLimits?: readonly GithubSecondaryLimit[];
}

/** How many target tenants a set of limits carries, and the limit that bound it. */
export interface TenantsPerShard {
  /** `Infinity` when no limit was given. */
  readonly tenants: number;
  /** The limit with the fewest tenants; null when no limit was given. */
  readonly boundBy: string | null;
}

/**
 * One target tenant's runner starts in a window of `periodSeconds`: the 5-minute
 * target spread evenly over the window, never more than the hourly target allows
 * in any hour.
 */
function tenantStartsOver(periodSeconds: number): number {
  return Math.min(
    (TENANT_TARGET.startsPer5Min * periodSeconds) / FIVE_MINUTES_SECONDS,
    TENANT_TARGET.startsPerHour * Math.max(1, periodSeconds / HOUR_SECONDS),
  );
}

/**
 * HOW MANY TARGET TENANTS THE LIMITS CARRY — `floor(min(limit ÷ one target
 * tenant's demand on that limit))` over every limit given, and which limit bound
 * it. A tenant's demand is: vCPU `peakVcpu`; machines `peakRunners`;
 * registrations `startsPer5Min`; installation API `startsPerHour ×
 * githubCallsPerRunner`; a secondary limit, the starts in its period × the calls
 * it counts.
 */
export function tenantsPerShard(limits: ShardLimits): TenantsPerShard {
  const lines: { name: string; limit: number | null | undefined; demand: number }[] = [
    { name: 'vcpu_quota', limit: limits.vcpuQuota, demand: TENANT_TARGET.peakVcpu },
    { name: 'machine_limit', limit: limits.machineLimit, demand: TENANT_TARGET.peakRunners },
    {
      name: 'github_registrations_per_5_min',
      limit: limits.registrationsPer5Min,
      demand: TENANT_TARGET.startsPer5Min,
    },
    {
      name: 'github_installation_api_per_hour',
      limit: limits.installationApiPerHour,
      demand: TENANT_TARGET.startsPerHour * TENANT_TARGET.githubCallsPerRunner,
    },
    ...(limits.secondaryLimits ?? []).map((secondary) => ({
      name: secondary.name,
      limit: secondary.perPeriod,
      demand: tenantStartsOver(secondary.periodSeconds) * secondary.callsCountedPerRunner,
    })),
  ];

  let best: TenantsPerShard = { tenants: Infinity, boundBy: null };
  for (const line of lines) {
    if (line.limit === null || line.limit === undefined) continue;
    const tenants = Math.floor(line.limit / line.demand);
    if (tenants < best.tenants) best = { tenants, boundBy: line.name };
  }
  return best;
}

/**
 * AN ACCOUNT'S CONCURRENT-CONTAINER CEILING — `floor(vcpuQuota ÷
 * FLEET_CONTAINER_SIZE.cpus)`, never above its machine limit when one is
 * recorded. It follows the GRANTED quota: a raise that is granted and recorded
 * moves it, and nothing is typed a second time. Null when neither is recorded.
 */
export function shardAdmissionCeiling(
  limits: Pick<ShardLimits, 'vcpuQuota' | 'machineLimit'>,
): number | null {
  const ceilings: number[] = [];
  if (limits.vcpuQuota !== null && limits.vcpuQuota !== undefined) {
    ceilings.push(Math.floor(limits.vcpuQuota / FLEET_CONTAINER_SIZE.cpus));
  }
  if (limits.machineLimit !== null && limits.machineLimit !== undefined) {
    ceilings.push(limits.machineLimit);
  }
  return ceilings.length === 0 ? null : Math.min(...ceilings);
}

/**
 * THE TARGET ACCOUNT's limits: its vCPU quota, GitHub's registration and
 * installation limits, and every applicable secondary limit.
 */
export const TARGET_SHARD_LIMITS: ShardLimits = {
  vcpuQuota: SHARD_VCPU_QUOTA_TARGET,
  registrationsPer5Min: GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN,
  installationApiPerHour: GITHUB_INSTALLATION_API_PER_HOUR,
  secondaryLimits: Object.values(GITHUB_SECONDARY_LIMITS),
};

/** How many target tenants the target account carries — computed, never typed. */
export const DERIVED_TENANTS_PER_SHARD_TARGET = tenantsPerShard(TARGET_SHARD_LIMITS).tenants;

/**
 * How long admission skips an account after it refused a provision for capacity
 * or was unreachable (ADR AMENDMENT 1, *The admission order*; MOTIR-8968). A pause,
 * not a probe: for this long every job goes elsewhere instead of paying a create
 * timeout first, and the first job after it ends re-tests the account.
 */
export const SHARD_PAUSE_SECONDS = 120;

/**
 * The vCPU quota a NEW pool account of each kind asks AWS for at creation
 * (Story MOTIR-9362 · MOTIR-9460) — pre-launch figures (the story's assumption
 * r3): a CI runner account boots many short VMs; an agent runner, an agent host
 * and an indexer account few. The unattended add-shard files the kind's raise
 * the moment the account exists, so the spare is asking for its quota from then.
 */
export const POOL_ACCOUNT_RAISE_TARGET_VCPU: Readonly<Record<FleetWorkloadKind, number>> = {
  ci_runner: 200,
  agent_instance: 32,
  hosted_agent: 32,
  code_graph_index: 16,
};

/** The raise a new pool account of `kind` files. */
export function poolAccountRaiseTargetVcpu(kind: FleetWorkloadKind): number {
  return POOL_ACCOUNT_RAISE_TARGET_VCPU[kind];
}

/** Reads one fleet kind's Fly↔AWS switch: true = the kind boots on its pool. */
export type FleetKindSwitchReader = () => boolean | Promise<boolean>;

const kindSwitches = new Map<FleetWorkloadKind, FleetKindSwitchReader>();

/**
 * Wire a fleet kind's Fly↔AWS switch. Each kind's own story owns its switch
 * (CI's is MOTIR-9270) and wires its reader here; `null` unwires it. Until then
 * the kind reads Fly.
 */
export function wireFleetKindSwitch(
  kind: FleetWorkloadKind,
  reader: FleetKindSwitchReader | null,
): void {
  if (reader === null) kindSwitches.delete(kind);
  else kindSwitches.set(kind, reader);
}

/**
 * IS THIS FLEET KIND ON ITS POOL? — the one read of a kind's Fly↔AWS switch.
 * Read on every job, never cached, so flipping one kind takes effect on its next
 * job and touches no other kind. A kind whose switch is not wired reads Fly:
 * today's path, the process-wide fleet.
 */
export async function fleetKindOnPool(kind: FleetWorkloadKind): Promise<boolean> {
  const reader = kindSwitches.get(kind);
  return reader ? (await reader()) === true : false;
}
