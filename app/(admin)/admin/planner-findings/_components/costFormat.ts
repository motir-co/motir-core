/**
 * A usage line's cost, in US dollars, for the request's formatter. motir-ai
 * prices in micro-dollars; a `null` is an UNPRICED line and answers no value, so
 * it can never be shown as a zero.
 */
export interface NumberFormatter {
  number(value: number, options?: Intl.NumberFormatOptions): string;
}

export function formatCostMicroUsd(
  costMicroUsd: number | null,
  format: NumberFormatter,
): string | null {
  if (costMicroUsd === null) return null;
  return format.number(costMicroUsd / 1_000_000, {
    style: 'currency',
    currency: 'USD',
    // Sub-cent runs are common; show them rather than rounding to $0.00.
    maximumFractionDigits: costMicroUsd < 10_000 ? 4 : 2,
  });
}
