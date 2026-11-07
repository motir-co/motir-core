// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import {
  DatePicker,
  DatePickerFormatProvider,
  type DatePickerFormatter,
  type DatePickerProps,
} from '../src/index';

// MOTIR-10575 — the package DatePicker: the 2.4.12 picker moved out of motir-core
// with an injected locale + formatter. These pin its whole behaviour contract on
// the package component (ported from motir-core's tests/components/
// date-picker.test.tsx, minus its next-intl helper), prop and provider
// injection into the trigger text, and the UTC-only maths.

// RTL's act() flushes effects inside each scope (motir-core's actEnvironment.ts).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const originalTz = process.env.TZ;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  process.env.TZ = originalTz;
});

const LABEL = 'Due date';

/** Controlled host so a selection/clear flows back into the trigger. */
function Host({
  initial = null,
  onChange,
  ...rest
}: { initial?: string | null } & Partial<DatePickerProps>) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <DatePicker
      aria-label={LABEL}
      {...rest}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const trigger = () => screen.getByRole('button', { name: LABEL });
const openCalendar = () => {
  fireEvent.click(trigger());
  return screen.findByRole('dialog', { name: LABEL });
};
const grid = (dialog: HTMLElement) => within(dialog).getByRole('grid');
const focusedKey = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole('button')
    .filter((b) => b.dataset.key && b.tabIndex === 0)
    .map((b) => b.dataset.key);
const press = (dialog: HTMLElement, key: string) => fireEvent.keyDown(grid(dialog), { key });

const tagging: DatePickerFormatter = (iso, locale) => `X:${iso}:${locale}`;
const other: DatePickerFormatter = (iso, locale) => `Y:${iso}:${locale}`;

describe('trigger text — the en/UTC default', () => {
  it('shows Jun 4, 2026 for 2026-06-04 with no locale, formatter or provider', () => {
    render(<DatePicker aria-label={LABEL} value="2026-06-04" onChange={() => {}} />);
    expect(trigger().textContent).toContain('Jun 4, 2026');
  });

  it('shows the placeholder when the value is null', () => {
    const { rerender } = render(<DatePicker aria-label={LABEL} value={null} onChange={() => {}} />);
    expect(trigger().textContent).toContain('Select a date');
    rerender(
      <DatePicker aria-label={LABEL} value={null} placeholder="Pick one" onChange={() => {}} />,
    );
    expect(trigger().textContent).toContain('Pick one');
  });
});

describe('trigger text — injection', () => {
  const at = (ui: React.ReactElement) => {
    render(ui);
    return trigger().textContent;
  };

  it('a formatDate + locale prop drive the trigger', () => {
    expect(
      at(
        <DatePicker
          aria-label={LABEL}
          value="2026-06-04"
          onChange={() => {}}
          locale="zh-CN"
          formatDate={tagging}
        />,
      ),
    ).toContain('X:2026-06-04:zh-CN');
  });

  it('the same inputs through DatePickerFormatProvider give the same text', () => {
    expect(
      at(
        <DatePickerFormatProvider locale="zh-CN" formatDate={tagging}>
          <DatePicker aria-label={LABEL} value="2026-06-04" onChange={() => {}} />
        </DatePickerFormatProvider>,
      ),
    ).toContain('X:2026-06-04:zh-CN');
  });

  it('a prop beats the provider for both inputs', () => {
    expect(
      at(
        <DatePickerFormatProvider locale="de-DE" formatDate={tagging}>
          <DatePicker
            aria-label={LABEL}
            value="2026-06-04"
            onChange={() => {}}
            locale="zh-CN"
            formatDate={other}
          />
        </DatePickerFormatProvider>,
      ),
    ).toContain('Y:2026-06-04:zh-CN');
  });

  it('a locale-only prop keeps the provider formatter, which receives the prop locale', () => {
    expect(
      at(
        <DatePickerFormatProvider locale="de-DE" formatDate={tagging}>
          <DatePicker aria-label={LABEL} value="2026-06-04" onChange={() => {}} locale="zh-CN" />
        </DatePickerFormatProvider>,
      ),
    ).toContain('X:2026-06-04:zh-CN');
  });
});

