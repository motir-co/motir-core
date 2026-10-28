import { HOST_PLAN_KEY, planCarriesOwnAccounts } from '@/lib/billing/ownAccountPlans';

// THE PLAN CAPS (Story MOTIR-9363 · MOTIR-9372) — what an organisation's AI plan
// lets it run on Motir's fleets at once. Pure: no `db`, no `process.env`. The read
// that turns an organisation into one of these rows is `planCapsService.capsFor`.
//
// The figures are the owner's — MOTIR-9357 as corrected at its gate (2026-10-23),
// with the CI burst caps of Pro, Max and Max ×2 raised on 2026-10-26 (MOTIR-9668).
// That fleet-capacity direction change amends `docs/decisions/fleet-per-org-pool.md`
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
// `lib/billing/ownAccountPlans.ts`) reads its SHARED FLOOR here — Host's row,
// `HOST_FLOOR_CAPS`, or the larger pools' `LARGER_POOL_FLOOR_CAPS`. Once its own account of a kind is live, `planCapsService`
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
 * HOST'S SHARED FLOOR (MOTIR-9587 · MOTIR-9668): 5 runs, agents 5 per user and 20
 * running per org, and a CI burst of 20. A Host org runs at these until its own
 * account of a kind is live; then `planCapsService` replaces that kind's figure
 * with the account's own (`hostOwnAccountCaps.ts`). Not the larger pools' floor:
 * the two differ.
 */
export const HOST_FLOOR_CAPS: PlanCaps = caps(5, 5, 20, 20);

/**
 * THE LARGER POOLS' SHARED FLOOR (MOTIR-9366 · MOTIR-9653): every rung on sale runs
 * at these until its own account of a kind is live — 5 runs, agents 10 per user and
 * 50 running per org, and a CI burst of 20 (owner, 2026-10-26). Its own accounts
 * then replace the runs and CI figures exactly as Host's do; the agent figures are
 * already the rungs' 10 / 50 and stay.
 */
export const LARGER_POOL_FLOOR_CAPS: PlanCaps = caps(5, 10, 50, 20);

/** The exactly-keyed rows. `free` is all zeros: it pays for no fleet, and the
 *  paid-plan gate refuses it before any figure is read. */
export const PLAN_CAPS: Readonly<Record<string, PlanCaps>> = Object.freeze({
  free: caps(0, 0, 0, 0),
  standard: caps(1, 1, 2, 2),
  pro: caps(3, 2, 10, 5),
  max: caps(5, 3, 20, 10),
  max_x2: caps(5, 3, 20, 15),
  [HOST_PLAN_KEY]: HOST_FLOOR_CAPS,
});

/** The plan's four figures, or `null` when the key has no row. Never a default:
 *  a key is resolved exactly, or — for an on-sale larger pool, named through the
 *  catalog by `planCarriesOwnAccounts`, never by its key's shape — to the larger
 *  pools' floor. */
export function capsForPlanKey(key: string): PlanCaps | null {
  if (Object.prototype.hasOwnProperty.call(PLAN_CAPS, key)) return PLAN_CAPS[key]!;
  return planCarriesOwnAccounts(key) ? LARGER_POOL_FLOOR_CAPS : null;
}
