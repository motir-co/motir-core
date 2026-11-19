// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

// THE COSTS PAGE'S CLIENT ISLANDS (MOTIR-11712; design MOTIR-11711): the period
// switch and range picker, which put the view in the URL, the row disclosure,
// and Try again.

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/admin/costs',
}));

const { CostsPeriodControls } =
  await import('@/app/(admin)/admin/costs/_components/CostsPeriodControls');
const { CostRow } = await import('@/app/(admin)/admin/costs/_components/CostRow');
const { CostsUnavailable } = await import('@/app/(admin)/admin/costs/_components/CostsUnavailable');

afterEach(() => {
  cleanup();
  push.mockReset();
  refresh.mockReset();
});

const LABELS = {
  group: 'Period',
  day: 'Day',
  month: 'Month',
  year: 'Year',
  pickMonth: 'Month',
  pickYear: 'Year',
};
const TODAY = '2026-11-18';

describe('CostsPeriodControls', () => {
  it('Day view: a labelled month picker, and a pick pushes ?view=day&month=', () => {
    render(
      <CostsPeriodControls
        view={{ kind: 'day', month: '2026-11' }}
        today={TODAY}
        options={[
          { value: '2026-11', label: 'November 2026' },
          { value: '2025-02', label: 'February 2025' },
        ]}
        labels={LABELS}
      />,
    );
    const group = screen.getByRole('group', { name: 'Period' });
    expect(within(group).getByRole('button', { name: 'Day' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2025-02' } });
    expect(push).toHaveBeenCalledWith('/admin/costs?view=day&month=2025-02');

    // Day → Month keeps the shown month's year; pressing the active view does nothing.
    fireEvent.click(within(group).getByRole('button', { name: 'Day' }));
    expect(push).toHaveBeenCalledTimes(1);
    fireEvent.click(within(group).getByRole('button', { name: 'Month' }));
    expect(push).toHaveBeenLastCalledWith('/admin/costs?view=month&year=2026');
    fireEvent.click(within(group).getByRole('button', { name: 'Year' }));
    expect(push).toHaveBeenLastCalledWith('/admin/costs?view=year');
  });

  it('Month view: a year picker; back to Day opens that year’s latest month', () => {
    const { rerender } = render(
      <CostsPeriodControls
        view={{ kind: 'month', year: '2025' }}
        today={TODAY}
        options={[
          { value: '2026', label: '2026' },
          { value: '2025', label: '2025' },
        ]}
        labels={LABELS}
      />,
    );
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2026' } });
    expect(push).toHaveBeenLastCalledWith('/admin/costs?view=month&year=2026');
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    expect(push).toHaveBeenLastCalledWith('/admin/costs?view=day&month=2025-12');

    rerender(
      <CostsPeriodControls
        view={{ kind: 'month', year: '2026' }}
        today={TODAY}
        options={[]}
        labels={LABELS}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    expect(push).toHaveBeenLastCalledWith('/admin/costs?view=day&month=2026-11');
  });

  it('Year view: no picker; Month and Day open the current year and month', () => {
    render(
      <CostsPeriodControls view={{ kind: 'year' }} today={TODAY} options={[]} labels={LABELS} />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(push).toHaveBeenLastCalledWith('/admin/costs?view=month&year=2026');
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    expect(push).toHaveBeenLastCalledWith('/admin/costs?view=day&month=2026-11');
  });
});

describe('CostRow', () => {
  it('opens and closes its drill-down from the period button, which says what it shows', () => {
    render(
      <table>
        <tbody>
          <CostRow
            period="2026-11-18"
            periodLabel="Wed, Nov 18"
            openLabel="Show what made up Wed, Nov 18"
            partial
            mark={<span>Partial</span>}
            cells={<td>$1.00</td>}
            drillDown={<p>breakdown</p>}
            cellClassName="cell"
          />
        </tbody>
      </table>,
    );
    const button = screen.getByRole('button', { name: 'Show what made up Wed, Nov 18' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('breakdown')).toBeNull();
    expect(screen.getByText('Partial')).toBeTruthy();
    expect(button.closest('tr')!.getAttribute('data-partial')).toBe('true');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('costs-drilldown').textContent).toBe('breakdown');
    fireEvent.click(button);
    expect(screen.queryByText('breakdown')).toBeNull();
  });
});

describe('CostsUnavailable', () => {
  it('Try again re-reads the page', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <CostsUnavailable
          testId="costs-unavailable-aws"
          title="AWS costs can’t be shown right now"
          description="AWS Cost Explorer did not answer."
          retryLabel="Try again"
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('costs-unavailable-aws').textContent).toContain(
      'AWS costs can’t be shown right now',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
