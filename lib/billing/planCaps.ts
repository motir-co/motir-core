// THE PLAN CAPS (Story MOTIR-9363 · MOTIR-9372) — what an organisation's AI plan
// lets it run on Motir's fleets at once. Pure: no `db`, no `process.env`. The read
// that turns an organisation into one of these rows is `planCapsService.capsFor`.
//
// The figures are the owner's (2026-10-23), recorded by the fleet-capacity
// direction change, MOTIR-9357, which amends `docs/decisions/fleet-per-org-pool.md`
// §2: the flat 500-container pool every paid org shared across CI, indexing and
// hosted runs is replaced by one figure PER WORKLOAD, read from the plan the org
// pays for. Each figure is counted from Motir's own slot and instance records, so
// a container counts once whichever provider or account it boots on.
//
//   * `agentRunsInParallel` — the org's in-flight hosted-agent run containers.
//   * `agentsPerUser`       — a user's live (not deleted) agent instances.
//   * `agentsRunningPerOrg` — the org's running agent instances.
//   * `ciBurstCap`          — the org's in-flight CI runner containers. A
//     protection number, not capacity: the planning plans are expected to run CI
//     on the org's own GitHub runners, so this only stops one org's burst from
//     crowding the shared pool. `Organization.fleetPoolCap` overrides THIS figure
//     alone (the CI admission's business, never this table's).
//
// Code-graph indexing is under no figure here: Motir charges nobody for it, and
// it keeps its own index caps (`lib/ciFleet/limits.ts`).
//
// ⚠️ TOTAL OVER THE CATALOG, AND NEVER A DEFAULT. Plan keys are motir-ai
// `PlanTier` rows, so the key set is data. `capsForPlanKey` answers `null` for a
// key with no row, and the service turns that into `plan_unknown` — refused, the
// key kept — rather than a plausible neighbour's figures. Keys resolve EXACTLY
// first; `max` must never swallow `max_x2` by prefix.

export interface PlanCaps {
  agentRunsInParallel: number;
  agentsPerUser: number;
  agentsRunningPerOrg: number;
  ciBurstCap: number;
}

/**
 * The Host plan's key. Host is not in `BILLING_CATALOG` yet (its own card adds
 * it); the row is here first so a Host org is never uncapped and never refused,
 * whichever lands first. The totality test covers the catalog AND this key.
 */
export const HOST_PLAN_KEY = 'host';

function caps(
  agentRunsInParallel: number,
  agentsPerUser: number,
  agentsRunningPerOrg: number,
  ciBurstCap: number,
): PlanCaps {
  return Object.freeze({ agentRunsInParallel, agentsPerUser, agentsRunningPerOrg, ciBurstCap });
}

/** The exactly-keyed rows. `free` is all zeros: it pays for no fleet, and the
 *  paid-plan gate refuses it before any figure is read. */
export const PLAN_CAPS: Readonly<Record<string, PlanCaps>> = Object.freeze({
  free: caps(0, 0, 0, 0),
  standard: caps(1, 1, 5, 5),
  pro: caps(3, 5, 30, 10),
  max: caps(5, 10, 50, 25),
  max_x2: caps(5, 10, 50, 25),
  // THE SHARED FLOOR (MOTIR-9587): a Host org runs at these figures until its
  // own account of a kind is live; then `planCapsService` replaces that kind's
  // figure (agent runs, CI burst) with the account's granted vCPU ÷ 2.
  [HOST_PLAN_KEY]: caps(5, 10, 50, 50),
});

/**
 * Every larger pool (`pool_<N>k`, the catalog's own key shape), until those plans
 * get accounts of their own: Max ×2's agent figures, the top of the ladder they
 * sit above, and Host's shared-floor CI burst of 50.
 */
export const LARGER_POOL_CAPS: PlanCaps = caps(5, 10, 50, 50);

const LARGER_POOL_KEY = /^pool_\d+k$/;

/** The plan's four figures, or `null` when the key has no row. Never a default. */
export function capsForPlanKey(key: string): PlanCaps | null {
  if (Object.prototype.hasOwnProperty.call(PLAN_CAPS, key)) return PLAN_CAPS[key]!;
  if (LARGER_POOL_KEY.test(key)) return LARGER_POOL_CAPS;
  return null;
}
