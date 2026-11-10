// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '@/tests/helpers/renderWithIntl';
import type { PlanStatusDto, WorkItemPlanHistoryEntryDto } from '@/lib/dto/plans';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { PlanHistorySection } from '@/app/(authed)/items/[key]/_components/PlanHistorySection';

// MOTIR-5547 — the PLAN HISTORY section, per design/work-items/plan-history.mock.html
// + design-notes § "Plan history" (MOTIR-5545). The sentences are asserted as the
// EXACT English the design's copy table specifies, over every status × relation,
// because a sentence claiming a change that never happened is the defect the tense
// split exists to prevent (MOTIR-4472).

const NOW = new Date('2026-09-15T12:00:00Z');

function entry(over: Partial<WorkItemPlanHistoryEntryDto> = {}): WorkItemPlanHistoryEntryDto {
  return {
    planId: 'plan_1',
    planTitle: 'Expand the story',
    planStatus: 'approved',
    createdAt: '2026-09-13T12:00:00Z',
    plannedAt: '2026-09-13T12:00:00Z',
    decidedAt: '2026-09-13T12:00:00Z',
    decidedById: 'u1',
    decidedByName: 'Zhu Yue',
    author: { source: 'mcp', harness: 'Claude Code', model: 'claude-opus-5' },
    relation: { op: 'modify', childCount: 0 },
    proposalIds: { self: 'pi_1', children: [] },
    ...over,
  };
}

