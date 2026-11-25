// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// THE CHILD GRAPH'S NEXT-ACTION BUTTON (MOTIR-12233).
//
// The item page's Children section can draw its children as a graph — the shipped
// `WorkItemRoadmap` rooted at the item. Until this card only the roadmap page
// turned the card's hover button on, so neither kind of To plan child offered Plan
// here. The panel now takes the roadmap page's own gate (`canvasNextActionsFor`)
// and hands it to the canvas. Driven through the REAL panel → canvas → node chain
// with only the level read stubbed, it pins:
//   · a COMPUTED To plan child (a childless `todo` story) offers Plan, and the
//     click opens the planning overlay over this page, as on the roadmap;
//   · a child in the To plan STATUS offers Plan — a re-plan when it has children;
//   · a HELD story offers nothing;
//   · a ready child still gets its copy row (the one option turns on every row);
//   · the gates: a Visitor (`null`) gets no button, a project without AI no Plan.

const pathname = '/items/MOTIR-2284';
let params = new URLSearchParams('children=graph');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));
const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/navigation/shallowUrl')>()),
  shallowPush,
}));

const { ChildPanel } = await import('@/app/(authed)/items/[key]/_components/ChildPanel');
const { canvasNextActionsFor } = await import('@/lib/planning/canvasNextActions');
const { withPlanningOverlay } = await import('@/lib/planning/launcher');

const node = (over: Record<string, unknown>) => ({
  parentId: 'P9',
  isDone: false,
  hasChildren: false,
  ready: false,
  planHeld: false,
  ...over,
});

// One level holding every case the criteria name, so each assertion reads the
// same drawn canvas.
const LEVEL = {
  nodes: [
    // The COMPUTED To plan: a childless `todo` story, not held.
    node({
      id: 'c1',
      kind: 'story',
      identifier: 'MOTIR-3001',
      title: 'A story nobody planned yet',
      status: 'todo',
      statusCategory: 'todo',
    }),
    // The To plan STATUS on a leaf: a fresh plan.
    node({
      id: 'c2',
      kind: 'task',
      identifier: 'MOTIR-3002',
      title: 'A task a corrected decision sent back',
      status: 'to_plan',
      statusLabel: 'To plan',
      statusCategory: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
    }),
    // The To plan STATUS on a story that was planned once: a re-plan.
    node({
      id: 'c3',
      kind: 'story',
      identifier: 'MOTIR-3003',
      title: 'A planned story whose decision changed',
      status: 'to_plan',
      statusLabel: 'To plan',
      statusCategory: 'in_progress',
      hasChildren: true,
      progress: { done: 0, total: 2 },
    }),
    // HELD (MOTIR-11546): blocked by a story with no subtasks yet.
    node({
      id: 'c4',
      kind: 'story',
      identifier: 'MOTIR-3004',
      title: 'A story waiting on an unplanned one',
      status: 'todo',
      statusCategory: 'todo',
      planHeld: true,
    }),
    // A ready coding leaf: the copy `motir run` row.
    node({
      id: 'c5',
      kind: 'subtask',
      identifier: 'MOTIR-3005',
      title: 'A subtask ready to build',
      status: 'todo',
      statusCategory: 'todo',
      type: 'code',
      executor: 'coding_agent',
      ready: true,
    }),
  ],
  edges: [],
  offLevelBlockers: [],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  params = new URLSearchParams('children=graph');
  fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/roadmap')) return new Response(JSON.stringify(LEVEL), { status: 200 });
    // The Plan click's pre-open plannability read.
    return new Response(JSON.stringify({ plannable: true, reasons: [] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  shallowPush.mockClear();
  vi.unstubAllGlobals();
});

async function renderPanel(nextActions: ReturnType<typeof canvasNextActionsFor> | undefined) {
  render(
    <ChildPanel
      count={LEVEL.nodes.length}
      itemId="P9"
      itemIdentifier="MOTIR-2284"
      projectKey="MOTIR"
      nextActions={nextActions}
    >
      <ul data-testid="server-rows" />
    </ChildPanel>,
  );
  await screen.findByText('MOTIR-3001');
}

/** The next-action button on the card for `id`, or null. */
function actionOn(id: string): HTMLElement | null {
  const card = document.querySelector(`[data-node-id="${id}"]`);
  return card?.querySelector<HTMLElement>('[data-testid="node-next-action"]') ?? null;
}

async function pressPlan(id: string): Promise<void> {
  await act(async () => {
    fireEvent.click(actionOn(id)!, { button: 0 });
  });
}

const MEMBER = canvasNextActionsFor({ visitor: false, aiConfigured: true });
const here = `${pathname}?children=graph`;

describe('the item page’s child graph — the card’s next-action button', () => {
  it('a computed To plan child offers Plan, and opens planning over this page', async () => {
    await renderPanel(MEMBER);
    const button = actionOn('c1');
    expect(button?.getAttribute('data-action')).toBe('plan');
    expect(button?.getAttribute('aria-label')).toBe('Plan MOTIR-3001');
    await pressPlan('c1');
    expect(shallowPush).toHaveBeenCalledWith(
      withPlanningOverlay(here, {
        kind: 'work-item',
        itemKey: 'MOTIR-3001',
        hasPlan: false,
        confirmStart: true,
      }),
    );
  });

  it('a child in the To plan status offers Plan — a fresh plan on a leaf', async () => {
    await renderPanel(MEMBER);
    expect(actionOn('c2')?.getAttribute('data-action')).toBe('plan');
    await pressPlan('c2');
    expect(shallowPush).toHaveBeenCalledWith(
      withPlanningOverlay(here, {
        kind: 'work-item',
        itemKey: 'MOTIR-3002',
        hasPlan: false,
        confirmStart: true,
      }),
    );
  });

  it('a To plan status child with children opens as a re-plan of that card', async () => {
    await renderPanel(MEMBER);
    expect(actionOn('c3')?.getAttribute('data-action')).toBe('plan');
    await pressPlan('c3');
    expect(shallowPush).toHaveBeenCalledWith(
      withPlanningOverlay(here, {
        kind: 'work-item',
        itemKey: 'MOTIR-3003',
        hasPlan: true,
        confirmStart: true,
      }),
    );
  });

  it('a held story offers no Plan button', async () => {
    await renderPanel(MEMBER);
    expect(actionOn('c4')).toBeNull();
  });

  it('the one option turns on the copy rows too: a ready child copies motir run', async () => {
    await renderPanel(MEMBER);
    expect(actionOn('c5')?.getAttribute('data-action')).toBe('run');
  });

  it('a Visitor gets no button on any card', async () => {
    await renderPanel(canvasNextActionsFor({ visitor: true, aiConfigured: true }));
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) expect(actionOn(id)).toBeNull();
  });

  it('a panel mounted without the option draws no button (the safe default)', async () => {
    await renderPanel(undefined);
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) expect(actionOn(id)).toBeNull();
  });

  it('a project without AI gets no Plan button, and keeps the copy rows', async () => {
    await renderPanel(canvasNextActionsFor({ visitor: false, aiConfigured: false }));
    for (const id of ['c1', 'c2', 'c3', 'c4']) expect(actionOn(id)).toBeNull();
    expect(actionOn('c5')?.getAttribute('data-action')).toBe('run');
  });
});
