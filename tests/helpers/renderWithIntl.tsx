import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import enMessages from '@/messages/en.json';
import { defaultLocale } from '@/lib/i18n/locales';
import { DatePickerFormatAdapter } from '@/components/i18n/DatePickerFormatAdapter';

// Wraps a unit-rendered component in a NextIntlClientProvider seeded with the
// real `en` catalog, so any component that calls useTranslations() renders the
// exact production English strings. Use this in place of @testing-library's
// `render` for components that read translations — assertions on English text
// stay byte-identical to the catalog. Pass `messages`/`locale` to override (e.g.
// to assert a zh render).
//
// It also mounts `DatePickerFormatAdapter` inside the intl provider, exactly as
// `app/layout.tsx` does, so a package `DatePicker` rendered here formats its
// date in the given locale (MOTIR-10551) — `locale: 'zh'` shows `2026年6月3日`.
export function renderWithIntl(
  ui: ReactElement,
  {
    locale = defaultLocale,
    messages = enMessages,
    now,
    ...options
  }: Omit<RenderOptions, 'wrapper'> & {
    locale?: string;
    messages?: Record<string, unknown>;
    /** Pins the instant `useFormatter().relativeTime()` measures against, so a
     * relative-date assertion is deterministic (and next-intl does not fall back
     * to the environment clock). Mirrors `i18n/request.ts`'s per-request `now`. */
    now?: Date;
  } = {},
): RenderResult {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale={locale} messages={messages} now={now}>
        <DatePickerFormatAdapter>{children}</DatePickerFormatAdapter>
      </NextIntlClientProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...options });
}

export { enMessages };
