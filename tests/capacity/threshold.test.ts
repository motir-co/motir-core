import { describe, expect, it } from 'vitest';
import { evaluateCapacityRead, judgeSetLimit } from '@/lib/capacity/threshold';
import { UNKNOWN, answered, concurrency, entry, lane, set } from '../fixtures/capacityReadFixtures';

// THE THRESHOLD FUNCTION (Story MOTIR-9539 · MOTIR-9611): pure, table-driven
// over every state.

function rowOf(read: ReturnType<typeof answered>, share: number, unit = 'max_concurrency') {
  return evaluateCapacityRead(read, share).entries[0]!.limits.find((l) => l.unit === unit)!;
}

describe('a set limit of 100 at share 80', () => {
  it.each([
    [69, 'normal'],
    [70, 'near_limit'],
    [79, 'near_limit'],
    [80, 'over_share'],
    [120, 'over_share'],
  ])('usage %i reads %s', (used, state) => {
    const row = rowOf(answered([concurrency(used)]), 80);
    expect(row.state).toBe(state);
    expect(row.sharePercent).toBe(used);
  });

  it('sums planning and agent, and returns both beside the total', () => {
    const row = rowOf(answered([concurrency(80)]), 80);
    expect(row.usage).toEqual({ total: 80, planning: 20, agent: 60 });
  });
});

describe('the share and the band move together', () => {
  it('at share 90, 80 is near and 90 is over', () => {
    expect(rowOf(answered([concurrency(80)]), 90).state).toBe('near_limit');
    expect(rowOf(answered([concurrency(90)]), 90).state).toBe('over_share');
  });

  it('at share 5 the near band starts at 0, not below it', () => {
    expect(judgeSetLimit(0, 100, 5)).toBe('near_limit');
    expect(judgeSetLimit(5, 100, 5)).toBe('over_share');
  });

  it('compares by cross-multiplication: 79.6 % is not over at 80 %', () => {
    expect(judgeSetLimit(796, 1000, 80)).toBe('near_limit');
    expect(judgeSetLimit(800, 1000, 80)).toBe('over_share');
  });
});

describe('the states with no number to judge', () => {
  const read = answered([
    entry(
      'claude',
      'claude-example-1',
      { rpm: UNKNOWN, input_tpm: set(200_000), output_tpm: UNKNOWN },
      {
        planning: lane({ requestsPerMinute: 14, tokensPerMinute: 51_000 }),
        agent: lane({ requestsPerMinute: 40 }),
      },
    ),
  ]);
  const rows = evaluateCapacityRead(read, 80).entries[0]!.limits;
  const byUnit = Object.fromEntries(rows.map((r) => [r.unit, r]));

  it('not applicable reads not_applicable', () => {
    expect(byUnit['tpd']).toMatchObject({
      state: 'not_applicable',
      usage: null,
      sharePercent: null,
    });
  });

  it('an unknown limit reads unknown_limit with usage and no share', () => {
    expect(byUnit['rpm']).toMatchObject({
      state: 'unknown_limit',
      usage: { total: 54, planning: 14, agent: 40 },
      sharePercent: null,
    });
  });

  it('input and output tokens read usage_not_reported, set or unknown', () => {
    expect(byUnit['input_tpm']).toMatchObject({ state: 'usage_not_reported', usage: null });
    expect(byUnit['output_tpm']).toMatchObject({ state: 'usage_not_reported', usage: null });
  });

  it('no such row carries a 0 the read did not contain', () => {
    for (const row of rows) {
      expect(row.sharePercent).not.toBe(0);
      if (row.state !== 'unknown_limit') expect(row.usage).toBeNull();
      if (row.limit.status !== 'set') expect(row.limit).not.toHaveProperty('value');
    }
  });

  it('units come in contract order', () => {
    expect(rows.map((r) => r.unit)).toEqual([
      'max_concurrency',
      'rpm',
      'input_tpm',
      'output_tpm',
      'tpm',
      'tpd',
    ]);
  });
});

describe('a limit of 0', () => {
  it('is over with no share when used, and normal when not — no division', () => {
    const used = rowOf(answered([concurrency(3, 0)]), 80);
    expect(used).toMatchObject({ state: 'over_share', sharePercent: null });
    const idle = rowOf(answered([concurrency(0, 0)]), 80);
    expect(idle).toMatchObject({ state: 'normal', sharePercent: null });
  });
});

describe('unavailable', () => {
  it('the counter store down makes every row unavailable with no usage', () => {
    const read = answered([concurrency(50), entry('qwen', 'qwen-example-1', { rpm: set(600) })], {
      store: 'unavailable',
    });
    for (const e of evaluateCapacityRead(read, 80).entries) {
      for (const row of e.limits) expect(row).toMatchObject({ state: 'unavailable', usage: null });
    }
  });

  it.each([
    ['both lanes null', { planning: null, agent: null }],
    ['one lane null', { planning: lane({ requestsPerMinute: 10 }), agent: null }],
  ])('%s: only that entry is unavailable', (_label, lanes) => {
    const slow = entry('qwen', 'qwen-example-1', { rpm: set(600) }, lanes);
    const evaluation = evaluateCapacityRead(answered([slow, concurrency(85)]), 80);
    expect(evaluation.entries[0]!.limits.find((l) => l.unit === 'rpm')).toMatchObject({
      state: 'unavailable',
      usage: null,
    });
    expect(evaluation.entries[1]!.limits[0]).toMatchObject({ state: 'over_share' });
  });
});

describe('the evaluation carries no identifier', () => {
  it('has only provider, model and limit figures', () => {
    const evaluation = evaluateCapacityRead(answered([concurrency(50)]), 80);
    expect(Object.keys(evaluation).sort()).toEqual([
      'alertSharePercent',
      'counterStore',
      'entries',
      'readAt',
    ]);
    expect(Object.keys(evaluation.entries[0]!).sort()).toEqual(['limits', 'model', 'provider']);
  });
});
