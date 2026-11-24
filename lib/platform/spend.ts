/**
 * The console's SPEND vocabulary (Story MOTIR-727 · MOTIR-732) — shared by Usage &
 * cost, Tenants and the org page's Usage tab, so the nine categories, their units,
 * the period grammar and the two totals mean one thing on every screen.
 *
 * Pure: no I/O, no React. The figures come from motir-ai's platform rollup
 * (`GET /v1/platform/usage*`); this module only shapes them.
 */

/**
 * The nine spending categories, in the order every sheet lists them (design notes).
 * `hosting_production` — one production application's hosting for one UTC day,
 * debited by motir-ai under the `hosting_production` ledger kind (MOTIR-12165 ·
 * Decision MOTIR-12100 §4) — joined the rollup with MOTIR-12167.
 */
export const SPEND_CATEGORIES = [
  'planning_tokens',
  'agent_tokens',
  'agent_machine',
  'agent_instance',
  'agent_storage',
  'ci',
  'search',
  'hosting_production',
  'indexing',
] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

/** Motir never charges for code indexing: it carries usage and cost, never credits. */
export const NOT_CHARGED: ReadonlySet<SpendCategory> = new Set(['indexing']);

/** The categories Motir charges credits for — every column a spend list draws. */
export const CHARGED_CATEGORIES = SPEND_CATEGORIES.filter(
  (c): c is Exclude<SpendCategory, 'indexing'> => !NOT_CHARGED.has(c),
);
export type ChargedCategory = (typeof CHARGED_CATEGORIES)[number];

/**
 * What a category's usage is counted in. `none` — the rollup carries no usage
 * quantity for it, only credits and cost: production hosting arrives as one
 * day's whole credits, already priced by motir-core's meter.
 */
export type SpendUnit = 'tokens' | 'seconds' | 'gbSeconds' | 'searches' | 'none';
export const SPEND_UNIT: Record<SpendCategory, SpendUnit> = {
  planning_tokens: 'tokens',
  agent_tokens: 'tokens',
  agent_machine: 'seconds',
  agent_instance: 'seconds',
  agent_storage: 'gbSeconds',
  ci: 'seconds',
  search: 'searches',
  hosting_production: 'none',
  indexing: 'seconds',
};

/** A spend LIST row's per-category figures, as `/v1/platform/usage/orgs|children` serve them. */
export interface SpendRowFigures {
  credits: Record<ChargedCategory, number>;
  cost: Record<SpendCategory, number>;
}

/**
 * Every category present on a spend-list row, a missing one as 0. A motir-ai
 * release older than a category omits its key, and the console must still draw
 * the column (as a zero) rather than an empty cell or `NaN` — so motir-core can
 * ship a new category before motir-ai writes it.
 */
export function withEverySpendCategory<T extends SpendRowFigures>(row: T): T {
  const credits = Object.fromEntries(
    CHARGED_CATEGORIES.map((c) => [c, row.credits?.[c] ?? 0]),
  ) as T['credits'];
  const cost = Object.fromEntries(
    SPEND_CATEGORIES.map((c) => [c, row.cost?.[c] ?? 0]),
  ) as T['cost'];
  return { ...row, credits, cost };
}

/** One month's per-category figures, as `/v1/platform/usage/months` serves them. */
export interface MonthCategoryFigures {
  categories: Record<
    SpendCategory,
    { credits: number; usageQuantity: number; costMicroUsd: number }
  >;
}

/** Every category present on a month, a missing one as zeros — the same reason as above. */
export function withEveryMonthCategory<T extends MonthCategoryFigures>(month: T): T {
  const categories = Object.fromEntries(
    SPEND_CATEGORIES.map((c) => [
      c,
      month.categories?.[c] ?? { credits: 0, usageQuantity: 0, costMicroUsd: 0 },
    ]),
  ) as T['categories'];
  return { ...month, categories };
}

/** A period: one UTC month (`YYYY-MM`) or `all`. */
export type SpendPeriod = string;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The current UTC month, `YYYY-MM`. */
export function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** A URL's `period`, or the current month when it is absent or not one the read takes. */
export function parseSpendPeriod(
  raw: string | undefined | null,
  now: Date = new Date(),
): SpendPeriod {
  if (raw === 'all') return 'all';
  if (raw && MONTH.test(raw) && raw <= currentMonth(now)) return raw;
  return currentMonth(now);
}

/** The months the period picker offers: this month and the `count - 1` before it. */
export function recentMonths(now: Date = new Date(), count = 24): string[] {
  const months: string[] = [];
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  for (let i = 0; i < count; i += 1) {
    months.push(new Date(Date.UTC(y, m - i, 1)).toISOString().slice(0, 7));
  }
  return months;
}

/** One category's figures, as the rollup serves them. */
export interface CategoryFigures {
  category: SpendCategory;
  usageQuantity: number;
  inputTokens: number;
  outputTokens: number;
  cacheMissTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  credits: number;
  costMicroUsd: number;
}

export interface SpendSheetRow {
  category: SpendCategory;
  unit: SpendUnit;
  /** In the category's unit — tokens are input + output. */
  usage: number;
  /** Credits charged; NULL for a category Motir does not charge (indexing). */
  credits: number | null;
  costMicroUsd: number;
}

export interface SpendSheet {
  rows: SpendSheetRow[];
  /** Σ credits over the CHARGED categories — indexing is never in it. */
  chargedCredits: number;
  /** What the charged categories cost Motir. */
  chargedCostMicroUsd: number;
  /** Motir's whole cost, indexing INCLUDED. */
  costMicroUsdInclIndexing: number;
}

/**
 * The category sheet every spend view draws: all nine rows in order (a category
 * the read omitted is a row of zeros, never a missing row), and the two totals —
 * charged credits WITHOUT indexing, Motir's cost WITH it.
 */
export function buildSpendSheet(categories: readonly CategoryFigures[]): SpendSheet {
  const byCategory = new Map(categories.map((c) => [c.category, c]));
  const rows = SPEND_CATEGORIES.map((category): SpendSheetRow => {
    const c = byCategory.get(category);
    const unit = SPEND_UNIT[category];
    const usage = !c ? 0 : unit === 'tokens' ? c.inputTokens + c.outputTokens : c.usageQuantity;
    return {
      category,
      unit,
      usage,
      credits: NOT_CHARGED.has(category) ? null : (c?.credits ?? 0),
      costMicroUsd: c?.costMicroUsd ?? 0,
    };
  });
  let chargedCredits = 0;
  let chargedCostMicroUsd = 0;
  let costMicroUsdInclIndexing = 0;
  for (const row of rows) {
    costMicroUsdInclIndexing += row.costMicroUsd;
    if (row.credits === null) continue;
    chargedCredits += row.credits;
    chargedCostMicroUsd += row.costMicroUsd;
  }
  return { rows, chargedCredits, chargedCostMicroUsd, costMicroUsdInclIndexing };
}

/** Micro-dollars as dollars, for `Intl` currency formatting. */
export function microUsdToUsd(micro: number): number {
  return micro / 1_000_000;
}
