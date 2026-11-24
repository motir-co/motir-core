import type { ProductionUsageUnit } from '@/generated/prisma/client';
import { LINUX_MINUTE_USD } from '@/lib/ciMetering/previewRates';

// What a production application's usage costs in credits, and what it cost Motir
// (Story MOTIR-9799 · MOTIR-12108). Every figure is Decision MOTIR-12100's
// ("production hosting is charged in credits under hosting_production", page
// cmwti126l01y501adfia731c0, version 1, approved 2026-11-23), §2, read from the
// providers' list prices on 2026-11-23.
//
// ⚠️ A FACTOR IS DERIVED, NEVER TYPED (§1). Each unit states its list price in
// USD; its Linux-equivalent minutes per unit are that price divided by
// `LINUX_MINUTE_USD` ($0.006, GitHub's Linux 2-core minute), and one such
// minute is one credit. Motir's own cost per unit is the same list price (§3),
// recorded on every slice and never shown.
//
// The decision page is the authority: a price change there is a change of the
// `usdPerUnit` below, and the factor follows.

/** A month in seconds, the convention Fly and AWS state monthly prices in (§2). */
export const MONTH_SECONDS = 730 * 3600;

/** Hours in a month, for the per-GB-month storage prices. */
const MONTH_HOURS = 730;

export interface ProductionUsageRate {
  /** The unit, as the decision names it. */
  readonly unit: string;
  /** Motir's list-price cost per unit, in USD. */
  readonly usdPerUnit: number;
  /** The decision's own words for the price, for the tests and the reader. */
  readonly source: string;
}

export const PRODUCTION_USAGE_RATES: Readonly<Record<ProductionUsageUnit, ProductionUsageRate>> = {
  fly_small_seconds: {
    unit: 'Fly running second, shared-cpu-1x 1 GB',
    usdPerUnit: 6.7 / MONTH_SECONDS,
    source: 'Fly shared-cpu-1x 1 GB $6.70/month (iad)',
  },
  fly_medium_seconds: {
    unit: 'Fly running second, shared-cpu-2x 2 GB',
    usdPerUnit: 13.39 / MONTH_SECONDS,
    source: 'Fly shared-cpu-2x 2 GB $13.39/month (iad)',
  },
  // Not printed on Fly's page: twice the 2x 2 GB figure, as Fly's shared presets
  // scale linearly (§2 note).
  fly_large_seconds: {
    unit: 'Fly running second, shared-cpu-4x 4 GB',
    usdPerUnit: 26.78 / MONTH_SECONDS,
    source: 'Fly shared-cpu-4x 4 GB $26.78/month (twice 2x 2 GB, iad)',
  },
  lambda_gb_seconds: {
    unit: 'Lambda GB-second, x86',
    usdPerUnit: 0.0000166667,
    source: 'AWS Lambda x86 $0.0000166667/GB-s (us-east-1)',
  },
  lambda_requests: {
    unit: 'Lambda request',
    usdPerUnit: 0.2 / 1_000_000,
    source: 'AWS Lambda $0.20/1M requests (us-east-1)',
  },
  fargate_vcpu_seconds: {
    unit: 'Fargate vCPU-second, Linux x86',
    usdPerUnit: 0.000011244,
    source: 'AWS Fargate $0.04048/vCPU-hour (us-east-1)',
  },
  fargate_gb_seconds: {
    unit: 'Fargate GB-second, Linux x86',
    usdPerUnit: 0.000001235,
    source: 'AWS Fargate $0.004446/GB-hour (us-east-1)',
  },
  neon_compute_hours: {
    unit: 'Neon compute-unit hour',
    usdPerUnit: 0.106,
    source: 'Neon Launch $0.106/CU-hour',
  },
  neon_storage_gb_hours: {
    unit: 'Neon storage GB-hour',
    usdPerUnit: 0.35 / MONTH_HOURS,
    source: 'Neon $0.35/GB-month',
  },
  aurora_compute_hours: {
    unit: 'Aurora Serverless v2 ACU-hour',
    usdPerUnit: 0.12,
    source: 'Aurora Standard $0.12/ACU-hour (us-east-1)',
  },
  aurora_storage_gb_hours: {
    unit: 'Aurora storage GB-hour',
    usdPerUnit: 0.1 / MONTH_HOURS,
    source: 'Aurora Standard $0.10/GB-month (us-east-1)',
  },
};

/** Linux-equivalent minutes (credits) per unit: list price ÷ $0.006 (§1). */
export function linuxMinutesPerUnit(unit: ProductionUsageUnit): number {
  return PRODUCTION_USAGE_RATES[unit].usdPerUnit / LINUX_MINUTE_USD;
}

/** A slice's credits (fractional Linux-equivalent minutes) and Motir's cost. */
export function priceProductionSlice(
  unit: ProductionUsageUnit,
  quantity: number,
): { credits: number; motirCostUsd: number } {
  return {
    credits: quantity * linuxMinutesPerUnit(unit),
    motirCostUsd: quantity * PRODUCTION_USAGE_RATES[unit].usdPerUnit,
  };
}

/** The whole credits a UTC day's slices are charged as: their sum, rounded up
 *  once (§6). A day with nothing to charge is 0. */
export function dailyChargeCredits(sliceCredits: readonly number[]): number {
  const total = sliceCredits.reduce((sum, c) => sum + c, 0);
  // A float sum of an exact integer can land a hair above it; never round a
  // residue of the arithmetic up into a whole credit.
  return total <= 1e-9 ? 0 : Math.ceil(total - 1e-9);
}