function renderSection(
  initial: Parameters<typeof PlanHistorySection>[0]['initial'],
  identifier = 'MOTIR-1',
) {
  return renderWithIntl(
    <PlanHistorySection itemId="wi_1" identifier={identifier} initial={initial} />,
    {
      now: NOW,
    },
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// `approving` (Bug MOTIR-9006) has not applied anything until it commits.
const PROPOSING: PlanStatusDto[] = ['generating', 'planned', 'approving', 'stale'];

describe('the relation sentence — total over status × relation, exact copy', () => {
  const cases: Array<{
    statuses: PlanStatusDto[];
    op: 'add' | 'modify' | 'remove' | null;
    childCount: number;
    sentence: string;
  }> = [
    // proposing
    { statuses: PROPOSING, op: 'modify', childCount: 0, sentence: 'Proposes changes to this item' },
    { statuses: PROPOSING, op: 'remove', childCount: 0, sentence: 'Proposes to archive this item' },
    {
      statuses: PROPOSING,
      op: null,
      childCount: 1,
      sentence: 'Proposes 1 work item under this item',
    },
    {
      statuses: PROPOSING,
      op: null,
      childCount: 3,
      sentence: 'Proposes 3 work items under this item',
    },
    {
      statuses: PROPOSING,
      op: 'modify',
      childCount: 2,
      sentence: 'Proposes changes to this item, and 2 work items under it',
    },
    {
      statuses: PROPOSING,
      op: 'remove',
      childCount: 1,
      sentence: 'Proposes to archive this item, and 1 work item under it',
    },
    // approved
    { statuses: ['approved'], op: 'add', childCount: 0, sentence: 'Created this item' },
    {
      statuses: ['approved'],
      op: 'add',
      childCount: 2,
      sentence: 'Created this item, and 2 work items under it',
    },
    { statuses: ['approved'], op: 'modify', childCount: 0, sentence: 'Changed this item' },
    { statuses: ['approved'], op: 'remove', childCount: 0, sentence: 'Archived this item' },
    {
      statuses: ['approved'],
      op: null,
      childCount: 5,
      sentence: 'Added 5 work items under this item',
    },
    {
      statuses: ['approved'],
      op: 'modify',
      childCount: 4,
      sentence: 'Changed this item, and added 4 work items under it',
    },
    {
      statuses: ['approved'],
      op: 'remove',
      childCount: 1,
      sentence: 'Archived this item, and added 1 work item under it',
    },
    // declined
    {
      statuses: ['declined'],
      op: 'modify',
      childCount: 0,
      sentence: 'Proposed changes to this item — not applied',
    },
    {
      statuses: ['declined'],
      op: 'remove',
      childCount: 0,
      sentence: 'Proposed to archive this item — not applied',
    },
    {
      statuses: ['declined'],
      op: null,
      childCount: 1,
      sentence: 'Proposed 1 work item under this item — not added',
    },
    {
      statuses: ['declined'],
      op: 'modify',
      childCount: 4,
      sentence: 'Proposed changes to this item, and 4 work items under it — not applied',
    },
    {
      statuses: ['declined'],
      op: 'remove',
      childCount: 2,
      sentence: 'Proposed to archive this item, and 2 work items under it — not applied',
    },
  ];

  for (const c of cases) {
    for (const status of c.statuses) {
      it(`${status} · op=${String(c.op)} · children=${c.childCount} → "${c.sentence}"`, () => {
        renderSection({
          items: [entry({ planStatus: status, relation: { op: c.op, childCount: c.childCount } })],
          nextCursor: null,
        });
        expect(screen.getByText(c.sentence)).toBeTruthy();
      });
    }
  }

  it('an `add` renders the approved sentence whatever the status — the row only exists after approve', () => {
    renderSection({
      items: [entry({ planStatus: 'planned', relation: { op: 'add', childCount: 0 } })],
      nextCursor: null,
    });
    expect(screen.getByText('Created this item')).toBeTruthy();
  });
});

describe('the row', () => {
  it('links the whole row to the plan, names its status, and falls back to Untitled plan', () => {
    renderSection({
      items: [entry({ planId: 'plan_9', planTitle: null, planStatus: 'stale' })],
      nextCursor: null,
    });
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/plans/plan_9');
    expect(within(link).getByText('Untitled plan')).toBeTruthy();
    expect(within(link).getByText('Stale')).toBeTruthy();
  });

  it('a decided plan names its decider behind the verb; a sweep-abandoned one has no name', () => {
    renderSection({
      items: [
        entry({ planId: 'a', planStatus: 'approved', decidedByName: 'Ada' }),
        entry({ planId: 'b', planStatus: 'declined', decidedByName: null, decidedById: null }),
      ],
      nextCursor: null,
    });
    expect(screen.getByText('approved 2 days ago by Ada')).toBeTruthy();
    expect(screen.getByText('declined 2 days ago')).toBeTruthy();
  });

  it('an undecided plan shows only when it was created', () => {
    renderSection({
      items: [
        entry({ planStatus: 'planned', decidedAt: null, decidedById: null, decidedByName: null }),
      ],
      nextCursor: null,
    });
    expect(screen.getByText('created 2 days ago')).toBeTruthy();
    expect(screen.queryByText(/approved|declined/)).toBeNull();
  });

  it('attributes the author: harness · model, harness alone, Motir AI, or nothing', () => {
    renderSection({
      items: [
        entry({ planId: 'a', author: { source: 'mcp', harness: 'Claude Code', model: 'opus' } }),
        entry({ planId: 'b', author: { source: 'mcp', harness: 'Cursor', model: null } }),
        entry({ planId: 'c', author: { source: 'native', harness: null, model: null } }),
        entry({
          planId: 'd',
          planTitle: 'Unattributed',
          author: { source: null, harness: null, model: null },
        }),
      ],
      nextCursor: null,
    });
    expect(screen.getByText('via Claude Code · opus')).toBeTruthy();
    expect(screen.getByText('via Cursor')).toBeTruthy();
    expect(screen.getByText('via Motir AI')).toBeTruthy();
    const unattributed = screen.getByText('Unattributed').closest('a')!;
    expect(within(unattributed).queryByText(/^via /)).toBeNull();
  });

  it('labels the list with the item key', () => {
    renderSection({ items: [entry()], nextCursor: null }, 'MOTIR-42');
    expect(screen.getByRole('list', { name: 'Plans that shaped MOTIR-42' })).toBeTruthy();
  });
});

describe('the absences', () => {
  it('renders NOTHING for a card no plan ever touched — no section, no box', () => {
    const { container } = renderSection({ items: [], nextCursor: null });
    expect(container.innerHTML).toBe('');
  });

  it('a failed first read renders the flush error line, and Try again recovers', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [entry({ planTitle: 'Recovered plan' })], nextCursor: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    renderSection('failed');
    expect(screen.getByText("Couldn't load plans.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    await waitFor(() => expect(screen.getByText('Recovered plan')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/work-items/wi_1/plans?limit=5');
    expect(screen.queryByText("Couldn't load plans.")).toBeNull();
  });
});

describe('the branches the story gate measured (MOTIR-5548)', () => {
  it('an APPROVED plan nobody decided reads "approved {when}" — no name, no placeholder', () => {
    renderSection({
      items: [entry({ planStatus: 'approved', decidedById: null, decidedByName: null })],
      nextCursor: null,
    });
    expect(screen.getByText('approved 2 days ago')).toBeTruthy();
    expect(screen.queryByText(/by Zhu Yue/)).toBeNull();
  });

  it('a first-read retry that fails AGAIN keeps the error line and a usable Try again', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    renderSection('failed');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.getByText("Couldn't load plans.")).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('Show more plans', () => {
  it('appends the next page through the route without duplicating a plan, then disappears', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderSection({
      items: [entry({ planId: 'p1', planTitle: 'First' })],
      nextCursor: 'cur_1',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show more plans' }));
    // Loading: the control is disabled and the skeleton pulses.
    expect(
      (screen.getByRole('button', { name: 'Show more plans' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/work-items/wi_1/plans?limit=20&cursor=cur_1');

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({
          // `p1` again (a plan straddling a page boundary) must not be drawn twice.
          items: [
            entry({ planId: 'p1', planTitle: 'First' }),
            entry({ planId: 'p2', planTitle: 'Second' }),
          ],
          nextCursor: null,
        }),
      });
    });

    await waitFor(() => expect(screen.getByText('Second')).toBeTruthy());
    expect(screen.getAllByText('First')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Show more plans' })).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('a failed page keeps the rows, says so, and Try again loads it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [entry({ planId: 'p2', planTitle: 'Second' })],
          nextCursor: null,
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    renderSection({ items: [entry({ planId: 'p1', planTitle: 'First' })], nextCursor: 'cur_1' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show more plans' }));
    });
    await waitFor(() => expect(screen.getByText("Couldn't load more plans.")).toBeTruthy());
    expect(screen.getByText('First')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    await waitFor(() => expect(screen.getByText('Second')).toBeTruthy());
    expect(screen.queryByText("Couldn't load more plans.")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
