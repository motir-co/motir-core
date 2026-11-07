'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  resolveDatePickerFormat,
  type DatePickerFormatInputs,
  type ResolvedDatePickerFormat,
} from './datePickerFormat';

// The client half of the DatePicker's format injection: a context an app sets
// once for a subtree, and the hook the picker reads it through. The pure types,
// default and resolver live in `./datePickerFormat` (no directive, server-safe).

const DatePickerFormatContext = createContext<DatePickerFormatInputs>({});

export interface DatePickerFormatProviderProps extends DatePickerFormatInputs {
  children: ReactNode;
}

/**
 * Sets the `DatePicker`'s locale and/or formatter for everything below it.
 * Each input is optional and merges over an enclosing provider PER FIELD: an
 * inner provider that sets only `locale` keeps the outer `formatDate`.
 *
 * @example
 * <DatePickerFormatProvider locale={appLocale} formatDate={appFormatDate}>
 *   <App />
 * </DatePickerFormatProvider>
 */
export function DatePickerFormatProvider({
  locale,
  formatDate,
  children,
}: DatePickerFormatProviderProps) {
  const parent = useContext(DatePickerFormatContext);
  const value = useMemo<DatePickerFormatInputs>(
    () => ({
      locale: locale ?? parent.locale,
      formatDate: formatDate ?? parent.formatDate,
    }),
    [locale, formatDate, parent.locale, parent.formatDate],
  );
  return (
    <DatePickerFormatContext.Provider value={value}>{children}</DatePickerFormatContext.Provider>
  );
}

/**
 * The resolved format for a picker: `props` (a component's own `locale` /
 * `formatDate`) beat the nearest provider, which beats the default — per field.
 * Called with no argument it resolves the provider over the default.
 */
export function useDatePickerFormat(props: DatePickerFormatInputs = {}): ResolvedDatePickerFormat {
  const provider = useContext(DatePickerFormatContext);
  const { locale, formatDate } = props;
  return useMemo(
    () => resolveDatePickerFormat({ locale, formatDate }, provider),
    [locale, formatDate, provider],
  );
}
