import type {
  CapacityEntry,
  CapacityLimit,
  CapacityLimitUnit,
  CapacityProvider,
  CapacityRead,
  LaneUsage,
} from '@/lib/gateway/capacityClient';

// Hand-built capacity reads for the threshold and evaluation tests (MOTIR-9611).

export const NA: CapacityLimit = { status: 'not_applicable' };
export const UNKNOWN: CapacityLimit = { status: 'unknown' };
export const set = (value: number): CapacityLimit => ({ status: 'set', value });

export function lane(figures: Partial<Omit<LaneUsage, 'rateLimited429'>> = {}): LaneUsage {
  return {
    inFlight: 0,
    requestsPerMinute: 0,
    tokensPerMinute: 0,
    tokensPerDay: 0,
    rateLimited429: { minute: 0, day: 0 },
    ...figures,
  };
}

export function entry(
  provider: CapacityProvider,
  model: string,
  limits: Partial<Record<CapacityLimitUnit, CapacityLimit>>,
  lanes: CapacityEntry['lanes'] = { planning: lane(), agent: lane() },
): CapacityEntry {
  return {
    provider,
    model,
    tierNote: '',
    unknownNote: '',
    planningSharePercent: 50,
    limits: {
      max_concurrency: NA,
      rpm: NA,
      input_tpm: NA,
      output_tpm: NA,
      tpm: NA,
      tpd: NA,
      ...limits,
    },
    lanes,
    providerHint: null,
  };
}

/** A live, answered read taken at `second` past the minute. */
export function answered(
  entries: CapacityEntry[],
  options: { second?: number; store?: 'live' | 'unavailable' } = {},
): Extract<CapacityRead, { outcome: 'answered' }> {
  const second = String(options.second ?? 45).padStart(2, '0');
  return {
    outcome: 'answered',
    readAt: new Date(`2026-10-25T12:00:${second}Z`),
    counterStore: { state: options.store ?? 'live', scope: 'shared' },
    entries,
  };
}

/** A deepseek entry whose concurrency in use is `used` (planning 1/4, agent 3/4 when it divides). */
export function concurrency(used: number, limit = 100): CapacityEntry {
  const planning = Math.floor(used / 4);
  return entry(
    'deepseek',
    'deepseek-example-1',
    { max_concurrency: set(limit) },
    { planning: lane({ inFlight: planning }), agent: lane({ inFlight: used - planning }) },
  );
}