describe('the 2.4.12 contract', () => {
  it('opens a dialog named by aria-label holding a grid seeded on the selected month, one roving day', async () => {
    render(<Host initial="2026-06-04" />);
    const dialog = await openCalendar();
    expect(within(dialog).getByText('June 2026')).toBeTruthy();
    expect(grid(dialog)).toBeTruthy();
    expect(focusedKey(dialog)).toEqual(['2026-06-04']);
  });

  it('ArrowRight then Enter selects the next day as an ISO string', async () => {
    const onChange = vi.fn();
    render(<Host initial="2026-06-04" onChange={onChange} />);
    const dialog = await openCalendar();
    press(dialog, 'ArrowRight');
    press(dialog, 'Enter');
    expect(onChange).toHaveBeenCalledWith('2026-06-05');
  });

  it('Space selects the focused day too', async () => {
    const onChange = vi.fn();
    render(<Host initial="2026-06-04" onChange={onChange} />);
    const dialog = await openCalendar();
    press(dialog, ' ');
    expect(onChange).toHaveBeenCalledWith('2026-06-04');
  });

  it('moves the roving focus with the full keyboard model', async () => {
    // 2026-06-10 is a Wednesday.
    render(<Host initial="2026-06-10" />);
    const dialog = await openCalendar();
    const steps: Array<[string, string]> = [
      ['ArrowDown', '2026-06-17'],
      ['ArrowUp', '2026-06-10'],
      ['ArrowLeft', '2026-06-09'],
      ['ArrowRight', '2026-06-10'],
      ['PageDown', '2026-07-10'],
      ['PageUp', '2026-06-10'],
      ['Home', '2026-06-07'],
      ['End', '2026-06-13'],
    ];
    for (const [key, expected] of steps) {
      press(dialog, key);
      await waitFor(() => expect(focusedKey(dialog)).toEqual([expected]));
    }
    // An unrelated key moves nothing.
    press(dialog, 'Tab');
    expect(focusedKey(dialog)).toEqual(['2026-06-13']);
  });

  it('PageDown clamps the day to the shorter month', async () => {
    render(<Host initial="2026-01-31" />);
    const dialog = await openCalendar();
    press(dialog, 'PageDown');
    await waitFor(() => expect(focusedKey(dialog)).toEqual(['2026-02-28']));
  });

  it('clicking a day calls onChange and closes the dialog', async () => {
    const onChange = vi.fn();
    render(<Host initial="2026-06-04" onChange={onChange} />);
    const dialog = await openCalendar();
    fireEvent.click(within(dialog).getByRole('button', { name: 'June 18, 2026' }));
    expect(onChange).toHaveBeenCalledWith('2026-06-18');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: LABEL })).toBeNull());
    expect(trigger().textContent).toContain('Jun 18, 2026');
  });

  it('Previous / Next month change the caption, across a year boundary', async () => {
    render(<Host initial="2026-12-04" />);
    const dialog = await openCalendar();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next month' }));
    expect(within(dialog).getByText('January 2027')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Previous month' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Previous month' }));
    expect(within(dialog).getByText('November 2026')).toBeTruthy();
    for (let i = 0; i < 11; i++) {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Previous month' }));
    }
    expect(within(dialog).getByText('December 2025')).toBeTruthy();
  });

  it('the trigger Clear date control calls onChange(null)', () => {
    const onChange = vi.fn();
    render(<Host initial="2026-06-04" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear date' }));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(trigger().textContent).toContain('Select a date');
  });

  it('the footer Clear calls onChange(null) and closes', async () => {
    const onChange = vi.fn();
    render(<Host initial="2026-06-04" onChange={onChange} />);
    const dialog = await openCalendar();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenCalledWith(null);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: LABEL })).toBeNull());
  });

  it('renders no trigger Clear control when the value is null or the picker is disabled', () => {
    const { rerender } = render(<DatePicker aria-label={LABEL} value={null} onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Clear date' })).toBeNull();
    rerender(<DatePicker aria-label={LABEL} value="2026-06-04" disabled onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Clear date' })).toBeNull();
  });

  it('Today moves the focus and the view to today (UTC)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T23:30:00Z'));
    render(<Host initial="2026-06-04" />);
    const dialog = await openCalendar();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(focusedKey(dialog)).toEqual(['2026-09-15']));
    expect(within(dialog).getByText('September 2026')).toBeTruthy();
  });

  it('marks aria-current="date" on today only and aria-selected on the chosen day only', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'));
    render(<Host initial="2026-06-04" />);
    const dialog = await openCalendar();
    const current = within(dialog)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-current') === 'date');
    expect(current.map((b) => b.dataset.key)).toEqual(['2026-06-10']);
    const selected = within(dialog)
      .getAllByRole('gridcell')
      .filter((c) => c.getAttribute('aria-selected') === 'true');
    expect(selected.map((c) => c.querySelector('button')?.dataset.key)).toEqual(['2026-06-04']);
  });

  it('seeds on today when the value is null, and re-seeds on each open', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-02T00:00:00Z'));
    render(<Host />);
    let dialog = await openCalendar();
    expect(within(dialog).getByText('March 2026')).toBeTruthy();
    expect(focusedKey(dialog)).toEqual(['2026-03-02']);
    press(dialog, 'PageDown');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: LABEL })).toBeNull());
    dialog = await openCalendar();
    expect(within(dialog).getByText('March 2026')).toBeTruthy();
  });
});

