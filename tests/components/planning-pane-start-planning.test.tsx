// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  PlanProposalViews,
  type PlanReviewCanvasPrePlan,
} from '@/components/planning/PlanProposalViews';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanViewDto } from '@/lib/planning/planView';
import { NODE_H, NODE_W } from '@/lib/planning/projectCanvasModel';
import { fitView, nodesBounds } from '@/lib/planning/canvasGeometry';
import { planReviewItem } from '../helpers/planReview';

// BUG MOTIR-11513 — pressing Start planning on a target-launched overlay must not
// remount the canvas.
//
// Until this card the overlay's pane was one component before a plan existed and
// a DIFFERENT one after (`paneReview !== null ? <PlanProposalViews/> : <…/>`). The
// plan's first live read swapped them, so the canvas re-read its level, ran a
// fresh arrival (a plain level fit, the target no longer centred) and flashed its
// skeleton. The pane is now ONE `PlanProposalViews` from the start: before a plan
// it is in its "no plan" state (`prePlan`), and the first plan arrives on the same
// instance. These cases drive that hand-over on the REAL canvas over the wire —
// only `fetch`, the viewport's size and the ResizeObserver are stubbed.

const VP = { w: 800, h: 600 };
// Only LIVE observers, each with what it observes, and `measure()` waits for the
// canvas viewport to be observed before firing — the MOTIR-11593 fix to the
// arrival-centre suite, ported here (MOTIR-11548's CI hit the same window: the
// level draws inside RTL's `findBy*` poll, so `findByText` can resolve before the
// passive effect that registers the fit observer has run).
type Observer = { cb: (entries: unknown[]) => void; targets: Set<Element> };
const observers = new Set<Observer>();

/** The target, and the work item's status the server reports for it. */
const TARGET = 'w5';
let targetStatus: { status: string; statusLabel: string | null } = {
  status: 'todo',
  statusLabel: null,
};
let rootReads = 0;

function wireNode(i: number) {
  const id = `w${i}`;
  const own = id === TARGET ? targetStatus : { status: 'todo', statusLabel: null };
  return {
    id,
    parentId: null,
    kind: 'story',
    type: null,
    executor: null,
    identifier: `MOTIR-${100 + i}`,
    title: id === TARGET ? 'The target story' : `Story ${i}`,
    ...own,
    statusCategory: own.status === 'planning' ? 'in_progress' : 'todo',
    isDone: false,
    hasChildren: id === TARGET,
    progress: null,
    ready: false,
  };
}

