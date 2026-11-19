import type { AwsCostKind } from '@/lib/awsCost/costLines';

/**
 * THE CONSOLE'S COSTS PAGE (MOTIR-11712, design MOTIR-11711) — what
 * `platformReadService.getCosts` answers and `/admin/costs` draws. Money is whole
 * micro-USD. A `null` figure is NO figure — never draw it as zero.
 */

/** Which rows the page draws: one month by day, one year by month, or every year. */
export type CostsView =
  | { kind: 'day'; /** `YYYY-MM` */ month: string }
  | { kind: 'month'; /** `YYYY` */ year: string }
  | { kind: 'year' };

/** One line of a row's AWS drill-down. `service` is empty on a tax, credit or refund line. */
export interface CostsAwsLineDTO {
  kind: AwsCostKind;
  service: string;
  amountMicroUsd: number;
  /** The line ÷ the row's AWS figure; null when that figure is 0. */
  share: number | null;
}

/** One line of a row's Models drill-down: a serving provider's id. */
export interface CostsModelLineDTO {
  provider: string;
  amountMicroUsd: number;
  /** The line ÷ the row's Models figure; null when that figure is 0. */
  share: number | null;
}

export interface CostsRowDTO {
  /** `YYYY-MM-DD`, `YYYY-MM` or `YYYY`, by the view. */
  period: string;
  /** The period is not over: today, this month, this year. */
  partial: boolean;
  /** AWS will still revise this row's AWS figure: the current day, month or year. */
  estimate: boolean;
  /** Null when AWS is unavailable or holds no read of the period. */
  awsMicroUsd: number | null;
  /** Null when the model read failed or nothing was recorded in the period. */
  modelsMicroUsd: number | null;
  /** AWS + Models, only when both figures exist. */
  totalMicroUsd: number | null;
  awsLines: CostsAwsLineDTO[];
  modelLines: CostsModelLineDTO[];
}

export interface CostsPageDTO {
  view: CostsView;
  /** The current UTC day. */
  today: string;
  awsAvailable: boolean;
  modelsAvailable: boolean;
  /** The latest AWS read, ISO 8601; null while AWS is unavailable. */
  awsFetchedAt: string | null;
  /** Oldest first. */
  rows: CostsRowDTO[];
  totals: {
    awsMicroUsd: number | null;
    modelsMicroUsd: number | null;
    totalMicroUsd: number | null;
    /** Some row of the range is not over. */
    partial: boolean;
  };
  /** Both sources answered and no row holds any cost. */
  empty: boolean;
  /** The range picker's choices, newest first: months on Day, years on Month, none on Year. */
  options: string[];
}
