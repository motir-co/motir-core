import type { createFormatter } from 'next-intl';
import type { SpendUnit } from '@/lib/platform/spend';

/**
 * How a spend figure reads on the console (MOTIR-732) — one place, so a category's
 * unit and Motir's cost look the same on every screen. Takes `next-intl`'s
 * formatter so the numbers follow the viewer's locale.
 */
type NumberFormatter = Pick<ReturnType<typeof createFormatter>, 'number'>;

/** Micro-dollars as money: cents for whole amounts, more places below a cent. */
export function formatMicroUsd(format: NumberFormatter, micro: number): string {
  const usd = micro / 1_000_000;
  const small = usd !== 0 && Math.abs(usd) < 0.01;
  return format.number(usd, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  });
}

/** No usage quantity to show — the category carries credits and cost only. */
export const NO_USAGE = '—';

/** A usage figure in its category's unit: tokens, minutes, GB-days or searches. */
export function formatUsage(
  format: NumberFormatter,
  unit: SpendUnit,
  value: number,
  units: { tokens: string; minutes: string; gbDays: string; searches: string },
): string {
  if (unit === 'none') return NO_USAGE;
  if (unit === 'seconds') {
    return `${format.number(value / 60, { maximumFractionDigits: 0 })} ${units.minutes}`;
  }
  if (unit === 'gbSeconds') {
    return `${format.number(value / 86_400, { maximumFractionDigits: 1 })} ${units.gbDays}`;
  }
  const compact = format.number(value, { notation: 'compact', maximumFractionDigits: 1 });
  return `${compact} ${unit === 'tokens' ? units.tokens : units.searches}`;
}
