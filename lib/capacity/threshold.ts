import type {
  CapacityEntry,
  CapacityLimit,
  CapacityLimitUnit,
  CapacityProvider,
  CapacityRead,
  LaneUsage,
} from '@/lib/gateway/capacityClient';
import { CAPACITY_LIMIT_UNITS } from './alertKeys';

// THE THRESHOLD FUNCTION (Story MOTIR-9539 · MOTIR-9611) — the ONE place that
// decides, for every limit of every entry, its usage, share used and state. The
// scheduled job and the screen load both reach it through
// `capacityAlertEvaluationService.evaluate()`, so they cannot disagree.
//
// Pure: no I/O and no clock. Every comparison is integer cross-multiplication,
// never a rounded float, so 80 % exactly is over at an 80 % share and 79.6 % is
// not. No state carries a usage, share or limit of 0 the read did not report.

/** The near-limit band: this many percentage points below the alert share. */
export const NEAR_LIMIT_BAND_POINTS = 10;

export type CapacityLimitState =
  | 'normal'
  | 'near_limit'
  | 'over_share'
  | 'unavailable'
  | 'unknown_limit'
  | 'not_applicable'
  | 'usage_not_reported';

/** Each unit's live number in a lane; `null` where the contract reports none
 *  (the gateway sums input and output tokens into one `tokensPerMinute`). */
export const UNIT_LANE_FIELD: Record<
  CapacityLimitUnit,
  keyof Omit<LaneUsage, 'rateLimited429'> | null
> = {
  max_concurrency: 'inFlight',
  rpm: 'requestsPerMinute',
  input_tpm: null,
  output_tpm: null,
  tpm: 'tokensPerMinute',
  tpd: 'tokensPerDay',
};

export interface CapacityUsage {
  total: number;
  planning: number;
  agent: number;
}

export interface CapacityLimitEvaluation {
  unit: CapacityLimitUnit;
  limit: CapacityLimit;
  usage: CapacityUsage | null;
  /** `usage / limit × 100`, unrounded; only for a `set` limit above 0 with usage. */
  sharePercent: number | null;
  state: CapacityLimitState;
}

export interface CapacityEntryEvaluation {
  provider: CapacityProvider;
  model: string;
  limits: CapacityLimitEvaluation[];
}

type AnsweredRead = Extract<CapacityRead, { outcome: 'answered' }>;

export interface CapacityEvaluation {
  readAt: Date;
  counterStore: AnsweredRead['counterStore'];
  alertSharePercent: number;
  entries: CapacityEntryEvaluation[];
}

function usageOf(entry: CapacityEntry, unit: CapacityLimitUnit): CapacityUsage | null {
  const field = UNIT_LANE_FIELD[unit];
  const { planning, agent } = entry.lanes;
  // A half-read is never summed as if the missing lane were 0.
  if (field === null || planning === null || agent === null) return null;
  return { total: planning[field] + agent[field], planning: planning[field], agent: agent[field] };
}

/** The state of a `set` limit with a usage — integer arithmetic only. */
export function judgeSetLimit(
  used: number,
  limit: number,
  alertSharePercent: number,
): 'normal' | 'near_limit' | 'over_share' {
  if (limit === 0) return used > 0 ? 'over_share' : 'normal';
  if (used * 100 >= alertSharePercent * limit) return 'over_share';
  const nearFloor = Math.max(0, alertSharePercent - NEAR_LIMIT_BAND_POINTS);
  if (used * 100 >= nearFloor * limit) return 'near_limit';
  return 'normal';
}

function evaluateLimit(
  entry: CapacityEntry,
  unit: CapacityLimitUnit,
  storeLive: boolean,
  alertSharePercent: number,
): CapacityLimitEvaluation {
  const limit = entry.limits[unit];
  const row = (state: CapacityLimitState, usage: CapacityUsage | null = null) => ({
    unit,
    limit,
    usage,
    sharePercent: null,
    state,
  });
  // An entry whose numbers could not be read — the store down, or a lane null
  // (one slow entry, or a half-read) — is unavailable on every row.
  if (!storeLive || entry.lanes.planning === null || entry.lanes.agent === null) {
    return row('unavailable');
  }
  if (limit.status === 'not_applicable') return row('not_applicable');
  const usage = usageOf(entry, unit);
  if (usage === null) return row('usage_not_reported');
  if (limit.status === 'unknown') return row('unknown_limit', usage);
  return {
    unit,
    limit,
    usage,
    sharePercent: limit.value > 0 ? (usage.total / limit.value) * 100 : null,
    state: judgeSetLimit(usage.total, limit.value, alertSharePercent),
  };
}

/** Every entry's limits judged against the alert share, units in contract order. */
export function evaluateCapacityRead(
  read: AnsweredRead,
  alertSharePercent: number,
): CapacityEvaluation {
  const storeLive = read.counterStore.state === 'live';
  return {
    readAt: read.readAt,
    counterStore: read.counterStore,
    alertSharePercent,
    entries: read.entries.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      limits: CAPACITY_LIMIT_UNITS.map((unit) =>
        evaluateLimit(entry, unit, storeLive, alertSharePercent),
      ),
    })),
  };
}
