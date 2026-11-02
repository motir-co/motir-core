// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/plans',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));
vi.mock('@/lib/planning/planChangeClient', () => ({ resumePlanSession: vi.fn() }));
vi.mock('@/lib/planning/planReviewClient', () => ({ fetchPlanReview: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  NotPlannedYetList,
  ROW_LINES_MAX,
  notPlannedYetShown,
} from '@/components/planning/NotPlannedYetList';
import { FailedWaitingNotice } from '@/components/planning/SessionWaitingParts';
import { SessionRow } from '@/app/(authed)/plans/_components/SessionRow';
import type { SessionRowView } from '@/app/(authed)/plans/_components/types';
import type { PlanSessionFailureDto } from '@/lib/dto/planChange';
import type { ToResumePlanningSessionDto } from '@/lib/dto/home';

const { PlanningSessionResumeEntry } =
  await import('../../app/(authed)/workbench/_components/PlanningSessionResumeEntry');

// MOTIR-10209 — a halted planning job's `walkStop.notPlannedYet` lines, drawn under the stop line
// wherever that failure is shown (design `design/ai-chat/design-notes.md` § _A halted planning
// job's not-planned-yet list_, mock `planning-workspace--not-planned-yet.mock.html`): verbatim and
// in order; every line in the overlay; at most three on a row, else two and a count line; and a
// failure without lines exactly as it rendered before.

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const LINES = [
  '"D" is not planned yet: plan "B" first, then plan "D".',
  'Not written yet: "T" waits on "S", and planning stopped before it was written — continuing this plan writes it.',
  '"Send invoice reminders" is not planned yet: plan "Billing settings" first.',
  '"Export a report" is not planned yet: plan "Reports" first.',
  '"Archive old invoices" is not planned yet: plan "Billing settings" first.',
];
const tn = en.workbench.planningSession.notPlannedYet;

const itemsOf = (root: HTMLElement) =>
  within(within(root).getByRole('list', { name: tn.label }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);

describe('notPlannedYetShown — the long-list rule', () => {
  it('the overlay shows every line', () => {
    expect(notPlannedYetShown(LINES, 'all')).toEqual({ shown: LINES, hidden: 0 });
  });

  it.each([1, 2, ROW_LINES_MAX])('a row shows %i line(s) in full', (n) => {
    expect(notPlannedYetShown(LINES.slice(0, n), 'row')).toEqual({
      shown: LINES.slice(0, n),
      hidden: 0,
    });
  });

  it('a row with four or more shows the FIRST two and counts the rest — never hiding just one', () => {
    expect(notPlannedYetShown(LINES.slice(0, 4), 'row')).toEqual({
      shown: LINES.slice(0, 2),
      hidden: 2,
    });
    expect(notPlannedYetShown(LINES, 'row')).toEqual({ shown: LINES.slice(0, 2), hidden: 3 });
  });
});

describe('NotPlannedYetList', () => {
  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', []],
  ])('draws nothing when the lines are %s', (_name, lines) => {
    const { container } = renderWithIntl(<NotPlannedYetList lines={lines} surface="all" />);
    expect(container.innerHTML).toBe('');
  });

  it('draws a named list of the lines, verbatim and in order, in the stop line’s ink', () => {
    renderWithIntl(<NotPlannedYetList lines={LINES} surface="all" />);
    const block = screen.getByTestId('not-planned-yet');
    expect(itemsOf(block)).toEqual(LINES);
    const list = within(block).getByRole('list');
    expect(list.className).toContain('text-(--el-text-secondary)');
    expect(list.className).toContain('list-disc');
    expect(screen.queryByTestId('not-planned-yet-more')).toBeNull();
  });

  it('a row holds a long list back behind a plain-text count line', () => {
    renderWithIntl(<NotPlannedYetList lines={LINES} surface="row" />);
    const block = screen.getByTestId('not-planned-yet');
    expect(itemsOf(block)).toEqual(LINES.slice(0, 2));
    const more = screen.getByTestId('not-planned-yet-more');
    expect(more.tagName).toBe('P');
    expect(more.textContent).toBe('and 3 more items not planned yet — open it to see them all');
  });

  it('four lines — one past the cap — show two and count two', () => {
    renderWithIntl(<NotPlannedYetList lines={LINES.slice(0, 4)} surface="row" />);
    expect(screen.getByTestId('not-planned-yet-more').textContent).toBe(
      'and 2 more items not planned yet — open it to see them all',
    );
  });

  it('names the list and counts in Chinese, and never translates the lines', () => {
    renderWithIntl(<NotPlannedYetList lines={LINES} surface="row" />, {
      locale: 'zh',
      messages: zh,
    });
    expect(
      screen.getByRole('list', { name: zh.workbench.planningSession.notPlannedYet.label }),
    ).toBeTruthy();
    expect(screen.getByTestId('not-planned-yet-more').textContent).toBe(
      '还有 3 个工作项尚未规划——打开它查看全部',
    );
    expect(screen.getByText(LINES[0]!)).toBeTruthy();
  });
});

// ── the overlay's failed-walk block ──────────────────────────────────────────

const FAILURE: PlanSessionFailureDto = {
  failedAt: '2026-11-02T00:00:00.000Z',
  reason: 'job_failed',
  stopPhase: 'author',
  stopRef: 'ACME-20',
  stopTitle: 'Send invoice reminders',
};

const notice = (failure: PlanSessionFailureDto) =>
  renderWithIntl(
    <FailedWaitingNotice
      failure={failure}
      failedAgain={false}
      resuming={false}
      resumeError={null}
      canResume
      starterName="Mara Lind"
      onResume={vi.fn()}
    />,
  );

describe('the overlay — FailedWaitingNotice', () => {
  it('shows EVERY line under the stop line and above the kept sentence, with no count line', () => {
    notice({ ...FAILURE, notPlannedYet: LINES });
    const block = screen.getByTestId('planning-failed-waiting');
    const list = within(block).getByTestId('not-planned-yet');
    expect(itemsOf(list)).toEqual(LINES);
    expect(within(block).queryByTestId('not-planned-yet-more')).toBeNull();

    const children = Array.from(block.children);
    const at = children.indexOf(list);
    expect(children[at - 1]?.textContent).toContain('Stopped at');
    expect(children[at + 1]?.textContent).toBe(en.planningWorkspace.waiting.kept);
  });

  it.each([
    ['without lines', undefined],
    ['with an empty list', []],
  ])('renders as before %s', (_name, notPlannedYet) => {
    const before = notice(FAILURE).container.innerHTML;
    cleanup();
    const after = notice({ ...FAILURE, notPlannedYet }).container.innerHTML;
    expect(after).toBe(before);
    expect(screen.queryByTestId('not-planned-yet')).toBeNull();
  });
});

// ── the workbench To resume entry ────────────────────────────────────────────

function entry(over: Partial<ToResumePlanningSessionDto> = {}): ToResumePlanningSessionDto {
  return {
    sessionId: 's1',
    form: 'failed_walk',
    planId: 'p1',
    title: 'Plan for Billing',
    waitingPlan: null,
    projectName: 'Acme',
    targets: [],
    failure: { ...FAILURE },
    endedAt: null,
    progress: null,
    ...over,
  };
}

const mountEntry = (e: ToResumePlanningSessionDto) =>
  renderWithIntl(
    <PlanningSessionResumeEntry
      entry={e}
      arrived={false}
      held={false}
      onSettled={vi.fn()}
      onResumed={vi.fn()}
    />,
  );

describe('To resume — a failed walk (form A)', () => {
  it('shows up to three lines in full, as a cell of the entry’s row', () => {
    mountEntry(entry({ failure: { ...FAILURE, notPlannedYet: LINES.slice(0, 3) } }));
    const list = screen.getByTestId('not-planned-yet');
    expect(itemsOf(list)).toEqual(LINES.slice(0, 3));
    expect(list.parentElement?.getAttribute('role')).toBe('cell');
    expect(screen.queryByTestId('not-planned-yet-more')).toBeNull();
  });

  it('holds a long list back to the first two and a count line, above the also-waiting line', () => {
    mountEntry(
      entry({
        failure: { ...FAILURE, notPlannedYet: LINES },
        waitingPlan: { planId: 'p2', title: 'Waiting plan', status: 'planned' },
      }),
    );
    const list = screen.getByTestId('not-planned-yet');
    expect(itemsOf(list)).toEqual(LINES.slice(0, 2));
    expect(screen.getByTestId('not-planned-yet-more').textContent).toContain('3 more items');
    const also = screen.getByTestId('to-resume-also-waiting');
    expect(list.compareDocumentPosition(also) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders as before without lines', () => {
    const before = mountEntry(entry()).container.innerHTML;
    cleanup();
    const after = mountEntry(entry({ failure: { ...FAILURE, notPlannedYet: [] } })).container
      .innerHTML;
    expect(after).toBe(before);
    expect(screen.queryByTestId('not-planned-yet')).toBeNull();
  });
});

// ── the Plans session row ────────────────────────────────────────────────────

function view(failure: SessionRowView['failure']): SessionRowView {
  return {
    id: 's_1',
    origin: 'conversation',
    title: 'Plan for Billing',
    targetKeys: ['ACME-30'],
    activeLabel: '12 minutes ago',
    startedByName: 'Mara Lind',
    latestPlan: { id: 'p_31', status: 'planned' },
    planCount: 1,
    seed: null,
    state: 'waiting',
    failure,
    end: null,
    copiedFrom: null,
  };
}

const WALK: NonNullable<SessionRowView['failure']> = {
  kind: 'walk',
  reason: 'job_failed',
  stopPhase: 'author',
  stopTitle: 'Send invoice reminders',
  timeLabel: '5 minutes ago',
  fullLabel: 'Nov 2, 2026, 12:00 AM',
};

describe('Plans — the session row', () => {
  it('shows the lines under the meta line, inside the row’s text column', () => {
    renderWithIntl(<SessionRow view={view({ ...WALK, notPlannedYet: LINES.slice(0, 1) })} />);
    const list = screen.getByTestId('not-planned-yet');
    expect(itemsOf(list)).toEqual(LINES.slice(0, 1));
    const meta = list.previousElementSibling;
    expect(within(meta as HTMLElement).getByTestId('plans-stop-line')).toBeTruthy();
    expect(list.parentElement?.className).toContain('min-w-0 flex-1');
  });

  it('holds a long list back behind the count line', () => {
    renderWithIntl(<SessionRow view={view({ ...WALK, notPlannedYet: LINES })} />);
    expect(itemsOf(screen.getByTestId('not-planned-yet'))).toEqual(LINES.slice(0, 2));
    expect(screen.getByTestId('not-planned-yet-more').textContent).toContain('3 more items');
  });

  it('draws no list for a failure beside a waiting plan (`change`), which has no stop line', () => {
    renderWithIntl(<SessionRow view={view({ ...WALK, kind: 'change', notPlannedYet: LINES })} />);
    expect(screen.queryByTestId('not-planned-yet')).toBeNull();
  });

  it('renders as before without lines', () => {
    const before = renderWithIntl(<SessionRow view={view(WALK)} />).container.innerHTML;
    cleanup();
    const after = renderWithIntl(<SessionRow view={view({ ...WALK, notPlannedYet: [] })} />)
      .container.innerHTML;
    expect(after).toBe(before);
  });
});
