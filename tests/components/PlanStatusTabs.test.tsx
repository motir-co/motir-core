// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ push: vi.fn(), search: { value: '' } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => '/plans',
  useSearchParams: () => new URLSearchParams(mocks.search.value),
}));

import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanStatusTabs } from '@/app/(authed)/plans/_components/PlanStatusTabs';
import { PLAN_STATE_PARAM } from '@/lib/planning/planSessionFilter';

// MOTIR-6025 — the Plans list's PLAN-STATE FILTER (design Part XIX §19.1), the
// successor of the status tab strip (MOTIR-3241). The page-level wiring is
// `tests/planning/plansSessionListPage.test.tsx`; the strip itself is pinned here.

const COUNTS = {
  none: 2,
  generating: 1,
  waiting: 2,
  planned: 3,
  // Bug MOTIR-9006: a row state, never a segment — All does not add it either.
  approving: 6,
  stale: 0,
  approved: 9,
  declined: 4,
  closed: 5,
};

beforeEach(() => {
  mocks.push.mockReset();
  mocks.search.value = '';
});
afterEach(cleanup);

const option = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const group = () => screen.getByRole('group', { name: 'Filter conversations by plan state' });

describe('the filter’s a11y contract', () => {
  it('is a LABELLED group of eight real buttons — All first, then every listable state', () => {
    renderWithIntl(<PlanStatusTabs value={null} counts={COUNTS} />);

    const labels = within(group())
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels).toEqual([
      'All24',
      'Writing1',
      'Waiting to resume2',
      'Waiting for approval3',
      'Stale0',
      'Approved9',
      'Declined4',
      'Closed5',
    ]);
    expect(option('All').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  // MOTIR-9301: the list admits only a conversation holding a plan (MOTIR-9300), so no
  // listed row can be `none` — the strip draws no segment for it, and All sums only
  // the seven it draws (a stray `none` count in the payload is not added).
  it('draws no "No plan yet" segment, and All sums only the seven segments drawn', () => {
    renderWithIntl(<PlanStatusTabs value={null} counts={COUNTS} />);
    const labels = within(group())
      .getAllByRole('button')
      .map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.startsWith('No plan'))).toBe(false);
    expect(within(option('All')).getByText('24')).toBeTruthy();
  });

  // Bug MOTIR-9006: `approving` lasts the seconds an approve takes — a row state the chip
  // labels, but no segment to filter by, and its count is not in All.
  it('draws no "Approving…" segment', () => {
    renderWithIntl(<PlanStatusTabs value={null} counts={COUNTS} />);
    const labels = within(group())
      .getAllByRole('button')
      .map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.startsWith('Approving'))).toBe(false);
  });

  it('presses the state in view', () => {
    renderWithIntl(<PlanStatusTabs value="declined" counts={COUNTS} />);
    expect(option('Declined').getAttribute('aria-pressed')).toBe('true');
    expect(option('All').getAttribute('aria-pressed')).toBe('false');
  });

  it('scrolls without wrapping below `sm` (§19.1)', () => {
    renderWithIntl(<PlanStatusTabs value={null} counts={COUNTS} />);
    const scroller = group().parentElement!;
    expect(scroller.className).toContain('overflow-x-auto');
    expect(scroller.className).toContain('whitespace-nowrap');
  });

  it('hides the counts below `sm`', () => {
    renderWithIntl(<PlanStatusTabs value={null} counts={COUNTS} />);
    expect(within(option('Approved')).getByText('9').className).toContain('hidden sm:inline');
  });
});

describe('the URL it writes', () => {
  it('a state writes `?planState=`, keeping the rest of the query', () => {
    mocks.search.value = 'foo=1';
    renderWithIntl(<PlanStatusTabs value={null} counts={COUNTS} />);

    fireEvent.click(option('Approved'));

    expect(mocks.push).toHaveBeenCalledWith(`/plans?foo=1&${PLAN_STATE_PARAM}=approved`, {
      scroll: false,
    });
  });

  it('All writes a CLEAN url, and a switch drops the `?session=` landing', () => {
    mocks.search.value = 'planState=approved&session=s_1';
    renderWithIntl(<PlanStatusTabs value="approved" counts={COUNTS} />);

    fireEvent.click(option('All'));

    expect(mocks.push).toHaveBeenCalledWith('/plans', { scroll: false });
  });
});
