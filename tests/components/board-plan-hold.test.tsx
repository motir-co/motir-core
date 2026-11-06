// @vitest-environment happy-dom
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// THE BOARD SHOWS A PLAN HOLD ON THE ITEM (Story MOTIR-6017 · MOTIR-6268;
// `design/boards/design-notes.md` § _⭐ The board refuses ON THE CARD while a PLAN
// holds it_, `board--plan-hold.mock.html`). Up front: one shell per held item with
// its plan footer door, the sibling outline on a footer's hover / focus. On a
// refused drag: the item returns and the refusal opens IN ITS OWN FOOTER.
//
// A dnd-kit drag cannot be driven by pointer in happy-dom (nothing has a layout),
// so the board's OWN drag handlers are driven: `DndContext` is wrapped to capture
// the props BoardContainer hands it, and the test calls `onDragStart` /
// `onDragOver` / `onDragEnd` exactly as dnd-kit would on a drop onto a column.

/** The three board handlers a drop drives, as dnd-kit would call them. */
interface DragHandlers {
  onDragStart: (event: unknown) => void;
  onDragOver: (event: unknown) => void;
  onDragEnd: (event: unknown) => void;
}

const { toastSpy, dnd } = vi.hoisted(() => ({
  toastSpy: vi.fn(),
  dnd: { props: null as null | DragHandlers },
}));

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  function CapturingDndContext(props: ComponentProps<typeof actual.DndContext>) {
    dnd.props = props as unknown as DragHandlers;
    return <actual.DndContext {...props} />;
  }
  return { ...actual, DndContext: CapturingDndContext };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/boards',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({
    open: false,
    setOpen: vi.fn(),
    openCreateIssue: vi.fn(),
    canCreate: true,
    issuesChangedAt: 0,
  }),
  useNotifyIssuesChanged: () => () => {},
}));
vi.spyOn(window.history, 'pushState').mockImplementation(() => {});

import { BoardContainer } from '@/app/(authed)/boards/_components/BoardContainer';
import { BoardCardOverlay } from '@/app/(authed)/boards/_components/BoardCard';
import { BoardHeldRefusalProvider } from '@/app/(authed)/boards/_components/BoardHeldRefusal';
import { planRowDestination } from '@/lib/planning/planDestination';
import type { BoardCardDto, BoardColumnDto, BoardProjectionDto } from '@/lib/dto/boards';
import type { PlanHeldByPlanDTO } from '@/lib/dto/plans';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  dnd.props = null;
});

function hold(
  over: Partial<PlanHeldByPlanDTO> & { itemKey: string; workItemId: string },
): PlanHeldByPlanDTO {
  return {
    kind: 'plan',
    planId: 'pln_a',
    planStatus: 'planned',
    sessionId: 'pcs_a',
    anchorKey: 'PROD-10',
    ...over,
  };
}

function card(over: Partial<BoardCardDto> & { id: string; key: number }): BoardCardDto {
  return {
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    identifier: `PROD-${over.key}`,
    title: `Card ${over.key}`,
    status: 'planning',
    ciState: null,
    fixReason: null,
    obsolescence: null,
    statusCategory: 'todo',
    priority: 'medium',
    assigneeId: null,
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    position: `a${over.key}`,
    ready: true,
    readyToStart: false,
    statusLabel: 'To Do',
    hasChildren: false,
    type: null,
    executor: null,
    pendingDecision: null,
    planHold: null,
    ...over,
  };
}

function column(over: Partial<BoardColumnDto> & { id: string; name: string }): BoardColumnDto {
  return {
    position: 'a0',
    wipLimit: null,
    statusKeys: ['planning'],
    cards: [],
    totalCount: over.cards?.length ?? 0,
    cursor: null,
    ...over,
  };
}

