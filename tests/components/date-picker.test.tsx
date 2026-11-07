// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { useState } from 'react';

// Radix Popover (used for the calendar dialog) anchors via Radix Popper, which
// needs ResizeObserver + the pointer-capture / scrollIntoView DOM APIs happy-dom
// doesn't ship. Polyfill them so Popover.Content renders + positions.
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

import { DatePicker } from '@motir/design-system';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Controlled host so a selection/clear flows back into the trigger. */
function Host({
  initial = null,
  onChange,
}: {
  initial?: string | null;
  onChange?: (v: string | null) => void;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <DatePicker
      aria-label="Due date"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

// The trigger opens a labelled dialog; the grid inside is labelled by the month
// caption (APG), so query the dialog by its aria-label and scope to it.
const openCalendar = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Due date' }));
  return screen.findByRole('dialog', { name: 'Due date' });
};

describe('DatePicker', () => {
  it('shows the placeholder when empty and the formatted date when set', () => {
    const { rerender } = render(
      <DatePicker aria-label="Due date" value={null} onChange={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Due date' }).textContent).toContain('Select a date');

    rerender(<DatePicker aria-label="Due date" value="2026-06-04" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Due date' }).textContent).toContain('Jun 4, 2026');
  });

  it('opens the calendar and selects a day → onChange(YYYY-MM-DD) + closes', async () => {
    const onChange = vi.fn();
    render(<Host initial="2026-06-04" onChange={onChange} />);

    const dialog = await openCalendar();
    // Seeded on the selected month.
    expect(within(dialog).getByText('June 2026')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'June 18, 2026' }));
    expect(onChange).toHaveBeenCalledWith('2026-06-18');
    // Popover closes after a pick.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Due date' })).toBeNull());
  });

  it('navigates months with the prev/next controls', async () => {
    render(<Host initial="2026-06-04" />);
    await openCalendar();

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByText('July 2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByText('May 2026')).toBeTruthy();
  });

  it('clears the value via the Clear control', () => {
    const onChange = vi.fn();
    render(<Host initial="2026-06-04" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear date' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('moves the focused day with the arrow keys and selects with Enter', async () => {
    const onChange = vi.fn();
    render(<Host initial="2026-06-04" onChange={onChange} />);
    const dialog = await openCalendar();
    const grid = within(dialog).getByRole('grid');

    // Focus seeds on the selected day (Jun 4); ArrowRight → Jun 5, Enter selects.
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('2026-06-05');
  });

  it('does not render a Clear control when empty', () => {
    render(<DatePicker aria-label="Due date" value={null} onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Clear date' })).toBeNull();
  });
});
