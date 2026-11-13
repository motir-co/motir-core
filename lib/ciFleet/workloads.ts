import type { Prisma } from '@/generated/prisma/client';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import type { CiContainerWorkload } from '@/lib/repositories/ciContainerUsageRepository';
import type { FleetWorkloadKind } from '@motir/orchestrator';

// THE FLEET WORKLOAD REGISTRY (Story MOTIR-1916 · MOTIR-1997) — the list of
// everything that can be running a container on Motir's fleet, and where each
// one's in-flight count comes from.
//
// This is the policy half of the fleet's admission, the way `limits.ts` is the
// policy half of the caps: it binds counters, it does not decide anything. The
// locking, the summing and the verdict live in `fleetCeilingService`. Since
// MOTIR-6907 the sum that decides is PER ORGANISATION (`countInFlightForOrg`),
// against the org's pool of `docs/decisions/fleet-per-org-pool.md` §2; the
// fleet-wide `countInFlight` stays as the operator's reading.
//
// ⚠️ WHY A REGISTRY AT ALL. MOTIR-1922's ceiling counted
// `ci_runner_provisioning_intent` and nothing else, and its comment was accurate
// — *"bounds Motir's total CI spend"*. MOTIR-1981 decisions 2–3 put CODE-GRAPH
// INDEX containers in the same Fly org and Epic 9 adds HOSTED AGENT containers;
// neither writes a runner intent. Two independent per-workload caps do not
// compose into a bound: real peak concurrency is `runners + index + agents`, and
// no per-workload number expresses it. `docs/decisions/ci-runner-fleet.md` §9
// records that Fly offers NEITHER a spending cap NOR a billing alert, so nothing
// sits underneath this number.
//
// It was measured, not theorised: on 2026-08-02 `system.code-graph-index` and
// `system.code-graph-refresh` each carried `concurrency: 2` against one
// motir-ai, so the effective limit was 4 and neither cap meant what it said.
//
// ⚠️ THE TOTALITY GUARD IS THE `Record<FleetWorkloadKind, …>` BELOW. Adding a
// member to the union without giving it a counter is a COMPILE error, not a
// silently-uncounted workload — which is the whole failure mode this card
// exists to close. Do not weaken it to a `Partial`, a lookup with a fallback, or
// an array.

/**
 * Every kind of container the fleet can be running — DECLARED BY THE PACKAGE and
 * re-exported here (MOTIR-4299).
 *
 * The union is the orchestrator port's own vocabulary (three of its types carry
 * a `workload` field, and every adapter tags a machine with it), so it moved
 * into `@motir/orchestrator` with the port. What stays here is the half that
 * could not go: the COUNTERS below need repositories and a transaction, and a
 * package may not import the app.
 *
 * ⚠️ THE TOTALITY GUARD IS STILL THIS FILE'S `Record<FleetWorkloadKind, …>`, and
 * the move does not weaken it by one inch: a member added to the union in the
 * package without a counter here is a COMPILE error, in this file, on the next
 * type-check. Do not weaken it to a `Partial`, a lookup with a fallback, or an
 * array.
 */
export type { FleetWorkloadKind };

/**
 * Which census total a workload is summed into.
 *
 * The org pool this once named is gone (the fleet-capacity decision MOTIR-9357,
 * amending `docs/decisions/fleet-per-org-pool.md` §2): each workload is held to
 * its own plan figure (`PLAN_FIGURE_BY_WORKLOAD` in `fleetCeilingService`;
 * MOTIR-9373, MOTIR-9375) and no admission or monitor decides on the summed
 * `total`. The split survives only as that total's membership, kept in the
 * census an admission logs: `shared` workloads are summed (CI, indexing, hosted
 * runs), `own` ones are not (agent instances, `docs/decisions/agent-instances.md`
 * AMENDMENT 2, decided by their caller's guard under the same lock).
 */
export type FleetPool = 'shared' | 'own';