// Panel 1: plan A holds PROD-1 and PROD-3 on the board (and a third item elsewhere
// in the project — the count is the server's), plan B (no session, no anchor)
// holds PROD-2, and PROD-4 is held by no plan.
const planA1 = hold({ itemKey: 'PROD-1', workItemId: 'w1' });
const planB2 = hold({
  itemKey: 'PROD-2',
  workItemId: 'w2',
  planId: 'pln_b',
  planStatus: 'stale',
  sessionId: null,
  anchorKey: null,
});
const planA3 = hold({ itemKey: 'PROD-3', workItemId: 'w3' });

const projection: BoardProjectionDto = {
  boardId: 'b1',
  name: 'Default',
  type: 'kanban',
  swimlaneGroupBy: 'none',
  swimlanes: [],
  unmappedStatuses: [],
  cap: 5000,
  truncated: false,
  sprint: null,
  planHolds: {
    pln_a: {
      kind: 'plan',
      planId: 'pln_a',
      sessionId: null,
      anchorKey: 'PROD-10',
      title: 'Import',
      heldCount: 3,
    },
    pln_b: {
      kind: 'plan',
      planId: 'pln_b',
      sessionId: null,
      anchorKey: null,
      title: 'Saved views',
      heldCount: 1,
    },
  },
  columns: [
    column({
      id: 'c1',
      name: 'Planning',
      cards: [
        card({ id: 'w1', key: 1, planHold: planA1 }),
        card({ id: 'w2', key: 2, planHold: planB2 }),
        card({ id: 'w3', key: 3, planHold: planA3 }),
        card({ id: 'w4', key: 4 }),
      ],
    }),
    column({ id: 'c2', name: 'In Progress', statusKeys: ['in_progress'] }),
  ],
};

