// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// A CARD IN THE TO PLAN STATUS ON THE ROADMAP CANVAS (MOTIR-12234).
//
// MOTIR-10139 added the workflow status `to_plan` (in the `in_progress` category):
// a corrected decision moves the not-started work planned against it there, and it
// has to be planned again. The canvas's Plan button keyed only on the COMPUTED To
// plan (`isToPlanItem`: a childless `todo` story or epic), so such a card — any
// kind, children or none — fell through every row and offered nothing. It now
// takes the To plan row: the Plan button when it is not held, and the shared
// blocked tag a held To do story wears when it is (`isPlanHeld`, MOTIR-11546), its
// To plan status chip kept in the slot either way. What it pins:
//   · a non-held `to_plan` story WITH children offers Plan, and opens as a RE-PLAN;
//   · a held `to_plan` story wears the blocked tag and no Plan button;
//   · a `to_plan` leaf offers Plan and opens as a fresh plan;
//   · the gates: a Visitor (no options) and a project with no AI get no button;
//   · the To plan row beats fix, review and ready for a `to_plan` card;
//   · the status chip stays — no To plan pill, no yellow wash.
const pathname = '/roadmap';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams('scope=project'),
}));
const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/navigation/shallowUrl')>()),
  shallowPush,
}));

const { WorkItemNode, cardNextAction } = await import('@/components/planning/WorkItemNode');
const { withPlanningOverlay } = await import('@/lib/planning/launcher');
type WorkItemNodeData = import('@/components/planning/WorkItemNode').WorkItemNodeData;

afterEach(() => {
  cleanup();
  shallowPush.mockClear();
  vi.unstubAllGlobals();
});

const ON = { plan: true } as const;

/** A story in the To plan status that was planned once: it has subtasks. */
const replanStory: WorkItemNodeData = {
  id: 'S1',
  identifier: 'MOTIR-12234',
  title: 'Export a sprint report as a PDF the team can attach to a retro',
  kind: 'story',
  status: 'to_plan',
  statusLabel: 'To plan',
  statusCategory: 'in_progress',
  hasChildren: true,
  planHeld: false,
};

const heldStory: WorkItemNodeData = { ...replanStory, id: 'S2', planHeld: true };

const leaf: WorkItemNodeData = {
  id: 'T1',
  identifier: 'MOTIR-12235',
  title: 'Render the sprint report PDF',
  kind: 'task',
  status: 'to_plan',
  statusLabel: 'To plan',
  statusCategory: 'in_progress',
  type: 'code',
  executor: 'coding_agent',
  hasChildren: false,
  planHeld: false,
};

function frame(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-node-state]') as HTMLElement;
}
function nextAction(): HTMLElement | null {
  return screen.queryByTestId('node-next-action');
}

/** Press the Plan button on a plannable answer and return the overlay it opened. */
async function pressPlan(): Promise<void> {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ plannable: true, reasons: [] }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    fireEvent.click(nextAction()!, { button: 0 });
  });
  // The same pre-open check as today's button: one plannability read, then open.
  expect(fetchMock).toHaveBeenCalledTimes(1);
}

describe('cardNextAction — the To plan row for a held card (MOTIR-12234)', () => {
  const base = {
    kind: 'story',
    toPlan: true,
    fixReason: null,
    status: 'to_plan',
    ready: false,
    manual: false,
    options: ON,
  } as const;

  it('a To plan card that is not held offers Plan', () => {
    expect(cardNextAction({ ...base, planHeld: false })).toEqual({ kind: 'plan' });
    expect(cardNextAction(base)).toEqual({ kind: 'plan' });
  });

  it('a held To plan card draws no button, and no lower row stands in for Plan', () => {
    expect(cardNextAction({ ...base, planHeld: true })).toBeNull();
    expect(cardNextAction({ ...base, planHeld: true, fixReason: 'ci_failed' })).toBeNull();
    expect(cardNextAction({ ...base, planHeld: true, ready: true })).toBeNull();
  });
});

describe('a card in the To plan status on the roadmap canvas', () => {
  it('a non-held story with children offers Plan, and opens as a re-plan of that card', async () => {
    const { container } = render(<WorkItemNode item={replanStory} nextActions={ON} />);
    const button = nextAction()!;
    expect(button.getAttribute('data-action')).toBe('plan');
    expect(button.getAttribute('aria-label')).toBe('Plan MOTIR-12234');
    // The status chip stays: no To plan pill and no yellow wash.
    expect(screen.queryByTestId('to-plan-pill')).toBeNull();
    expect(frame(container).getAttribute('data-node-state')).toBe('normal');
    expect(container.querySelector('[data-status="to_plan"]')?.textContent).toContain('To plan');
    expect(screen.queryByTestId('cross-blocked-flag')).toBeNull();

    await pressPlan();
    expect(shallowPush).toHaveBeenCalledWith(
      withPlanningOverlay('/roadmap?scope=project', {
        kind: 'work-item',
        itemKey: 'MOTIR-12234',
        hasPlan: true,
        confirmStart: true,
      }),
    );
  });

  it('a held story wears the shared blocked tag beside its To plan chip, and no Plan button', () => {
    const { container } = render(<WorkItemNode item={heldStory} nextActions={ON} />);
    expect(nextAction()).toBeNull();
    const flag = screen.getByTestId('cross-blocked-flag');
    expect(flag.getAttribute('aria-label')).toBe('Blocked');
    expect(flag.textContent).toBe('blocked');
    // The give-way rule: the right-hand tag drops the slot's chip to its glyph,
    // exactly as on a held To do story — and it is still the To plan chip.
    const chip = container.querySelector<HTMLElement>('[data-status="to_plan"]');
    expect(chip?.getAttribute('role')).toBe('img');
    expect(chip?.getAttribute('aria-label')).toBe('To plan');
    expect(screen.queryByTestId('to-plan-pill')).toBeNull();
  });

  it('a held story already blocked elsewhere keeps only its red flag', () => {
    render(<WorkItemNode item={heldStory} crossBlocked nextActions={ON} />);
    expect(screen.getAllByTestId('blocked-tab')).toHaveLength(1);
    expect(screen.queryByTestId('cross-blocked-flag')).toBeNull();
    expect(nextAction()).toBeNull();
  });

  it('a leaf offers Plan, and opens as a fresh plan', async () => {
    render(<WorkItemNode item={leaf} nextActions={ON} />);
    expect(nextAction()?.getAttribute('data-action')).toBe('plan');
    await pressPlan();
    expect(shallowPush).toHaveBeenCalledWith(
      withPlanningOverlay('/roadmap?scope=project', {
        kind: 'work-item',
        itemKey: 'MOTIR-12235',
        hasPlan: false,
        confirmStart: true,
      }),
    );
  });

  it('a Visitor gets no button', () => {
    render(<WorkItemNode item={replanStory} nextActions={null} />);
    expect(nextAction()).toBeNull();
  });

  it('a project with no AI configured gets no Plan button', () => {
    render(<WorkItemNode item={replanStory} nextActions={{ plan: false }} />);
    expect(nextAction()).toBeNull();
  });

  it('the To plan row wins over the fix and review rows', () => {
    render(<WorkItemNode item={{ ...leaf, fixReason: 'ci_failed' }} nextActions={ON} />);
    expect(nextAction()?.getAttribute('data-action')).toBe('plan');
    cleanup();
    render(<WorkItemNode item={leaf} ready nextActions={ON} />);
    expect(nextAction()?.getAttribute('data-action')).toBe('plan');
  });
});