export interface FleetWorkload {
  readonly kind: FleetWorkloadKind;
  /** How an operator reads this workload in a ceiling breakdown. */
  readonly label: string;
  /** Which ceiling it counts against — see {@link FleetPool}. */
  readonly pool: FleetPool;
  /**
   * How many containers this workload is holding right now.
   *
   * ⚠️ MUST be read under the `fleet` admission lock, inside the caller's
   * transaction. Every implementation here is a repository single-op that takes
   * a `tx` for exactly that reason.
   */
  countInFlight(now: Date, tx: Prisma.TransactionClient): Promise<number>;
  /**
   * How many of those belong to ONE organisation — this workload's term in that
   * org's pool (MOTIR-6907). The same locking contract as {@link countInFlight}.
   */
  countInFlightForOrg(
    organizationId: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number>;
}

/**
 * Count from the SHARED SLOT TABLE — the counter for a workload that does not
 * own a table of its own yet.
 *
 * A workload that later grows one (its own runs table with a status column)
 * swaps its registry entry to count that instead, and the ceiling stays correct
 * with no change here and none in the service.
 */
function slotBackedWorkload(
  kind: FleetWorkloadKind,
  label: string,
  pool: FleetPool = 'shared',
): FleetWorkload {
  return {
    kind,
    label,
    pool,
    countInFlight: (now, tx) => fleetInFlightSlotRepository.countLiveForWorkload(kind, now, tx),
    countInFlightForOrg: (organizationId, now, tx) =>
      fleetInFlightSlotRepository.countLiveForWorkloadInOrganization(kind, organizationId, now, tx),
  };
}

/**
 * THE REGISTRY. Exhaustive by construction (see the totality guard above).
 *
 * ⚠️ CI COUNTS ITS OWN TABLE AND DOES NOT WRITE A SLOT. `ci_runner_provisioning_
 * intent.status` already IS the CI in-flight window (`provisioning` + `running`),
 * maintained by every claim, release and settle path that exists — so completion
 * frees a fleet slot with no extra bookkeeping, exactly as MOTIR-1922 documented
 * for its own count. Mirroring it into `fleet_in_flight_slot` would add a dual
 * write on the hottest path in the fleet and invent a leak class where none
 * exists. The union is what makes both representations legal at once.
 */
export const FLEET_WORKLOADS: Record<FleetWorkloadKind, FleetWorkload> = {
  ci_runner: {
    kind: 'ci_runner',
    label: 'CI runners',
    pool: 'shared',
    countInFlight: (_now, tx) => ciRunnerProvisioningIntentRepository.countInFlightFleetWide(tx),
    countInFlightForOrg: (organizationId, _now, tx) =>
      ciRunnerProvisioningIntentRepository.countInFlightForOrganization(organizationId, tx),
  },
  code_graph_index: slotBackedWorkload('code_graph_index', 'code-graph index'),
  hosted_agent: slotBackedWorkload('hosted_agent', 'Motir agent runs'),
  // MOTIR-6872 — a user agent instance holds a slot for exactly as long as its
  // machine runs (`docs/decisions/agent-instances.md` §6). Its OWN pool
  // (AMENDMENT 2): counted and slotted here, never summed into CI's ceiling.
  agent_instance: slotBackedWorkload('agent_instance', 'agent instances', 'own'),
};

/** Every registered kind, in a stable order — the iteration order of the
 *  registry, so a new workload appears in every breakdown without a second edit. */
export const FLEET_WORKLOAD_KINDS = Object.keys(FLEET_WORKLOADS) as FleetWorkloadKind[];

/**
 * THE COST AXIS (Story MOTIR-1981 · MOTIR-1995) — this registry's kind as the
 * COGS meter records it.
 *
 * ⚠️ WHY TWO VOCABULARIES FOR ONE THING, AND WHY THAT IS NOT DRIFT. The registry
 * names an OPERATIONAL kind (`ci_runner` is a thing that registers with GitHub
 * and holds a provisioning intent); `ci_container_usage.workload` names a
 * COMMERCIAL LINE — `ci` / `index` / `agent` — and shipped with MOTIR-1924, ahead
 * of two of its three values, for the same reason the union did. Collapsing them
 * would mean either renaming a persisted column's values (rewriting history to
 * match a code identifier) or renaming the union to match the database. Mapping
 * once, HERE, is what keeps both stable.
 *
 * ⚠️ TOTAL BY CONSTRUCTION, exactly like {@link FLEET_WORKLOADS}. A fourth
 * workload that does not declare its cost line is a COMPILE error rather than
 * spend recorded under whatever value the writer happened to pass — which is the
 * failure MOTIR-1981 was filed over, one field along: the story claimed index
 * container-seconds were already "attributable per MOTIR-1924's cost meter" when
 * nothing mapped them at all. Do not weaken it to a `Partial` or a lookup with a
 * fallback; a fallback here silently merges a new workload into an existing line.
 */
export const CONTAINER_WORKLOAD_BY_FLEET_KIND: Record<FleetWorkloadKind, CiContainerWorkload> = {
  ci_runner: 'ci',
  code_graph_index: 'index',
  hosted_agent: 'agent',
  // Its OWN line (MOTIR-6872): an instance is not a hosted run, and the guard
  // below this map refuses two kinds collapsing onto one line.
  agent_instance: 'instance',
};

/** The cost line a container of this kind is recorded under. A function rather
 *  than direct indexing at the call sites, so the map has ONE reader and the
 *  meter never has to know the registry's shape. */
export function containerWorkloadFor(kind: FleetWorkloadKind): CiContainerWorkload {
  return CONTAINER_WORKLOAD_BY_FLEET_KIND[kind];
}

/** The workloads that register their containers in `fleet_in_flight_slot`
 *  rather than counting a table of their own. Exported so the seam is
 *  discoverable — and assertable — rather than inferred from the bindings. */
export const SLOT_BACKED_WORKLOADS: FleetWorkloadKind[] = FLEET_WORKLOAD_KINDS.filter(
  (kind) => kind !== 'ci_runner',
);
