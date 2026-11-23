import { describe, expect, it } from 'vitest';
import {
  buildSpendSheet,
  CHARGED_CATEGORIES,
  parseSpendPeriod,
  recentMonths,
  SPEND_CATEGORIES,
  SPEND_UNIT,
  withEveryMonthCategory,
  withEverySpendCategory,
  type CategoryFigures,
  type MonthCategoryFigures,
  type SpendRowFigures,
} from '@/lib/platform/spend';
import { formatUsage, NO_USAGE } from '@/app/(admin)/admin/_components/spendFormat';

/** The console's spend vocabulary (Story MOTIR-727 · MOTIR-732). */

const NOW = new Date('2026-10-02T12:00:00Z');

function figures(
  category: CategoryFigures['category'],
  over: Partial<CategoryFigures> = {},
): CategoryFigures {
  return {
    category,
    usageQuantity: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheMissTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    credits: 0,
    costMicroUsd: 0,
    ...over,
  };
}

describe('parseSpendPeriod', () => {
  it('takes a past or current month and `all`; anything else is this month', () => {
    expect(parseSpendPeriod('all', NOW)).toBe('all');
    expect(parseSpendPeriod('2026-09', NOW)).toBe('2026-09');
    expect(parseSpendPeriod('2026-10', NOW)).toBe('2026-10');
    for (const bad of [undefined, null, '', '2026-13', '2026-9', 'sept', '2026-11']) {
      expect(parseSpendPeriod(bad, NOW)).toBe('2026-10');
    }
  });
});

describe('recentMonths', () => {
  it('lists this month first and walks back across a year boundary', () => {
    expect(recentMonths(NOW, 12)).toEqual([
      '2026-10',
      '2026-09',
      '2026-08',
      '2026-07',
      '2026-06',
      '2026-05',
      '2026-04',
      '2026-03',
      '2026-02',
      '2026-01',
      '2025-12',
      '2025-11',
    ]);
  });
});

describe('buildSpendSheet', () => {
  it('indexing is NOT CHARGED — out of the charged credits total, inside Motir’s cost total', () => {
    const sheet = buildSpendSheet([
      figures('planning_tokens', {
        inputTokens: 1000,
        outputTokens: 200,
        credits: 30,
        costMicroUsd: 13_050,
      }),
      figures('ci', { usageQuantity: 600, credits: 5, costMicroUsd: 19_000 }),
      // A stray credit on indexing must never reach the charged total.
      figures('indexing', { usageQuantity: 3600, credits: 7, costMicroUsd: 114_000 }),
    ]);
    const indexing = sheet.rows.find((r) => r.category === 'indexing')!;
    expect(indexing.credits).toBeNull();
    expect(indexing.costMicroUsd).toBe(114_000);
    expect(sheet.chargedCredits).toBe(35);
    expect(sheet.chargedCostMicroUsd).toBe(32_050);
    expect(sheet.costMicroUsdInclIndexing).toBe(146_050);
  });

  it('always draws all nine rows in order, zero-filling a category the read omitted', () => {
    const sheet = buildSpendSheet([
      figures('search', { usageQuantity: 3, credits: 3, costMicroUsd: 15_000 }),
    ]);
    expect(sheet.rows.map((r) => r.category)).toEqual([...SPEND_CATEGORIES]);
    expect(sheet.rows.find((r) => r.category === 'agent_storage')).toMatchObject({
      usage: 0,
      credits: 0,
      costMicroUsd: 0,
    });
  });

  it('a token category’s usage is input + output; every other is its usage quantity', () => {
    const sheet = buildSpendSheet([
      figures('agent_tokens', { inputTokens: 900, outputTokens: 100, usageQuantity: 0 }),
      figures('agent_storage', { usageQuantity: 864_000 }),
    ]);
    expect(sheet.rows.find((r) => r.category === 'agent_tokens')).toMatchObject({
      unit: 'tokens',
      usage: 1000,
    });
    expect(sheet.rows.find((r) => r.category === 'agent_storage')).toMatchObject({
      unit: 'gbSeconds',
      usage: 864_000,
    });
  });
});