beforeEach(() => {
  targetStatus = { status: 'todo', statusLabel: null };
  rootReads = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly o: Observer;
      constructor(cb: (entries: unknown[]) => void) {
        this.o = { cb, targets: new Set() };
        observers.add(this.o);
      }
      observe(el: Element) {
        this.o.targets.add(el);
      }
      unobserve(el: Element) {
        this.o.targets.delete(el);
      }
      disconnect() {
        this.o.targets.clear();
        observers.delete(this.o);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: VP.w,
    height: VP.h,
    top: 0,
    left: 0,
    right: VP.w,
    bottom: VP.h,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  // A BUSY root level — twelve stories, so a plain fit is well below 1× and
  // "centred" cannot pass by accident of the target being the level's middle.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(String(input), 'http://localhost');
      if (u.pathname === '/api/work-items/peek') return { ok: false, status: 404 } as Response;
      const parent = u.searchParams.get('parentId');
      if (parent === null) rootReads += 1;
      const items = parent === null ? Array.from({ length: 12 }, (_, i) => wireNode(i)) : [];
      return {
        ok: true,
        json: async () => ({ nodes: items, edges: [], offLevelBlockers: [], folders: [] }),
      } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  observers.clear();
});

/** The viewport's first measurement — the engine fits once it has a size. Waits
 *  until the drawn canvas's viewport is observed (its fit effect has run), then
 *  fires every live observer once. */
async function measure() {
  await waitFor(() => {
    const vp = screen.getByTestId('canvas-world').closest('[role="application"]');
    expect([...observers].some((o) => vp !== null && o.targets.has(vp))).toBe(true);
  });
  act(() => {
    for (const o of [...observers]) if (o.targets.size > 0) o.cb([]);
  });
}

function transform(): { tx: number; ty: number; scale: number } {
  const m = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\((-?[\d.e-]+)\)/.exec(
    screen.getByTestId('canvas-world').style.transform,
  );
  if (!m) throw new Error('no view transform');
  return { tx: Number(m[1]), ty: Number(m[2]), scale: Number(m[3]) };
}

function drawnRect(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
  if (!el) throw new Error(`node ${id} not drawn`);
  return { x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: NODE_W, h: NODE_H };
}

function screenCentre(r: { x: number; y: number; w: number; h: number }) {
  const v = transform();
  return { x: (r.x + r.w / 2) * v.scale + v.tx, y: (r.y + r.h / 2) * v.scale + v.ty };
}

/** The plan's first card — written UNDER the target, so the root level the reader
 *  is looking at gains nothing but the plan's chrome. */
const FIRST_CARD: PlanReviewItemDto = planReviewItem({
  planItemId: 'pi_1',
  nodeId: 'pi_1',
  parentNodeId: TARGET,
  kind: 'task',
  title: 'Draft the importer',
});

const PRE_PLAN: PlanReviewCanvasPrePlan = { targetIds: [TARGET], onToggleTarget: vi.fn() };

/** The overlay's pane as the host drives it: ONE instance, `prePlan` until the
 *  plan's first live read, the plan after. */
function Pane({ planned }: { planned: boolean }) {
  const [view, setView] = useState<PlanViewDto>('canvas');
  return (
    <PlanProposalViews
      items={planned ? [FIRST_CARD] : []}
      projectKey="MOTIR"
      version={planned ? 1 : 0}
      outcome={null}
      ariaLabel="Roadmap canvas"
      view={view}
      onViewChange={setView}
      preserveCanvasLevel
      prePlan={planned ? null : PRE_PLAN}
      initialCentreId={TARGET}
      loadingFallback={<div data-testid="pane-skeleton" />}
      live={planned}
    />
  );
}

async function openOnTarget() {
  const view = render(<Pane planned={false} />);
  await screen.findByText('The target story');
  await measure();
  return view;
}

describe('Start planning on a target-launched overlay (MOTIR-11513)', () => {
  it('keeps the SAME canvas element and the SAME viewport when the plan arrives', async () => {
    const view = await openOnTarget();
    const world = screen.getByTestId('canvas-world');
    const before = transform();
    // The opening view is the MOTIR-11472 centre, not the level's fit.
    expect(before.scale).toBe(1);
    expect(screenCentre(drawnRect(TARGET))).toEqual({ x: VP.w / 2, y: VP.h / 2 });
    const ids = Array.from({ length: 12 }, (_, i) => `w${i}`);
    expect(before).not.toEqual(fitView(nodesBounds(ids.map(drawnRect)), VP));

    targetStatus = { status: 'planning', statusLabel: 'Planning' };
    view.rerender(<Pane planned />);
    // The re-read is IN PLACE: the prior level stays drawn, so no skeleton ever
    // stands in for it — checked at once and after the read lands.
    expect(screen.queryByTestId('pane-skeleton')).toBeNull();
    await waitFor(() => expect(screen.getByText('Planning')).toBeTruthy());
    expect(screen.queryByTestId('pane-skeleton')).toBeNull();

    // ⭐ The same element — the canvas was not remounted — and the same view.
    expect(screen.getByTestId('canvas-world')).toBe(world);
    expect(transform()).toEqual(before);
    expect(screenCentre(drawnRect(TARGET))).toEqual({ x: VP.w / 2, y: VP.h / 2 });
  });

  it('swaps the Target tag for the card’s Planning status, and adds the plan chrome around it', async () => {
    const view = await openOnTarget();
    // Before: the ring's Target tag, and no List | Canvas switch.
    expect(screen.getByTestId('planning-target-node').textContent).toContain('Target');
    expect(screen.queryByRole('group', { name: 'Plan view' })).toBeNull();
    expect(screen.getByTestId('plan-proposal-views').getAttribute('data-pre-plan')).toBe('true');

    targetStatus = { status: 'planning', statusLabel: 'Planning' };
    view.rerender(<Pane planned />);
    await waitFor(() => expect(screen.getByText('Planning')).toBeTruthy());

    expect(screen.queryByTestId('planning-target-node')).toBeNull();
    expect(screen.getByRole('group', { name: 'Plan view' })).toBeTruthy();
    expect(screen.getByTestId('plan-live-state')).toBeTruthy();
    expect(screen.getByTestId('plan-proposal-views').getAttribute('data-pre-plan')).toBeNull();
  });

  it('re-reads the level it is on ONCE for the hand-over, never from a fresh mount', async () => {
    const view = await openOnTarget();
    const opened = rootReads;
    view.rerender(<Pane planned />);
    await waitFor(() => expect(rootReads).toBe(opened + 1));
    // …and nothing more: a remount would read the level again and refit it.
    await act(async () => {});
    expect(rootReads).toBe(opened + 1);
  });
});
