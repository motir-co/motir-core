import record from './calculatorPinnedVector.json';

interface RecordedEstimate {
  version: number;
  kind: 'estimate';
  profilesVersion: string;
  categoryRuleVersion: string;
  cadence: 'annual' | 'monthly';
  plannedPerMonth: { low: number; high: number };
  runPerMonth: { low: number; high: number };
  credits: { low: number; high: number };
  perItemCredits: { planning: number; running: number };
  split: { count: number; categories: { key: string; weight: number; models: string[] }[] };
  recommendation: {
    planKey: string | null;
    planName: string | null;
    monthlyPriceUsd: number;
    poolCredits: number;
  };
  topUp: {
    low: { units: number; credits: number; priceUsd: number };
    high: { units: number; credits: number; priceUsd: number };
  };
  ceiling: {
    credits: number | null;
    exceeded: boolean;
    excessCredits: number;
    outcome: 'within_ladder' | 'larger_pool' | 'top_ups_only';
  };
}
interface RecordedCategories {
  version: number;
  categoryRuleVersion: string;
  modelsReadAt: string;
  cadences: ('annual' | 'monthly')[];
  defaultCadence: 'annual' | 'monthly';
  categories: { key: string; models: { id: string; provider: string }[] }[];
}

interface PinnedRequest {
  plannedPerMonth: { low: number; high: number };
  runPerMonth: { low: number; high: number };
  categories: readonly string[];
  shares: Readonly<Record<string, number>>;
  cadence: 'annual' | 'monthly';
}

// THE PINNED CROSS-SURFACE ESTIMATE VECTOR (Story MOTIR-8381 · MOTIR-8642 · MOTIR-10156).
//
// One calculator request — the shared input the Billing & plans Calculator tab
// and motir.co/price are both compared on — and the engine's OWN answer to it,
// recorded verbatim from the shipped public endpoint, with the basis it was
// recorded on. It is a DATED OBSERVATION of one data state (the live model rates,
// the Stripe-priced plan list, the top-up bundle), not something any git ref
// reproduces: when the engine's answer moves, the record is RE-RECORDED, never
// edited by hand. `calculatorPinnedVector.test.ts` keeps it honest against that.
//
// THE RECORD IS `calculatorPinnedVector.json`, written by
// `scripts/record-calculator-pinned-vector.mjs`; this module only types it. It is a
// JSON file so motir-marketing can carry a BYTE-IDENTICAL copy
// (`tests/fixtures/calculator/pinned-vector.json` there, checked against this file
// by its live seam lane): the billing tab's test here and the /price parity test
// there assert the same request and the same answer.
//
// Recorded in the engine's CURRENT request shape (MOTIR-9224 · MOTIR-9832): two
// ranges, items PLANNED and items RUN a month — deliberately different, so a surface
// that copies one into the other is caught — and two categories with UNEQUAL shares
// of the run, so a surface that splits evenly is caught. The answer echoes both
// ranges and carries the weighted `split`, the recommended plan's own pool and the
// `ceiling.outcome`; the input lands inside the ladder (`within_ladder`) with a
// top-up at the high end, so every figure a surface renders has one to compare.
//
// Not a spec file (no `.test.`), so a suite imports it rather than running it.
// Consumed by the Calculator's rendering check (MOTIR-8643).
//
// Re-record (then copy the JSON over motir-marketing's, unchanged):
//   node scripts/record-calculator-pinned-vector.mjs

/** The shared input: two ranges, two categories with their shares, one cadence. */
export const PINNED_CALCULATOR_REQUEST = record.request as PinnedRequest;

/** The engine's response body to that request, byte for byte as it answered. */
export const PINNED_ESTIMATE_RAW_BODY: string = record.estimateRawBody;

/** The same answer as a value — must deep-equal `JSON.parse(PINNED_ESTIMATE_RAW_BODY)`. */
export const PINNED_ESTIMATE_ANSWER = JSON.parse(PINNED_ESTIMATE_RAW_BODY) as RecordedEstimate;

/** The categories answer read just before, so the selections can be shown to have been live. */
export const PINNED_CATEGORIES_RAW_BODY: string = record.categoriesRawBody;

export const PINNED_CATEGORIES_ANSWER = JSON.parse(
  PINNED_CATEGORIES_RAW_BODY,
) as RecordedCategories;

/** Where, when and on which engine versions the answer was taken, and the commands that took it. */
export const PINNED_VECTOR_BASIS = record.basis as {
  endpoint: string;
  categoriesEndpoint: string;
  host: string;
  /** UTC, when the estimate request was sent. */
  recordedAt: string;
  /** UTC, when the categories request was sent. */
  categoriesRecordedAt: string;
  engineVersion: number;
  profilesVersion: string;
  categoryRuleVersion: string;
  commands: string[];
};
