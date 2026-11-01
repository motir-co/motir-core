import type { PreviewUsageKind } from '@/generated/prisma/client';

// What a preview's usage counts for in the CI-minutes pool, and what it cost
// Motir (Story MOTIR-5766 · MOTIR-5777). The figures are MOTIR-5769 §9's
// ("Preview cost through the CI allowance"), read 2026-10-28, against GitHub's
// Linux 2-core rate of $0.006 a minute — the same minute the pool counts
// (`docs/decisions/ci-minutes-allowance.md` §1, amendment 2026-10-29). A factor
// is per UNIT of its kind, so a slice's minutes are `quantity × factor`.
//
// The decision page is the authority. A price change there is a change here AND
// a new dated line in the allowance ADR's amendment, never one without the other.

/** GitHub's Linux 2-core list price the factors are stated against. */
export const LINUX_MINUTE_USD = 0.006;

export interface PreviewUsageRate {
  /** The kind's unit, as the decision page names it. */
  readonly unit: string;
  /** Linux-equivalent minutes per unit. */
  readonly linuxMinutesPerUnit: number;
  /** Motir's list-price cost per unit, in USD. */
  readonly usdPerUnit: number;
  /** The decision page's own words for the price, for the ADR and the tests. */
  readonly source: string;
}

export const PREVIEW_USAGE_RATES: Readonly<Record<PreviewUsageKind, PreviewUsageRate>> = {
  // Fly shared-cpu-1x 512 MB, $3.69 a month ≈ $0.0000014 a second →
  // 0.0140 Linux-minutes per running minute.
  machine_seconds: {
    unit: 'running second',
    linuxMinutesPerUnit: 0.014 / 60,
    usdPerUnit: 0.0000014,
    source: 'Fly shared-cpu-1x 512 MB $3.69/month',
  },
  // Lambda x86 $0.0000166667 per GB-second → 0.167 Linux-minutes per GB-minute.
  lambda_gb_seconds: {
    unit: 'GB-second',
    linuxMinutesPerUnit: 0.167 / 60,
    usdPerUnit: 0.0000166667,
    source: 'AWS Lambda x86 $0.0000166667/GB-s',
  },
  // Lambda $0.20 per million requests → 33.3 Linux-minutes per million.
  lambda_requests: {
    unit: 'request',
    linuxMinutesPerUnit: 33.3 / 1_000_000,
    usdPerUnit: 0.2 / 1_000_000,
    source: 'AWS Lambda $0.20/1M requests',
  },
  // Neon Launch $0.106 per compute-unit hour → 17.7 Linux-minutes per CU-hour.
  neon_compute_hours: {
    unit: 'compute-unit hour',
    linuxMinutesPerUnit: 17.7,
    usdPerUnit: 0.106,
    source: 'Neon Launch $0.106/CU-hour',
  },
};

/** A slice's pool minutes and Motir cost. */
export function priceSlice(
  kind: PreviewUsageKind,
  quantity: number,
): { linuxEquivalentMinutes: number; motirCostUsd: number } {
  const rate = PREVIEW_USAGE_RATES[kind];
  return {
    linuxEquivalentMinutes: quantity * rate.linuxMinutesPerUnit,
    motirCostUsd: quantity * rate.usdPerUnit,
  };
}
