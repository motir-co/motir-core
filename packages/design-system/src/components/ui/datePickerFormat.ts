// Date-format injection for the package `DatePicker` — the PURE half.
//
// The picker formats the chosen date for its trigger with whatever locale and
// formatter the consuming app hands it, so it needs no i18n library of its own
// (no `next-intl`, no app path). This module holds the parts a Server Component
// may import too: the two types, the documented default and the pure resolver.
// It carries no `'use client'` directive and imports nothing; the React
// provider + hook live beside it in `DatePickerFormatContext.tsx`.
//
// Precedence, resolved for EACH input on its own: a prop beats the provider,
// and the provider beats the default (locale `en` + `defaultDatePickerFormatter`).

/**
 * The locale the picker formats its trigger date in: a plain BCP-47-style
 * string such as `en` or `zh-CN`. Deliberately opaque — not a closed union — so
 * any consumer can pass its own app locale through unchanged.
 */
export type DatePickerLocale = string;

/**
 * Formats an ISO `YYYY-MM-DD` date for display in `locale`. The picker calls it
 * with the selected value and the resolved locale.
 */
export type DatePickerFormatter = (isoDate: string, locale: DatePickerLocale) => string;

/** The two injectable inputs, each optional — a prop set or a provider value. */
export interface DatePickerFormatInputs {
  locale?: DatePickerLocale;
  formatDate?: DatePickerFormatter;
}

/** The resolved inputs: the locale in force and a formatter already bound to it. */
export interface ResolvedDatePickerFormat {
  locale: DatePickerLocale;
  /** The chosen formatter called with the resolved locale: `formatDate(iso)`. */
  formatDate: (isoDate: string) => string;
}

/** The locale used when neither a prop nor a provider supplies one. */
export const DEFAULT_DATE_PICKER_LOCALE: DatePickerLocale = 'en';

// The exact Intl options motir-core's `formatDate` uses, so the default reads
// `Jun 3, 2026` for `2026-06-03` byte for byte. The zone is pinned to UTC: an
// ISO date-only string parses as UTC midnight, so formatting in UTC is what keeps
// a host west of Greenwich from showing the previous day.
const DATE_ONLY_UTC: Intl.DateTimeFormatOptions = {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
};

// The tag the default falls back to — and the one bare `en` maps to, matching
// motir-core's `BCP47` `en` row.
const FALLBACK_INTL_TAG = 'en-US';

function toIntlTag(locale: DatePickerLocale): string {
  return locale === DEFAULT_DATE_PICKER_LOCALE ? FALLBACK_INTL_TAG : locale;
}

/**
 * The default formatter: `toLocaleString(locale, { timeZone: 'UTC', year:
 * 'numeric', month: 'short', day: 'numeric' })`. Bare `en` maps to `en-US`, any
 * other string reaches Intl unchanged, and a tag Intl rejects as malformed falls
 * back to the `en-US` output instead of throwing.
 */
export const defaultDatePickerFormatter: DatePickerFormatter = (isoDate, locale) => {
  const date = new Date(isoDate);
  try {
    return date.toLocaleString(toIntlTag(locale), DATE_ONLY_UTC);
  } catch (error) {
    // Intl signals a malformed language tag with a RangeError; that one case
    // degrades to the default's own locale. Anything else is a real defect.
    if (error instanceof RangeError) return date.toLocaleString(FALLBACK_INTL_TAG, DATE_ONLY_UTC);
    throw error;
  }
};

/**
 * Resolve the picker's format inputs: for the locale and for the formatter
 * separately, the prop wins, then the provider's value, then the default. An
 * `undefined` prop falls through. The returned `formatDate` is bound to the
 * resolved locale.
 */
export function resolveDatePickerFormat(
  props: DatePickerFormatInputs = {},
  provider: DatePickerFormatInputs = {},
): ResolvedDatePickerFormat {
  const locale = props.locale ?? provider.locale ?? DEFAULT_DATE_PICKER_LOCALE;
  const formatter = props.formatDate ?? provider.formatDate ?? defaultDatePickerFormatter;
  return { locale, formatDate: (isoDate) => formatter(isoDate, locale) };
}
