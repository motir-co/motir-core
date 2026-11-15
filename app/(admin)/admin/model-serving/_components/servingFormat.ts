import type {
  ModelServingEntryDTO,
  ModelServingOfferingDTO,
  ModelServingPriceDTO,
} from '@/lib/dto/platformModelServing';

// The Model serving screen's arithmetic (MOTIR-11280; design
// `platform-admin/design-notes.md` § Model serving). Pure, so the server table
// and the client dialog draw the same numbers.

/** `$1.40`, `$3.851`: at least two decimals, at most three — what the price rows hold. */
export function usd(value: number | null, locale: string): string {
  if (value === null) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(value);
}

/** A `YYYY-MM-DD` read date, or an ISO time, as `15 Nov 2026` in the reader's locale. */
export function shortDate(value: string, locale: string): string {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export type PriceDiff =
  | { kind: 'same' }
  | {
      kind: 'below' | 'above' | 'inputBelowOutputAbove' | 'inputAboveOutputBelow';
      input: number;
      output: number;
    }
  | { kind: 'unknown' };

function pct(cost: number, charged: number): number {
  return Math.round((Math.abs(cost - charged) / charged) * 100);
}

/**
 * How a provider's cost compares with the charged (official) price, input and
 * output each as a whole percent: `round(|cost − charged| / charged × 100)`.
 */
export function priceDiff(
  cost: ModelServingPriceDTO | null,
  charged: ModelServingPriceDTO,
): PriceDiff {
  if (
    !cost ||
    cost.output === null ||
    charged.output === null ||
    charged.input <= 0 ||
    charged.output <= 0
  ) {
    return { kind: 'unknown' };
  }
  const input = pct(cost.input, charged.input);
  const output = pct(cost.output, charged.output);
  if (input === 0 && output === 0) return { kind: 'same' };
  const inBelow = cost.input <= charged.input;
  const outBelow = cost.output <= charged.output;
  const inAbove = cost.input >= charged.input;
  const outAbove = cost.output >= charged.output;
  if (inBelow && outBelow) return { kind: 'below', input, output };
  if (inAbove && outAbove) return { kind: 'above', input, output };
  return { kind: inBelow ? 'inputBelowOutputAbove' : 'inputAboveOutputBelow', input, output };
}

/** The channel a provider serves the model on: its first enabled one, else its first. */
export function channelOf(
  entry: ModelServingEntryDTO,
  provider: string,
): ModelServingOfferingDTO | null {
  const own = entry.offerings.filter((o) => o.provider === provider);
  return own.find((o) => o.enabled) ?? own[0] ?? null;
}

/** The row's serving facts: whom an admin (or the default) asked for, and who serves now. */
export function servingOf(entry: ModelServingEntryDTO) {
  const wanted = entry.selected ?? entry.originProvider;
  const wantedChannel = channelOf(entry, wanted);
  const serving = entry.effective ? channelOf(entry, entry.effective) : null;
  return {
    wanted,
    wantedChannel,
    serving,
    fallingBack: entry.effective !== null && entry.effective !== wanted,
  };
}
