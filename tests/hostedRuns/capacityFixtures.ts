import type {
  CapacityEntry,
  CapacityLimit,
  CapacityLimitUnit,
  LaneUsage,
} from '@/lib/gateway/capacityClient';

// Capacity-read fixtures for the agent-run capacity verdict (MOTIR-9627).

export const UNKNOWN: CapacityLimit = { status: 'unknown' };

export function set(value: number): CapacityLimit {
  return { status: 'set', value };
}

export function lane(over: Partial<LaneUsage> = {}): LaneUsage {
  return {
    inFlight: 0,
    requestsPerMinute: 0,
    tokensPerMinute: 0,
    tokensPerDay: 0,
    rateLimited429: { minute: 0, day: 0 },
    ...over,
  };
}

export function entry(over: {
  provider?: CapacityEntry['provider'];
  model?: string;
  planningSharePercent?: number;
  limits?: Partial<Record<CapacityLimitUnit, CapacityLimit>>;
  agent?: LaneUsage | null;
  planning?: LaneUsage | null;
}): CapacityEntry {
  return {
    provider: over.provider ?? 'claude',
    model: over.model ?? 'claude-opus-5-5',
    tierNote: '',
    unknownNote: '',
    planningSharePercent: over.planningSharePercent ?? 0,
    limits: {
      max_concurrency: UNKNOWN,
      rpm: UNKNOWN,
      input_tpm: UNKNOWN,
      output_tpm: UNKNOWN,
      tpm: UNKNOWN,
      tpd: UNKNOWN,
      ...over.limits,
    },
    lanes: {
      planning: over.planning === undefined ? lane() : over.planning,
      agent: over.agent === undefined ? lane() : over.agent,
    },
    providerHint: null,
  };
}
