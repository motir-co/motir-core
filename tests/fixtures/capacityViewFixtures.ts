import type {
  PlatformCapacityEntryDTO,
  PlatformCapacityLimitRowDTO,
  PlatformCapacityViewDTO,
} from '@/lib/dto/platformCapacity';

// The capacity SCREEN's view-model fixtures (MOTIR-9614): plain DTOs shaped as
// `platformCapacityService.getView` answers them, one per state the design
// draws. No identifier, no credential — the DTO carries none, and the screen's
// props test serialises these to prove it.

export const READ_AT = '2026-10-25T12:00:04.000Z';

const NA: PlatformCapacityLimitRowDTO['limit'] = { status: 'not_applicable' };

function row(
  unit: PlatformCapacityLimitRowDTO['unit'],
  partial: Partial<PlatformCapacityLimitRowDTO>,
): PlatformCapacityLimitRowDTO {
  return {
    unit,
    limit: NA,
    usage: null,
    sharePercent: null,
    state: 'not_applicable',
    ...partial,
  };
}

/** Claude: rpm live and normal, input/output tokens not reported, three units N/A. */
export function claudeEntry(): PlatformCapacityEntryDTO {
  return {
    provider: 'claude',
    model: 'claude-example-1',
    tierNote: 'Example tier 4',
    unknownNote: '',
    planningSharePercent: 50,
    limits: [
      row('max_concurrency', {}),
      row('rpm', {
        limit: { status: 'set', value: 1000 },
        usage: { total: 54, planning: 14, agent: 40 },
        sharePercent: 5.4,
        state: 'normal',
      }),
      row('input_tpm', { limit: { status: 'set', value: 200000 }, state: 'usage_not_reported' }),
      row('output_tpm', { limit: { status: 'set', value: 40000 }, state: 'usage_not_reported' }),
      row('tpm', {}),
      row('tpd', {}),
    ],
    rateLimited429: { planning: { minute: 2, day: 3 }, agent: { minute: 1, day: 7 } },
  };
}

/** Qwen: rpm over the share, tpm with an unknown limit, the rest N/A. */
export function qwenEntry(): PlatformCapacityEntryDTO {
  return {
    provider: 'qwen',
    model: 'qwen-example-1',
    tierNote: '',
    unknownNote: 'rpm: not published for this tier',
    planningSharePercent: 40,
    limits: [
      row('max_concurrency', {}),
      row('rpm', {
        limit: { status: 'set', value: 600 },
        usage: { total: 510, planning: 200, agent: 310 },
        sharePercent: 85,
        state: 'over_share',
      }),
      row('input_tpm', {}),
      row('output_tpm', {}),
      row('tpm', {
        limit: { status: 'unknown' },
        usage: { total: 22, planning: 9, agent: 13 },
        state: 'unknown_limit',
      }),
      row('tpd', {}),
    ],
    rateLimited429: { planning: null, agent: { minute: 4, day: 31 } },
  };
}

/** DeepSeek: a concurrency limit stored as 0 with usage above it. */
export function deepseekEntry(): PlatformCapacityEntryDTO {
  return {
    provider: 'deepseek',
    model: 'deepseek-example-1',
    tierNote: 'Pay as you go',
    unknownNote: '',
    planningSharePercent: 30,
    limits: [
      row('max_concurrency', {
        limit: { status: 'set', value: 0 },
        usage: { total: 12, planning: 4, agent: 8 },
        state: 'over_share',
      }),
      row('rpm', {}),
      row('input_tpm', {}),
      row('output_tpm', {}),
      row('tpm', {}),
      row('tpd', {}),
    ],
    rateLimited429: { planning: { minute: 1, day: 1 }, agent: { minute: 1, day: 1 } },
  };
}

export function liveView(
  overrides: Partial<PlatformCapacityViewDTO> = {},
): PlatformCapacityViewDTO {
  return {
    alertShare: { percent: 80, isDefault: true },
    canEdit: true,
    raised: [],
    capacity: {
      outcome: 'answered',
      readAt: READ_AT,
      counterStore: { state: 'live', scope: 'shared' },
      entries: [claudeEntry(), qwenEntry(), deepseekEntry()],
    },
    ...overrides,
  };
}

/** The counter store down: every lane null, every judged row Unavailable. */
export function storeDownView(): PlatformCapacityViewDTO {
  const down = (entry: PlatformCapacityEntryDTO): PlatformCapacityEntryDTO => ({
    ...entry,
    limits: entry.limits.map((r) =>
      r.limit.status === 'not_applicable'
        ? r
        : { ...r, usage: null, sharePercent: null, state: 'unavailable' },
    ),
    rateLimited429: { planning: null, agent: null },
  });
  return liveView({
    capacity: {
      outcome: 'answered',
      readAt: READ_AT,
      counterStore: { state: 'unavailable', scope: 'shared' },
      entries: [down(claudeEntry()), down(qwenEntry())],
    },
  });
}
