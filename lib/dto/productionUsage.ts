import type { ProductionUsageUnit } from '@/generated/prisma/client';

// A production application's USAGE THIS PERIOD (Story MOTIR-9799 · MOTIR-12108;
// Decision MOTIR-12100), as the Production panel's Usage section reads it
// (MOTIR-12110). Quantities and credits only: Motir's own cost is recorded on
// every slice and never leaves the server — `motirCostRecorded` says that it
// was, never what it was.

export type ProductionUsageUnitDto = ProductionUsageUnit;

export type ProductionUsageState = 'ok' | 'no_release' | 'credits_exhausted';

export interface ProductionUsageLineDto {
  unit: ProductionUsageUnitDto;
  /** In the unit's own measure (seconds, GB-seconds, requests, hours, GB-hours). */
  quantity: number;
  /** Linux-equivalent minutes, to two decimals — one credit each. */
  credits: number;
}

export interface ProductionUsageExhaustedDto {
  /** When the organisation's balance went below zero, ISO-8601. */
  since: string;
  /** The balance now, or null when it could not be read. */
  balance: number | null;
  /** Whether the application's target can suspend when idle (an AWS container
   *  cannot, and keeps running always on in overdraft). */
  canSuspend: boolean;
  /** When an always-on application that can suspend is switched to suspend if
   *  the balance is still below zero (since + 7 days), ISO-8601; null otherwise. */
  suspendsAt: string | null;
  /** When the takeover grace window of an application in it ends, ISO-8601;
   *  null otherwise. Such an application is exempt from the out-of-credits
   *  actions (MOTIR-12143): it is never switched, so it has no `suspendsAt`,
   *  and keeps running as it is until then (MOTIR-12248). */
  graceStopsAt: string | null;
}

export interface ProductionUsageDto {
  /** The calendar month in UTC (`[start, end)`), ISO-8601. */
  period: { start: string; end: string };
  usage: ProductionUsageLineDto[];
  /** Whole credits CHARGED this period: each closed UTC day's credits rounded up
   *  once, as they are debited. Today's open day is in `usage`, not here yet. */
  credits: number;
  /** True when the period holds slices, each of which carries Motir's own cost. */
  motirCostRecorded: boolean;
  state: ProductionUsageState;
  /** Set exactly when `state` is `credits_exhausted`. */
  exhausted: ProductionUsageExhaustedDto | null;
}