/** GET /api/board answers the projection; POST /api/board/move answers `move`. */
function stubFetch(move: { status: number; body: unknown }) {
  const fetchSpy = vi.fn(async (url: string) => {
    if (url.startsWith('/api/board/move')) {
      return new Response(JSON.stringify(move.body), {
        status: move.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return { ok: true, status: 200, json: async () => projection };
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

async function renderBoard() {
  render(<BoardContainer projectName="Motir" />);
  await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
}

/** Drop `activeId` onto column `overId`, the way dnd-kit calls the board. */
async function dragOnto(activeId: string, overId: string) {
  act(() => dnd.props!.onDragStart({ active: { id: activeId } }));
  act(() => dnd.props!.onDragOver({ active: { id: activeId }, over: { id: overId } }));
  await act(async () => {
    dnd.props!.onDragEnd({ active: { id: activeId }, over: { id: overId } });
  });
  // The move's fetch + body read settle.
  await act(async () => {});
}

const shellOf = (key: string) =>
  screen.getByTestId(`board-card-${key}`).closest<HTMLElement>('[data-plan-shell]');
const footerOf = (key: string) => shellOf(key)!.querySelector<HTMLElement>('[data-plan-footer]')!;
const outlined = () =>
  [...document.querySelectorAll<HTMLElement>('[data-plan-outlined]')].map((el) =>
    el.querySelector('[data-testid^="board-card-"]')!.getAttribute('data-testid'),
  );
const columnOf = (key: string) =>
  screen.getByTestId(`board-card-${key}`).closest('[data-board-column]');

describe('the plan hold, up front — before any drag', () => {
  it('draws a footer door on every held item, where planRowDestination sends the plan; none on the un-held one', async () => {
    stubFetch({ status: 200, body: {} });
    await renderBoard();

    const a1 = footerOf('PROD-1');
    expect(a1.tagName).toBe('A');
    expect(a1.textContent).toContain('Plan · PROD-10');
    expect(a1.textContent).toContain('Review plan');
    expect(a1.getAttribute('href')).toBe(planRowDestination({ ...planA1, host: '/boards' }).href);
    expect(a1.getAttribute('title')).toBe('This plan is waiting for approval.');
    // The door is a SIBLING of the drag button, never inside it.
    expect(screen.getByTestId('board-card-PROD-1').contains(a1)).toBe(false);

    // Plan B has no session → the plan page; no anchor → its title names it.
    const b2 = footerOf('PROD-2');
    expect(b2.getAttribute('href')).toBe('/plans/pln_b');
    expect(b2.textContent).toContain('Plan · Saved views');
    expect(b2.getAttribute('title')).toBe('This plan needs attention before it can be approved.');

    // The same words on every item of a plan — the grouping is by NAME.
    expect(footerOf('PROD-3').textContent).toBe(a1.textContent);

    // PROD-4 is held by no plan: no shell, no footer.
    expect(shellOf('PROD-4')).toBeNull();
    expect(document.querySelectorAll('[data-plan-footer]')).toHaveLength(3);
  });

  it('hover or focus of a footer outlines exactly the items of that plan; the card body does not', async () => {
    stubFetch({ status: 200, body: {} });
    await renderBoard();
    expect(outlined()).toEqual([]);

    fireEvent.mouseEnter(footerOf('PROD-1'));
    expect(outlined()).toEqual(['board-card-PROD-1', 'board-card-PROD-3']);
    fireEvent.mouseLeave(footerOf('PROD-1'));
    expect(outlined()).toEqual([]);

    fireEvent.focus(footerOf('PROD-2'));
    expect(outlined()).toEqual(['board-card-PROD-2']);
    fireEvent.blur(footerOf('PROD-2'));
    expect(outlined()).toEqual([]);

    fireEvent.mouseEnter(screen.getByTestId('board-card-PROD-1'));
    expect(outlined()).toEqual([]);
  });
});

describe('the refused drag — 409 PLAN_TARGET_HELD', () => {
  it('returns the item and opens the refusal IN ITS OWN FOOTER with the sibling count — no toast, siblings outlined', async () => {
    const fetchSpy = stubFetch({
      status: 409,
      body: { code: 'PLAN_TARGET_HELD', error: 'held', plan: planA1 },
    });
    await renderBoard();

    await dragOnto('w1', 'c2');
    expect(fetchSpy).toHaveBeenCalledWith('/api/board/move', expect.anything());

    // Sprung back into Planning.
    expect(columnOf('PROD-1')).toBe(columnOf('PROD-4'));
    expect(toastSpy).not.toHaveBeenCalled();

    const shell = shellOf('PROD-1')!;
    const open = shell.querySelector<HTMLElement>('[data-board-held]')!;
    expect(open).toBeTruthy();
    expect(open.textContent).toContain('Plan · PROD-10');
    expect(open.textContent).toContain('2 other items on this board are in this plan.');
    expect(open.textContent).toContain("Status can't be changed while a plan is open.");
    expect(open.textContent).toContain('This plan is waiting for approval.');
    // The resting door gave way to the refusal; its OWN door carries focus.
    expect(shell.querySelector('a[data-plan-footer]')).toBeNull();
    const door = screen.getByRole('link', { name: 'Review plan' });
    expect(open.contains(door)).toBe(true);
    expect(door.getAttribute('href')).toBe(planRowDestination({ ...planA1, host: '/boards' }).href);
    expect(document.activeElement).toBe(door);
    expect(shell.className).toContain('shadow-(--shadow-elevated)');

    // Every item of the plan is outlined while it is open — the other plan is not.
    expect(outlined()).toEqual(['board-card-PROD-1', 'board-card-PROD-3']);

    expect(screen.getByTestId('board-held-announcement').textContent).toBe(
      "PROD-1 returned. It is held by Plan · PROD-10. Status can't be changed while a plan is open. This plan is waiting for approval. 2 other items on this board are in this plan.",
    );

    // Esc closes it: the resting door returns and the outlines go with it.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(shell.querySelector('[data-board-held]')).toBeNull();
    expect(shell.querySelector('a[data-plan-footer]')).toBeTruthy();
    expect(outlined()).toEqual([]);
  });

  it('the next drag start closes it', async () => {
    stubFetch({ status: 409, body: { code: 'PLAN_TARGET_HELD', error: 'held', plan: planA1 } });
    await renderBoard();
    await dragOnto('w1', 'c2');
    expect(document.querySelector('[data-board-held]')).toBeTruthy();
    act(() => dnd.props!.onDragStart({ active: { id: 'w3' } }));
    expect(document.querySelector('[data-board-held]')).toBeNull();
  });
});

describe('every other refusal behaves as before', () => {
  it('APPROVAL_GATE_PENDING draws the gate line under the card, not in a footer', async () => {
    stubFetch({
      status: 409,
      body: {
        code: 'APPROVAL_GATE_PENDING',
        error: 'held',
        gate: {
          itemKey: 'PROD-4',
          kind: 'design_result',
          waitingOn: 'decision',
          gateRaised: true,
          canDecide: true,
          routedToLabel: null,
        },
      },
    });
    await renderBoard();
    await dragOnto('w4', 'c2');

    expect(toastSpy).not.toHaveBeenCalled();
    const heldLine = document.querySelector<HTMLElement>('[data-board-held]')!;
    expect(heldLine.textContent).toContain(
      "Status can't be moved to In Progress directly — a design approval is waiting.",
    );
    expect(heldLine.closest('[data-plan-shell]')).toBeNull();
    expect(outlined()).toEqual([]);
    expect(screen.getByTestId('board-held-announcement').textContent).toContain('PROD-4 returned.');
  });

  it('ILLEGAL_BOARD_MOVE and UNMAPPED_COLUMN_TARGET snap back with the toast', async () => {
    stubFetch({ status: 409, body: { code: 'ILLEGAL_BOARD_MOVE', error: 'no' } });
    await renderBoard();
    await dragOnto('w1', 'c2');
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'error',
        description: expect.stringContaining('PROD-1'),
      }),
    );
    expect(document.querySelector('[data-board-held]')).toBeNull();
    expect(columnOf('PROD-1')).toBe(columnOf('PROD-4'));
    cleanup();
    toastSpy.mockClear();

    stubFetch({ status: 422, body: { code: 'UNMAPPED_COLUMN_TARGET', error: 'no' } });
    await renderBoard();
    await dragOnto('w4', 'c2');
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'error',
        description: expect.stringContaining('PROD-4'),
      }),
    );
    expect(document.querySelector('[data-board-held]')).toBeNull();
  });
});

