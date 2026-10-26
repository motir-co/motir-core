import { HOST_PLAN_KEY, planCarriesOwnAccounts } from '@/lib/billing/ownAccountPlans';

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
// first; `max` must never swallow `max_x2` by prefix. A larger pool resolves
// through the catalog (`planCarriesOwnAccounts`), never by its key's shape, so a
// `pool_<N>k` no catalog entry sells has no row.
//
// A plan that carries its own AWS accounts (Host and the larger pools on sale,
// `lib/billing/ownAccountPlans.ts`) reads `OWN_ACCOUNT_FLOOR_CAPS` here — its
// SHARED FLOOR. Once its own account of a kind is live, `planCapsService`
// replaces that kind's figure with the account's own (`hostOwnAccountCaps.ts`).

export interface PlanCaps {
  agentRunsInParallel: number;
  agentsPerUser: number;
  agentsRunningPerOrg: number;
  ciBurstCap: number;
}

/** The Host plan's key (declared beside `planCarriesOwnAccounts`). The totality
 *  test covers the catalog AND this key. */
export { HOST_PLAN_KEY };

function caps(
  agentRunsInParallel: number,
  agentsPerUser: number,
  agentsRunningPerOrg: number,
  ciBurstCap: number,
): PlanCaps {
  return Object.freeze({ agentRunsInParallel, agentsPerUser, agentsRunningPerOrg, ciBurstCap });
}

/**
 * THE SHARED FLOOR of every plan that carries its own accounts — Host and the
 * larger pools on sale (MOTIR-9587; the rungs, MOTIR-9366 · MOTIR-9653): Max ×2's
 * agent figures with a CI burst of 50. An org runs at these until its own account
 * of a kind is live; then `planCapsService` replaces that kind's figure (agent
 * runs, CI burst) with the account's granted vCPU ÷ 2. `agentsPerUser` and
 * `agentsRunningPerOrg` stay the floor's on every such plan.
 */
export const OWN_ACCOUNT_FLOOR_CAPS: PlanCaps = caps(5, 10, 50, 50);

/** The six rungs MOTIR-9366 retired (`pool_80k` … `pool_250k`), resolved by
 *  their exact keys: the figures their holders ran at before, on the shared
 *  pools only. Any other `pool_<N>k` shape has no row. */
export const RETIRED_POOL_CAPS: PlanCaps = caps(5, 10, 50, 50);

/** The exactly-keyed rows. `free` is all zeros: it pays for no fleet, and the
 *  paid-plan gate refuses it before any figure is read. */
export const PLAN_CAPS: Readonly<Record<string, PlanCaps>> = Object.freeze({
  free: caps(0, 0, 0, 0),
  standard: caps(1, 1, 5, 5),
  pro: caps(3, 5, 30, 10),
  max: caps(5, 10, 50, 25),
  max_x2: caps(5, 10, 50, 25),
  [HOST_PLAN_KEY]: OWN_ACCOUNT_FLOOR_CAPS,
  // The rungs retired by MOTIR-9366: their holders keep the figures they ran at,
  // on the shared pools for good — a retired rung carries no accounts of its own.
  pool_80k: RETIRED_POOL_CAPS,
  pool_100k: RETIRED_POOL_CAPS,
  pool_120k: RETIRED_POOL_CAPS,
  pool_150k: RETIRED_POOL_CAPS,
  pool_200k: RETIRED_POOL_CAPS,
  pool_250k: RETIRED_POOL_CAPS,
});

/** The plan's four figures, or `null` when the key has no row. Never a default:
 *  a key is resolved exactly, or — for an on-sale larger pool, named through the
 *  catalog by `planCarriesOwnAccounts`, never by its key's shape — to the floor
 *  of the plans that carry their own accounts. */
export function capsForPlanKey(key: string): PlanCaps | null {
  if (Object.prototype.hasOwnProperty.call(PLAN_CAPS, key)) return PLAN_CAPS[key]!;
  return planCarriesOwnAccounts(key) ? OWN_ACCOUNT_FLOOR_CAPS : null;
}
