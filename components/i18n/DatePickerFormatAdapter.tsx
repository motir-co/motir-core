'use client';

import type { ReactNode } from 'react';
import { useLocale } from 'next-intl';
import { DatePickerFormatProvider, type DatePickerFormatter } from '@motir/design-system';
import { formatDate } from '@/lib/utils/datetime';
import { defaultLocale, isLocale } from '@/lib/i18n/locales';

/**
 * motir-core's formatter for the package `DatePicker`: the opaque locale string
 * the package passes is narrowed to the app's `Locale` union, so motir-core's
 * own `formatDate` and its `BCP47` table stay the single source of truth
 * (`zh` → `2026年6月3日`). An unknown string falls back to `defaultLocale`
 * rather than indexing `BCP47` with a key it lacks. Module scope, so the
 * provider receives the same function on every render.
 */
export const appDatePickerFormatter: DatePickerFormatter = (isoDate, locale) =>
  formatDate(isoDate, isLocale(locale) ? locale : defaultLocale);

/**
 * Maps the active next-intl locale and motir-core's `formatDate` onto the
 * package DatePicker's injected inputs (Story MOTIR-10551). Mounted once inside
 * `NextIntlClientProvider` — in `app/layout.tsx` for the app and in
 * `tests/helpers/renderWithIntl.tsx` for component tests — so every package
 * `DatePicker` below it shows its date in the reader's language. It reads the
 * locale with `useLocale()`, the value the request config resolved, which is
 * identical on server and client (hydration-safe).
 */
export function DatePickerFormatAdapter({ children }: { children: ReactNode }) {
  return (
    <DatePickerFormatProvider locale={useLocale()} formatDate={appDatePickerFormatter}>
      {children}
    </DatePickerFormatProvider>
  );
}
