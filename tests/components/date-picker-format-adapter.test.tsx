// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useDatePickerFormat } from '@motir/design-system';
import {
  DatePickerFormatAdapter,
  appDatePickerFormatter,
} from '@/components/i18n/DatePickerFormatAdapter';
import { formatDate } from '@/lib/utils/datetime';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';

// MOTIR-10577 — motir-core's next-intl adapter for the package DatePicker: the
// active next-intl locale and motir-core's own formatDate reach the package's
// injected inputs. Asserted on the adapter alone, through the package hook (no
// picker — the picker-level zh assertion is its own subtask).

afterEach(cleanup);

const ISO = '2026-06-03';

/** A package-provider consumer: prints the locale and date it resolves. */
function Probe() {
  const { locale, formatDate: format } = useDatePickerFormat();
  return (
    <output data-testid="probe">
      {locale}|{format(ISO)}
    </output>
  );
}

function renderUnder(locale: string, ui = <Probe />) {
  return render(
    <NextIntlClientProvider locale={locale} messages={enMessages}>
      <DatePickerFormatAdapter>{ui}</DatePickerFormatAdapter>
    </NextIntlClientProvider>,
  );
}

const probe = () => screen.getByTestId('probe').textContent;

describe('DatePickerFormatAdapter', () => {
  it('hands the package the zh locale and motir-core zh output', () => {
    renderUnder('zh');
    expect(probe()).toBe('zh|2026年6月3日');
  });

  it('hands the package en and the en output equal to formatDate(iso, "en")', () => {
    renderUnder('en');
    expect(probe()).toBe(`en|${formatDate(ISO, 'en')}`);
    expect(formatDate(ISO, 'en')).toBe('Jun 3, 2026');
  });

  it('formats de exactly as formatDate(iso, "de")', () => {
    renderUnder('de');
    expect(probe()).toBe(`de|${formatDate(ISO, 'de')}`);
  });
});

describe('appDatePickerFormatter', () => {
  it('falls back to the default locale on an unknown string instead of throwing', () => {
    expect(() => appDatePickerFormatter(ISO, 'xx-unknown')).not.toThrow();
    expect(appDatePickerFormatter(ISO, 'xx-unknown')).toBe('Jun 3, 2026');
  });

  it('is one module-scope function the provider receives on every render', () => {
    // The package memoises the provider value and the bound formatter on the
    // formatter's identity, so the bound function a consumer receives stays the
    // same across adapter re-renders only if the adapter forwards one stable
    // function — an inline arrow would hand down a new one each render.
    const seen: Array<(iso: string) => string> = [];
    function Capture() {
      seen.push(useDatePickerFormat().formatDate);
      return null;
    }
    const { rerender } = renderUnder('en', <Capture />);
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <DatePickerFormatAdapter>
          <Capture />
        </DatePickerFormatAdapter>
      </NextIntlClientProvider>,
    );
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1]).toBe(seen[0]);
  });
});

describe('renderWithIntl mounts the adapter', () => {
  it('gives a package-provider consumer locale zh', () => {
    renderWithIntl(<Probe />, { locale: 'zh' });
    expect(probe()).toBe('zh|2026年6月3日');
  });

  it('keeps the en output for the default call', () => {
    renderWithIntl(<Probe />);
    expect(probe()).toBe('en|Jun 3, 2026');
  });
});