// Production hosting (MOTIR-12167): motir-ai's `hosting_production` debits roll up
// under their own category, charged, organization-level and with no usage quantity.
describe('the production hosting category', () => {
  it('is a charged category, listed after search and before indexing', () => {
    expect([...SPEND_CATEGORIES]).toEqual([
      'planning_tokens',
      'agent_tokens',
      'agent_machine',
      'agent_instance',
      'agent_storage',
      'ci',
      'search',
      'hosting_production',
      'indexing',
    ]);
    expect([...CHARGED_CATEGORIES]).toEqual(SPEND_CATEGORIES.filter((c) => c !== 'indexing'));
    expect(SPEND_UNIT.hosting_production).toBe('none');
  });

  it('counts its credits into the charged total and its cost into both cost totals', () => {
    const sheet = buildSpendSheet([
      figures('agent_storage', { usageQuantity: 86_400, credits: 7, costMicroUsd: 1_000 }),
      figures('hosting_production', { credits: 40, costMicroUsd: 0 }),
    ]);
    expect(sheet.rows.find((r) => r.category === 'hosting_production')).toMatchObject({
      unit: 'none',
      usage: 0,
      credits: 40,
    });
    expect(sheet.chargedCredits).toBe(47);
  });

  it('reads as a dash in the usage column, never as zero of some unit', () => {
    const format = { number: (n: number) => String(n) } as Parameters<typeof formatUsage>[0];
    const units = { tokens: 'tokens', minutes: 'min', gbDays: 'GB-days', searches: 'searches' };
    expect(formatUsage(format, 'none', 0, units)).toBe(NO_USAGE);
    expect(formatUsage(format, 'none', 123, units)).toBe(NO_USAGE);
    expect(formatUsage(format, 'seconds', 120, units)).toBe('2 min');
  });
});

describe('withEverySpendCategory', () => {
  it('fills a category an older motir-ai omitted with zero and keeps every figure it sent', () => {
    const older = {
      entityId: 'org_a',
      chargedCredits: 9,
      credits: { planning_tokens: 4, search: 5 },
      cost: { planning_tokens: 100, indexing: 7 },
    } as unknown as SpendRowFigures & { entityId: string; chargedCredits: number };
    const row = withEverySpendCategory(older);
    expect(Object.keys(row.credits)).toEqual([...CHARGED_CATEGORIES]);
    expect(Object.keys(row.cost)).toEqual([...SPEND_CATEGORIES]);
    expect(row.credits.hosting_production).toBe(0);
    expect(row.credits.planning_tokens).toBe(4);
    expect(row.credits.search).toBe(5);
    expect(row.cost.hosting_production).toBe(0);
    expect(row.cost.indexing).toBe(7);
    expect(row.entityId).toBe('org_a');
    expect(row.chargedCredits).toBe(9);
  });

  it('passes a current row’s hosting figures through, and survives absent maps', () => {
    const current = withEverySpendCategory({
      credits: { hosting_production: 40 },
      cost: { hosting_production: 12 },
    } as unknown as SpendRowFigures);
    expect(current.credits.hosting_production).toBe(40);
    expect(current.cost.hosting_production).toBe(12);
    const bare = withEverySpendCategory({} as unknown as SpendRowFigures);
    expect(Object.values(bare.credits).every((v) => v === 0)).toBe(true);
    expect(Object.values(bare.cost).every((v) => v === 0)).toBe(true);
  });
});

describe('withEveryMonthCategory', () => {
  it('gives every category a figure, zeros for one the month omitted', () => {
    const month = withEveryMonthCategory({
      period: '2026-11',
      categories: { ci: { credits: 2, usageQuantity: 120, costMicroUsd: 5 } },
    } as unknown as MonthCategoryFigures & { period: string });
    expect(Object.keys(month.categories)).toEqual([...SPEND_CATEGORIES]);
    expect(month.categories.hosting_production).toEqual({
      credits: 0,
      usageQuantity: 0,
      costMicroUsd: 0,
    });
    expect(month.categories.ci.credits).toBe(2);
    expect(month.period).toBe('2026-11');
    const bare = withEveryMonthCategory({} as unknown as MonthCategoryFigures);
    expect(bare.categories.indexing.usageQuantity).toBe(0);
  });
});
