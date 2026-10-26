import type { CapacityEntry, CapacityLimitUnit, LaneUsage } from '@/lib/gateway/capacityClient';
import {
  AGENT_SHARE_EXHAUSTED,
  PROVIDER_RATE_LIMITED,
  type AgentCapacityReason,
} from './capacityReasons';

// THE AGENT-RUN CAPACITY RULE (MOTIR-9627) — pure, no I/O. Given one model's
// capacity entry from the gateway's read (`docs/motir-capacity-api.md` §3), does
// an agent run on it have capacity right now?
//
//   1. SHARE FULL — a `set` limit on a unit the agent lane reports, minus the
//      planning share (the gateway's own rounding, MOTIR-9598), reached by the
//      agent lane's figure → `agent_share_exhausted`.
//   2. 429s NOW — a provider 429 this minute on either lane, or one seen within
//      the configurable window → `provider_rate_limited`. Rule 1 wins when both hold.
//   3. NO NUMBER MEANS AVAILABLE — an `unknown` / `not_applicable` limit, the
//      split `input_tpm` / `output_tpm` (the lane reports only combined tokens),
//      and a `null` agent lane govern nothing. The gateway's own admission still
//      enforces whatever core cannot compare.
//
// ⚠️ The verdict carries only `verdict` and `reason` — never a counter or a
// limit — so no number can reach a caller by accident.

export type AgentCapacityVerdict =
  | { verdict: 'available' }
  | { verdict: 'no_capacity'; reason: AgentCapacityReason };

/** The units core can compare, each to the agent-lane figure that measures it. */
export const COMPARED_UNITS: Readonly<Partial<Record<CapacityLimitUnit, keyof LaneUsage>>> =
  Object.freeze({
    max_concurrency: 'inFlight',
    rpm: 'requestsPerMinute',
    tpm: 'tokensPerMinute',
    tpd: 'tokensPerDay',
  });

const AVAILABLE: AgentCapacityVerdict = Object.freeze({ verdict: 'available' });

function noCapacity(reason: AgentCapacityReason): AgentCapacityVerdict {
  return { verdict: 'no_capacity', reason };
}

/** The agent lane's share of a limit: what the planning share does not reserve. */
export function agentShareOf(value: number, planningSharePercent: number): number {
  return value - Math.ceil((value * planningSharePercent) / 100);
}

/** Rule 1: has the agent lane reached its share of any compared, set limit? */
export function agentShareExhausted(entry: CapacityEntry): boolean {
  const agent = entry.lanes.agent;
  if (!agent) return false;
  for (const [unit, field] of Object.entries(COMPARED_UNITS) as [
    CapacityLimitUnit,
    keyof LaneUsage,
  ][]) {
    const limit = entry.limits[unit];
    if (limit?.status !== 'set') continue;
    const used = agent[field] as number;
    if (used >= agentShareOf(limit.value, entry.planningSharePercent)) return true;
  }
  return false;
}

/** Rule 2's count: this minute's provider 429s over the lanes that were read. */
export function rateLimitedThisMinute(entry: CapacityEntry): number {
  const { planning, agent } = entry.lanes;
  return (agent?.rateLimited429.minute ?? 0) + (planning?.rateLimited429.minute ?? 0);
}

/** Rule 2's window: was a 429 seen recently enough to still hold the model? */
export function withinRateLimitWindow(
  rateLimitedSince: number | null,
  now: number,
  windowMs: number,
): boolean {
  return rateLimitedSince !== null && now - rateLimitedSince < windowMs;
}

/**
 * The verdict for one entry. `rateLimitedSince` is the last moment the caller
 * saw a non-zero 429 count for this model (null if never); `now` and `windowMs`
 * are injected so tests drive the window with fake timers.
 */
export function computeAgentCapacityVerdict(
  entry: CapacityEntry,
  rateLimitedSince: number | null,
  now: number,
  windowMs: number,
): AgentCapacityVerdict {
  if (agentShareExhausted(entry)) return noCapacity(AGENT_SHARE_EXHAUSTED);
  if (rateLimitedThisMinute(entry) > 0) return noCapacity(PROVIDER_RATE_LIMITED);
  if (withinRateLimitWindow(rateLimitedSince, now, windowMs)) {
    return noCapacity(PROVIDER_RATE_LIMITED);
  }
  return AVAILABLE;
}