describe('disabled and lifecycle', () => {
  it('a disabled picker never opens, autoOpen included, and its trigger opens nothing', () => {
    render(
      <DatePicker aria-label={LABEL} value="2026-06-04" disabled autoOpen onChange={() => {}} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(trigger());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('autoOpen on an enabled picker opens the dialog on mount', async () => {
    render(<DatePicker aria-label={LABEL} value="2026-06-04" autoOpen onChange={() => {}} />);
    expect(await screen.findByRole('dialog', { name: LABEL })).toBeTruthy();
  });

  it('onClose fires on Escape without a pick, and not when a day is picked', async () => {
    const onClose = vi.fn();
    render(<Host initial="2026-06-04" onClose={onClose} />);
    let dialog = await openCalendar();
    fireEvent.click(within(dialog).getByRole('button', { name: 'June 20, 2026' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: LABEL })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();

    dialog = await openCalendar();
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: LABEL })).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog).toBeTruthy();
  });
});

describe('UTC-only maths', () => {
  for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
    it(`picks 2026-01-01 and 2024-02-29 as themselves with TZ=${tz}`, async () => {
      process.env.TZ = tz;
      for (const iso of ['2026-01-01', '2024-02-29']) {
        const onChange = vi.fn();
        const [y, , d] = iso.split('-').map(Number) as [number, number, number];
        render(<Host initial={iso} onChange={onChange} />);
        const dialog = await openCalendar();
        const cell = within(dialog)
          .getAllByRole('button')
          .find((b) => b.dataset.key === iso);
        expect(cell).toBeTruthy();
        expect(cell?.getAttribute('aria-label')).toContain(`${d}, ${y}`);
        fireEvent.click(cell!);
        expect(onChange).toHaveBeenCalledWith(iso);
        cleanup();
      }
    });
  }
});

describe('source text', () => {
  const text = readFileSync(path.resolve(__dirname, '../src/components/ui/DatePicker.tsx'), 'utf8');

  it('is a client module importing nothing app-bound', () => {
    expect(text.trimStart().startsWith("'use client';")).toBe(true);
    const sources = [...text.matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(sources).toEqual([
      'react',
      'lucide-react',
      './Popover',
      '../../utils/cn',
      './datePickerFormat',
      './DatePickerFormatContext',
    ]);
    expect(text).not.toMatch(/next-intl|from ['"]next|['"]@\//);
  });

  it('calls no local-time getter (getDate / getMonth / getFullYear / getDay)', () => {
    expect(text.match(/\.get(Date|Month|FullYear|Day)\(/g)).toBeNull();
  });

  it('keeps the calendar icon class and only --el-* colour tokens', () => {
    expect(text).toContain('h-4 w-4 shrink-0 text-(--el-icon-field)');
    expect(text).not.toMatch(/\(--color-/);
  });
});
