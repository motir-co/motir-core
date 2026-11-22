// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// The plan links are plan-overlay doors (Story MOTIR-7883 · MOTIR-7890).
const { push, shallowPush } = vi.hoisted(() => ({ push: vi.fn(), shallowPush: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/runs/run_1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { RunFindings } = await import('@/app/(authed)/runs/_components/RunFindings');
import type { DispatchRunEventDto } from '@/lib/dto/dispatchRuns';

// WHAT THE RUN PRODUCED, on the surface (Story MOTIR-1789 · MOTIR-3983).
//
// ⚠️ THE ABSENT CASE IS THE FIRST ASSERTION, not the last. Most runs file no bug
// and submit no plan, so a strip that is present and empty on every ordinary run
// teaches a reader to skip exactly the place the rare thing appears — and that
// failure renders perfectly, which is why it needs a test rather than an eye.

const fetchMock = vi.fn();
beforeEach(() => {
  push.mockReset();
  shallowPush.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ status: 'planned', conversation: { sessionId: 's_8c', targetKeys: [] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ev(
  over: Partial<DispatchRunEventDto> & { kind: string; seq: number },
): DispatchRunEventDto {
  return {
    id: `e${over.seq}`,
    cardId: 'leg_1',
    data: null,
    body: null,
    createdAt: '2026-08-30T14:02:00.000Z',
    ...over,
  } as DispatchRunEventDto;
}

const bug = (seq: number, key: string | null, title: string | null) =>
  ev({ kind: 'bug_filed', seq, data: { key, workItemId: 'wi', title } });
const submitted = (seq: number, planId: string | null, proposalCount: number | null) =>
  ev({ kind: 'plan_submitted', seq, data: { planId, proposalCount } });
const approved = (seq: number, planId: string, key: string, proposalCount: number) =>
  ev({ kind: 'plan_approved', seq, data: { planId, key, proposalCount } });

describe('⚠️ a run that produced NEITHER grows no region at all', () => {
  it('renders nothing for an empty stream', () => {
    const { container } = render(<RunFindings events={[]} cards={[]} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('run-findings')).toBeNull();
  });

  it('renders nothing for a run whose events are all ordinary lifecycle', () => {
    const { container } = render(
      <RunFindings
        events={[ev({ kind: 'card_settled', seq: 1 }), ev({ kind: 'log', seq: 2 })]}
        cards={[]}
      />,
    );
    // Not an empty box, not a heading — NOTHING. The log starts at the top.
    expect(container.innerHTML).toBe('');
  });
});

describe('the PLAN in its two states, which must not look alike', () => {
  it('a SUBMITTED plan is an ASK: it says it is waiting and offers the review', async () => {
    render(<RunFindings events={[submitted(3, 'pln_8c41', 6)]} cards={[]} />);
    await act(async () => {});

    const row = screen.getByTestId('finding-plan-submitted');
    expect(row.textContent).toContain('Plan submitted');
    expect(row.textContent).toContain('6 proposals');
    expect(row.textContent).toContain('waiting for you');
    // The door resolves the plan NOW: an undecided one opens the overlay in place.
    const link = screen.getByRole('link', { name: 'Review →' });
    const overlay = withPlanningOverlay('/runs/run_1', { kind: 'project', sessionId: 's_8c' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(link.getAttribute('href')).toBe(overlay);
    expect(fireEvent.click(link, { button: 0 })).toBe(false);
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(overlay);
    expect(push).not.toHaveBeenCalled();
    // A ⌘-click is the browser's.
    const meta = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    act(() => {
      link.dispatchEvent(meta);
    });
    expect(meta.defaultPrevented).toBe(false);
  });

  it('an APPROVED plan is NEWS: no waiting language, and named plan by plan', () => {
    render(
      <RunFindings
        events={[approved(4, 'pln_a077', 'MOTIR-1793', 2), approved(5, 'pln_b12', 'MOTIR-1801', 3)]}
        cards={[]}
      />,
    );

    const row = screen.getByTestId('finding-plan-approved');
    expect(row.textContent).toContain('your tree changed while you were away');
    expect(row.textContent).not.toContain('waiting for you');
    // ⚠️ NAMED PLAN BY PLAN, never a count — `autoLoop.ts` settled that, and a
    // count would tell an operator their tree moved without telling them where.
    expect(row.textContent).toContain('pln_a077');
    expect(row.textContent).toContain('MOTIR-1793');
    expect(row.textContent).toContain('pln_b12');
    expect(row.textContent).toContain('MOTIR-1801');
    // `plan_approved` IS the fact that the plan is decided: its page, and no read.
    expect(screen.getByRole('link', { name: 'pln_a077' }).getAttribute('href')).toBe(
      '/plans/pln_a077',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the two are DIFFERENT rows — an ask never wears the news face', () => {
    render(
      <RunFindings
        events={[submitted(1, 'pln_1', 1), approved(2, 'pln_2', 'MOTIR-9', 1)]}
        cards={[]}
      />,
    );
    expect(screen.getByTestId('finding-plan-submitted')).toBeTruthy();
    expect(screen.getByTestId('finding-plan-approved')).toBeTruthy();
  });
});

describe('the BUGS — separate rows, each one reachable', () => {
  it('shows one bug, with a link to it', () => {
    render(<RunFindings events={[bug(2, 'MOTIR-3991', 'Prisma generate fails')]} cards={[]} />);

    const row = screen.getByTestId('finding-bug');
    expect(row.textContent).toContain('MOTIR-3991');
    expect(row.textContent).toContain('Prisma generate fails');
    expect(screen.getByRole('link', { name: 'Open →' }).getAttribute('href')).toBe(
      '/items/MOTIR-3991',
    );
  });

  it('⚠️ SEVERAL from one run stay several rows — never "3 bugs"', () => {
    render(
      <RunFindings
        events={[
          bug(1, 'MOTIR-1', 'first'),
          bug(2, 'MOTIR-2', 'second'),
          bug(3, 'MOTIR-3', 'third'),
        ]}
        cards={[]}
      />,
    );

    expect(screen.getAllByTestId('finding-bug')).toHaveLength(3);
    expect(screen.getAllByRole('link', { name: 'Open →' })).toHaveLength(3);
  });
});

describe('⚠️ it renders ONLY what the record carries', () => {
  it('a bug whose event has no title shows no title, and invents none', () => {
    render(<RunFindings events={[bug(1, 'MOTIR-3991', null)]} cards={[]} />);
    const row = screen.getByTestId('finding-bug');
    expect(row.textContent).toContain('MOTIR-3991');
    // The em-dash separator only appears WITH a title.
    expect(row.textContent).not.toContain('—');
  });

  it('a finding whose TARGET the record cannot name renders, with no link', () => {
    // The gone case: drawn from `data` alone. It must not be dropped (that would
    // say the run found nothing) and must not link nowhere.
    render(<RunFindings events={[bug(1, null, 'A defect somebody later deleted')]} cards={[]} />);

    const row = screen.getByTestId('finding-bug');
    expect(row.textContent).toContain('A defect somebody later deleted');
    expect(screen.queryByRole('link', { name: 'Open →' })).toBeNull();
  });

  it('a submitted plan with no plan id renders the fact and offers no review link', () => {
    render(<RunFindings events={[submitted(1, null, 4)]} cards={[]} />);
    expect(screen.getByTestId('finding-plan-submitted').textContent).toContain('Plan submitted');
    expect(screen.queryByRole('link', { name: 'Review →' })).toBeNull();
  });

  it('a malformed `data` payload does not crash the strip', () => {
    render(
      <RunFindings
        events={[
          ev({ kind: 'bug_filed', seq: 1, data: 'not an object' }),
          ev({ kind: 'plan_submitted', seq: 2, data: { planId: 42, proposalCount: 'six' } }),
        ]}
        cards={[]}
      />,
    );
    // Both rows still render; neither invents a value from a wrong type.
    expect(screen.getByTestId('finding-bug')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Review →' })).toBeNull();
  });
});

describe('the order is the RUN’s', () => {
  it('sorts by seq, not by arrival', () => {
    render(
      <RunFindings
        events={[bug(9, 'MOTIR-LATE', 'later'), bug(2, 'MOTIR-EARLY', 'earlier')]}
        cards={[]}
      />,
    );
    const strip = screen.getByTestId('run-findings');
    expect(strip.textContent!.indexOf('earlier')).toBeLessThan(strip.textContent!.indexOf('later'));
  });
});

describe('a DISCREPANCY the run recorded (MOTIR-8659 · design § A DISCREPANCY)', () => {
  const legs = [
    { id: 'leg_1', key: 'MOTIR-100' },
    { id: 'leg_2', key: 'MOTIR-200' },
  ];
  const discrepancy = (seq: number, cardId: string, data: unknown) =>
    ev({ kind: 'discrepancy_recorded', seq, cardId, data });

  it('renders the label, the leg’s key and the plural count, with a door to its section', () => {
    render(
      <RunFindings
        events={[
          discrepancy(1, 'leg_1', { recordId: 'r1', pointCount: 3, dispatchRunCardId: 'leg_1' }),
        ]}
        cards={legs}
      />,
    );
    const row = screen.getByTestId('finding-discrepancy');
    expect(row.textContent).toContain('Built differently');
    expect(row.textContent).toContain('MOTIR-100');
    expect(row.textContent).toContain('3 points');
    const door = screen.getByRole('link', { name: 'Open →' });
    // MOTIR-11996: the door lands on the card's Run discrepancy section.
    expect(door.getAttribute('href')).toBe('/items/MOTIR-100#run-discrepancy');
  });

  it('uses the singular for one point', () => {
    render(<RunFindings events={[discrepancy(1, 'leg_1', { pointCount: 1 })]} cards={legs} />);
    expect(screen.getByTestId('finding-discrepancy').textContent).toContain('1 point');
    expect(screen.getByTestId('finding-discrepancy').textContent).not.toContain('1 points');
  });

  it('a missing or non-numeric pointCount shows no count, never "0 points"', () => {
    render(
      <RunFindings
        events={[discrepancy(1, 'leg_1', {}), discrepancy(2, 'leg_2', { pointCount: 'three' })]}
        cards={legs}
      />,
    );
    const rows = screen.getAllByTestId('finding-discrepancy');
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.textContent).not.toMatch(/point/);
  });

  it('a leg that is not on the run keeps the row but offers no door', () => {
    render(<RunFindings events={[discrepancy(1, 'leg_gone', { pointCount: 2 })]} cards={legs} />);
    expect(screen.getByTestId('finding-discrepancy').textContent).toContain('Built differently');
    expect(screen.queryByRole('link', { name: 'Open →' })).toBeNull();
  });

  it('a parent run shows one row per leg, each naming its own key, in seq order', () => {
    render(
      <RunFindings
        events={[
          discrepancy(5, 'leg_2', { pointCount: 2 }),
          discrepancy(2, 'leg_1', { pointCount: 1 }),
        ]}
        cards={legs}
      />,
    );
    const rows = screen.getAllByTestId('finding-discrepancy');
    expect(rows[0]!.textContent).toContain('MOTIR-100');
    expect(rows[1]!.textContent).toContain('MOTIR-200');
  });

  it('sits after the approved plans and before the bugs, below the ask', () => {
    render(
      <RunFindings
        events={[
          bug(1, 'MOTIR-9', 'a bug'),
          discrepancy(2, 'leg_1', { pointCount: 3 }),
          approved(3, 'pln_2', 'MOTIR-9', 1),
          submitted(4, 'pln_1', 1),
        ]}
        cards={legs}
      />,
    );
    const ids = Array.from(
      screen.getByTestId('run-findings').querySelectorAll('[data-testid^="finding-"]'),
    ).map((n) => n.getAttribute('data-testid'));
    expect(ids).toEqual([
      'finding-plan-submitted',
      'finding-plan-approved',
      'finding-discrepancy',
      'finding-bug',
    ]);
  });

  it('shows only the pointer: no point text appears', () => {
    render(
      <RunFindings
        events={[
          discrepancy(1, 'leg_1', { recordId: 'r1', pointCount: 1, planAsked: 'SECRET-ASKED' }),
        ]}
        cards={legs}
      />,
    );
    expect(screen.getByTestId('run-findings').textContent).not.toContain('SECRET-ASKED');
  });
});
