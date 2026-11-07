// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import { DatePicker } from '@motir/design-system';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import { formatDate } from '@/lib/utils/datetime';

// MOTIR-10580 — the path a switched call site takes: the package DatePicker,
// rendered through renderWithIntl (which mounts DatePickerFormatAdapter inside
// its NextIntlClientProvider, as app/layout.tsx does), with no per-site locale
// or formatter prop. Only a non-en trigger proves the adapter is wired — the
// package default already equals motir-core's en output — so the sentinel case
// renders without the adapter and expects English.

// Radix Popover anchors via Radix Popper, which needs ResizeObserver + the
// pointer-capture / scrollIntoView DOM APIs happy-dom doesn't ship.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const LABEL = 'Due date';
const trigger = () => screen.getByRole('button', { name: LABEL });
const picker = (value: string | null) => (
  <DatePicker aria-label={LABEL} value={value} onChange={() => {}} />
);

/** Controlled host so a pick flows back into the trigger. */
function Host({ initial, onChange }: { initial: string; onChange: (v: string | null) => void }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <DatePicker
      aria-label={LABEL}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('package DatePicker trigger text through the app adapter wiring', () => {
  it('reads 2026年6月3日 under zh, equal to formatDate(iso, "zh")', () => {
    renderWithIntl(picker('2026-06-03'), { locale: 'zh' });
    expect(trigger().textContent).toContain('2026年6月3日');
    expect(trigger().textContent).toBe(formatDate('2026-06-03', 'zh'));
  });

  it('reads Jun 3, 2026 under the default locale', () => {
    renderWithIntl(picker('2026-06-03'));
    expect(trigger().textContent).toContain('Jun 3, 2026');
    expect(trigger().textContent).toBe(formatDate('2026-06-03', 'en'));
  });

  it('reads de in its own format, not the English one', () => {
    renderWithIntl(picker('2026-06-03'), { locale: 'de' });
    expect(trigger().textContent).toBe(formatDate('2026-06-03', 'de'));
    expect(trigger().textContent).not.toContain('Jun 3, 2026');
  });

  it('keeps 2026-12-31 in its own year under zh (no UTC shift)', () => {
    renderWithIntl(picker('2026-12-31'), { locale: 'zh' });
    expect(trigger().textContent).toBe(formatDate('2026-12-31', 'zh'));
    expect(trigger().textContent).toContain('2026年12月31日');
  });

  it('sentinel: without the adapter a zh intl provider leaves the English default', () => {
    render(
      <NextIntlClientProvider locale="zh" messages={enMessages}>
        {picker('2026-06-03')}
      </NextIntlClientProvider>,
    );
    expect(trigger().textContent).toBe('Jun 3, 2026');
    expect(trigger().textContent).not.toContain('2026年6月3日');
  });

  it('an explicit formatDate prop still beats the adapter', () => {
    renderWithIntl(
      <DatePicker
        aria-label={LABEL}
        value="2026-06-03"
        onChange={() => {}}
        formatDate={(iso, locale) => `X:${iso}:${locale}`}
      />,
      { locale: 'zh' },
    );
    expect(trigger().textContent).toBe('X:2026-06-03:zh');
  });

  it('picks a day under zh: ISO onChange, localized trigger, English calendar strings', async () => {
    const onChange = vi.fn();
    renderWithIntl(<Host initial="2026-06-04" onChange={onChange} />, { locale: 'zh' });
    fireEvent.click(trigger());
    const dialog = await screen.findByRole('dialog', { name: LABEL });
    expect(within(dialog).getByText('June 2026')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Today' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Clear' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'June 18, 2026' }));
    expect(onChange).toHaveBeenCalledWith('2026-06-18');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: LABEL })).toBeNull());
    expect(trigger().textContent).toBe('2026年6月18日');
  });

  it('shows the English placeholder and no Clear control for a null value under zh', () => {
    renderWithIntl(picker(null), { locale: 'zh' });
    expect(trigger().textContent).toContain('Select a date');
    expect(screen.queryByRole('button', { name: 'Clear date' })).toBeNull();
  });
});
