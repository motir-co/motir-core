// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  RunDiscrepancySection,
  VISIBLE_ENTRIES,
  type RunDiscrepancyRecordView,
} from '@/app/(authed)/items/[key]/_components/RunDiscrepancySection';
import { RUN_DISCREPANCY_SECTION_ID } from '@/app/(authed)/items/[key]/_components/decisionAnchor';
import { toRunDiscrepancyViews } from '@/app/(authed)/items/[key]/_components/runDiscrepancyViews';
import type { RunDiscrepancyEntryDto } from '@/lib/dto/runDiscrepancy';

// THE RUN DISCREPANCY SECTION (Task MOTIR-11996) against the approved MOTIR-11995 design
// (`design/runs/design-notes.md` § _Run discrepancy — the record gets its own section on the
// work item page_): no record, no section; collapsed to a summary row by default; opened by
// Show or by arriving at `#run-discrepancy`; several records newest-first with older ones
// folded; three entries per group behind Show N more; provenance for no run, a former member,
// a backfilled record and one that could not be recovered.

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/items/MOTIR-1');
});

beforeEach(() => {
  window.history.replaceState(null, '', '/items/MOTIR-1');
});

const entry = (n: number, extra: Partial<RunDiscrepancyEntryDto> = {}): RunDiscrepancyEntryDto => ({
  position: n,
  planText: `PLAN-${n}`,
  outcomeText: `OUTCOME-${n}`,
  why: `WHY-${n}`,
  alternatives: null,
  ...extra,
});

function view(over: Partial<RunDiscrepancyRecordView> = {}): RunDiscrepancyRecordView {
  return {
    id: 'rec_1',
    source: 'recorded',
    recordedAt: '2026-11-20T10:00:00.000Z',
    recordedAtLabel: '20 Nov, 10:00 UTC',
    recordedByName: 'Ada Lovelace',
    run: { id: 'run_1', startedAt: '2026-11-20T09:00:00.000Z' },
    runStartedAtLabel: '20 Nov, 09:00 UTC',
    pointCount: 1,
    decisionCount: 1,
    points: [entry(1)],
    decisions: [entry(1, { planText: 'SAID-1', outcomeText: 'CHOSE-1', alternatives: 'ALT-1' })],
    ...over,
  };
}

const section = () => document.getElementById(RUN_DISCREPANCY_SECTION_ID)!;
const showButton = () => screen.getByRole('button', { name: /Show$/ });

describe('no record, no section', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<RunDiscrepancySection records={[]} />);
    expect(container.innerHTML).toBe('');
    expect(document.getElementById(RUN_DISCREPANCY_SECTION_ID)).toBeNull();
  });
});