describe('the lifted clone', () => {
  it('carries its plan footer INERT — the name, no link, no door', () => {
    render(
      <BoardHeldRefusalProvider
        value={{ held: null, close: () => {}, planHolds: projection.planHolds }}
      >
        <BoardCardOverlay card={card({ id: 'w1', key: 1, planHold: planA1 })} assigneeName={null} />
      </BoardHeldRefusalProvider>,
    );
    const inert = document.querySelector<HTMLElement>('[data-plan-footer-inert]')!;
    expect(inert.textContent).toBe('Plan · PROD-10');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

// Story MOTIR-6575 · MOTIR-6682 — a MARKED card dragged out of the done category.
describe('the refused drag — 409 MARKED_CARD_CANNOT_REOPEN (MOTIR-6682)', () => {
  it('returns the card and opens the mark’s one line UNDER it, announced — no toast', async () => {
    stubFetch({
      status: 409,
      body: {
        code: 'MARKED_CARD_CANNOT_REOPEN',
        error: 'marked',
        key: 'PROD-4',
        mark: 'outdated',
      },
    });
    await renderBoard();
    await dragOnto('w4', 'c2');

    expect(toastSpy).not.toHaveBeenCalled();
    const held = document.querySelector<HTMLElement>('[data-board-held]')!;
    expect(held.textContent).toContain(
      'This item is marked Outdated. Clear the mark to reopen this item.',
    );
    expect(held.closest('[data-plan-shell]')).toBeNull();
    expect(held.querySelector('[data-mark-door="open-item"]')!.getAttribute('href')).toBe(
      '/items/PROD-4#obsolescence-field',
    );
    // Sprung back into its own column, beside the card it left.
    expect(columnOf('PROD-4')).toBe(columnOf('PROD-1'));
    expect(screen.getByTestId('board-held-announcement').textContent).toBe(
      'PROD-4 returned. This item is marked Outdated. Clear the mark to reopen this item.',
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-board-held]')).toBeNull();
  });
});