describe('collapsed by default', () => {
  it('shows the title, the gloss and one summary row with the counts and who recorded it', () => {
    render(<RunDiscrepancySection records={[view()]} />);
    const s = section();
    expect(within(s).getByRole('heading', { name: 'Run discrepancy' })).toBeTruthy();
    expect(s.textContent).toContain('what a run built or decided that the plan didn’t say');
    const row = showButton();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(row.textContent).toContain('1 point · 1 decision');
    expect(row.textContent).toContain('recorded 20 Nov, 10:00 UTC by Ada Lovelace');
    // The record's text is not on the page until it is opened.
    expect(s.textContent).not.toContain('PLAN-1');
    expect(screen.queryByRole('button', { name: 'Hide' })).toBeNull();
    // One record: no count pill.
    expect(s.textContent).not.toContain('records');
  });

  it('Show opens the newest record; Hide folds it back to the summary', () => {
    render(<RunDiscrepancySection records={[view()]} />);
    fireEvent.click(showButton());

    const s = section();
    expect(screen.getAllByTestId('run-discrepancy-point')).toHaveLength(1);
    expect(screen.getAllByTestId('run-discrepancy-decision')).toHaveLength(1);
    for (const text of ['Point 1', 'Plan asked', 'PLAN-1', 'Built', 'OUTCOME-1', 'WHY-1']) {
      expect(within(screen.getByTestId('run-discrepancy-point')).getByText(text)).toBeTruthy();
    }
    const decision = screen.getByTestId('run-discrepancy-decision');
    for (const text of ['Decision 1', 'Plan said', 'SAID-1', 'Chose', 'CHOSE-1', 'Alternatives']) {
      expect(within(decision).getByText(text)).toBeTruthy();
    }
    expect(s.textContent).toContain('Built differently from the plan');
    expect(s.textContent).toContain('Decided where the plan was silent');
    expect(s.textContent).toContain('Recorded 20 Nov, 10:00 UTC by Ada Lovelace');
    const run = within(s).getByRole('link', { name: 'Open the run of 20 Nov, 09:00 UTC' });
    expect(run.getAttribute('href')).toBe('/runs?run=run_1');
    expect(run.textContent).toBe('Run of 20 Nov, 09:00 UTC');

    const hide = screen.getByRole('button', { name: 'Hide' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(hide);
    expect(screen.queryByTestId('run-discrepancy-point')).toBeNull();
    expect(showButton()).toBeTruthy();
  });

  it('a decision with no alternatives draws no Alternatives line', () => {
    render(<RunDiscrepancySection records={[view({ decisions: [entry(1)] })]} />);
    fireEvent.click(showButton());
    expect(
      within(screen.getByTestId('run-discrepancy-decision')).queryByText('Alternatives'),
    ).toBeNull();
  });
});

describe('arriving at #run-discrepancy', () => {
  it('opens the section on mount and focuses it', () => {
    window.history.replaceState(null, '', `/items/MOTIR-1#${RUN_DISCREPANCY_SECTION_ID}`);
    render(<RunDiscrepancySection records={[view()]} />);
    expect(screen.getAllByTestId('run-discrepancy-point')).toHaveLength(1);
    expect(document.activeElement).toBe(section());
  });

  it('opens it on a later in-page hash change, and ignores another fragment', () => {
    render(<RunDiscrepancySection records={[view()]} />);
    act(() => {
      window.location.hash = '#comments';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.queryByTestId('run-discrepancy-point')).toBeNull();
    act(() => {
      window.location.hash = `#${RUN_DISCREPANCY_SECTION_ID}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getAllByTestId('run-discrepancy-point')).toHaveLength(1);
  });
});

describe('several records — newest open, older folded (decision 8)', () => {
  const older = view({
    id: 'rec_0',
    recordedAtLabel: '18 Nov, 08:00 UTC',
    recordedByName: 'Grace Hopper',
    pointCount: 2,
    decisionCount: 0,
    points: [entry(1, { planText: 'OLD-PLAN' }), entry(2)],
    decisions: [],
  });

  it('counts the records in a pill, totals every entry, and names the latest', () => {
    render(<RunDiscrepancySection records={[view(), older]} />);
    expect(section().textContent).toContain('2 records');
    const row = showButton();
    expect(row.textContent).toContain('3 points · 1 decision');
    expect(row.textContent).toContain('latest recorded 20 Nov, 10:00 UTC by Ada Lovelace');
  });

  it('opens the newest; an older record is one row that opens and closes in place', () => {
    render(<RunDiscrepancySection records={[view(), older]} />);
    fireEvent.click(showButton());
    expect(screen.getAllByTestId('run-discrepancy-point')).toHaveLength(1);
    expect(section().textContent).not.toContain('OLD-PLAN');

    const fold = screen.getByRole('button', { name: 'Show this record' });
    expect(fold.textContent).toContain('Recorded 18 Nov, 08:00 UTC by Grace Hopper');
    expect(fold.textContent).toContain('2 points');
    fireEvent.click(fold);
    expect(section().textContent).toContain('OLD-PLAN');
    expect(screen.getAllByTestId('run-discrepancy-point')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Hide this record' }));
    expect(section().textContent).not.toContain('OLD-PLAN');
  });
});

describe('many entries (decision 9)', () => {
  it(`shows ${VISIBLE_ENTRIES} per group, then Show N more / Show fewer`, () => {
    const points = [1, 2, 3, 4, 5].map((n) => entry(n));
    const decisions = [1, 2, 3, 4].map((n) => entry(n));
    render(
      <RunDiscrepancySection
        records={[view({ points, decisions, pointCount: 9, decisionCount: 4 })]}
      />,
    );
    fireEvent.click(showButton());
    expect(screen.getAllByTestId('run-discrepancy-point')).toHaveLength(VISIBLE_ENTRIES);
    expect(screen.getAllByTestId('run-discrepancy-decision')).toHaveLength(VISIBLE_ENTRIES);

    const morePoints = screen.getByRole('button', { name: 'Show 2 more points' });
    expect(morePoints.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(morePoints);
    expect(screen.getAllByTestId('run-discrepancy-point')).toHaveLength(5);
    // Each group folds on its own.
    expect(screen.getAllByTestId('run-discrepancy-decision')).toHaveLength(VISIBLE_ENTRIES);
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more decision' }));
    expect(screen.getAllByTestId('run-discrepancy-decision')).toHaveLength(4);

    fireEvent.click(screen.getAllByRole('button', { name: 'Show fewer' })[0]!);
    expect(screen.getAllByTestId('run-discrepancy-point')).toHaveLength(VISIBLE_ENTRIES);
  });

  it('a group of exactly three has no Show more', () => {
    render(<RunDiscrepancySection records={[view({ points: [1, 2, 3].map((n) => entry(n)) })]} />);
    fireEvent.click(showButton());
    expect(screen.queryByRole('button', { name: /more point/ })).toBeNull();
  });
});

describe('provenance', () => {
  it('a record on no run says so, and has no run link', () => {
    render(<RunDiscrepancySection records={[view({ run: null, runStartedAtLabel: null })]} />);
    fireEvent.click(showButton());
    expect(section().textContent).toContain('Not part of a run');
    expect(within(section()).queryByRole('link')).toBeNull();
  });

  it('a recorder whose account is gone reads as a former member, collapsed and open', () => {
    const gone = view({ recordedByName: null });
    render(<RunDiscrepancySection records={[gone, { ...gone, id: 'rec_0' }]} />);
    expect(showButton().textContent).toContain(
      'latest recorded 20 Nov, 10:00 UTC by a former member',
    );
    fireEvent.click(showButton());
    expect(section().textContent).toContain('Recorded 20 Nov, 10:00 UTC by a former member');
  });

  it('one record by a former member reads "recorded … by a former member"', () => {
    render(<RunDiscrepancySection records={[view({ recordedByName: null })]} />);
    expect(showButton().textContent).toContain('recorded 20 Nov, 10:00 UTC by a former member');
  });

  it('a backfilled record says where it came from', () => {
    render(<RunDiscrepancySection records={[view({ source: 'backfilled' })]} />);
    fireEvent.click(showButton());
    expect(section().textContent).toContain(
      'Recovered from a comment the run wrote before records were kept.',
    );
    expect(screen.queryByTestId('run-discrepancy-unreadable')).toBeNull();
  });

  it('a record that could not be recovered keeps its counts in a callout', () => {
    render(
      <RunDiscrepancySection
        records={[
          view({
            source: 'backfill_unreadable',
            pointCount: 2,
            decisionCount: 1,
            points: [],
            decisions: [],
          }),
        ]}
      />,
    );
    expect(showButton().textContent).toContain('This record couldn’t be recovered');
    fireEvent.click(showButton());
    const callout = screen.getByTestId('run-discrepancy-unreadable');
    expect(callout.textContent).toContain('This record couldn’t be recovered');
    expect(callout.textContent).toContain('so 2 points and 1 decision were lost');
    expect(screen.queryByTestId('run-discrepancy-point')).toBeNull();
  });
});

describe('toRunDiscrepancyViews — the times, formatted on the server', () => {
  it('formats the recorded and run times in the locale, UTC; no run gives no run label', () => {
    const [onRun, loose] = toRunDiscrepancyViews(
      [
        view({ recordedAt: '2026-11-20T10:05:00.000Z' }),
        view({ run: null, recordedAt: '2026-11-21T23:30:00.000Z' }),
      ],
      'en',
    );
    expect(onRun!.recordedAtLabel).toBe('Nov 20, 10:05 UTC');
    expect(onRun!.runStartedAtLabel).toBe('Nov 20, 09:00 UTC');
    expect(loose!.recordedAtLabel).toBe('Nov 21, 23:30 UTC');
    expect(loose!.runStartedAtLabel).toBeNull();
  });
});
