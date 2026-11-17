// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { PlanningCanvas, type CanvasNode } from '@/components/planning/PlanningCanvas';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import type { ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import { NODE_H, NODE_W } from '@/lib/planning/projectCanvasModel';
import { fitView, nodesBounds } from '@/lib/planning/canvasGeometry';

// THE OPENING VIEW ON A TARGET (MOTIR-11472). The planning workspace opened on a
// target arrives on the target's level CENTRED on the target card at the LOCATE
// scale, rather than fitting the whole level — which on a busy level shrank the
// card the conversation is about to one small card among its siblings.
//
// The engine fits ONCE, from a ResizeObserver callback once the viewport has a
// size, so the test drives that callback by hand over a fixed 800×600 viewport.
//
// The stub keeps only LIVE observers, each with the elements it observes — a
// disconnected one never fires, as in a browser — and `measure()` first WAITS for
// the canvas's viewport to be observed (MOTIR-11593). The roadmap canvas draws a
// level after `loadLevel` resolves, i.e. inside RTL's `findBy*` poll, where the act
// environment is off: the render commits (so `findBy*` resolves on the card's
// text) while the passive effect that registers the fit observer is still queued
// on React's scheduler. Firing at that moment fired nothing — the view stayed at
// its identity transform — and a loaded CI worker hit that window often enough to
// flake shard 14/20.

const VP = { w: 800, h: 600 };
type Observer = { cb: (entries: unknown[]) => void; targets: Set<Element> };
const observers = new Set<Observer>();

beforeEach(() => {
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  observers.clear();
});

/** The viewport's first measurement: wait until the drawn canvas's viewport is
 *  observed (its fit effect has run), then fire every live observer once. Empty
 *  entries leave node sizes at their declared width/height. */
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

/** Where a world rect's centre lands on screen under the current view. */
function screenCentre(r: { x: number; y: number; w: number; h: number }) {
  const v = transform();
  return { x: (r.x + r.w / 2) * v.scale + v.tx, y: (r.y + r.h / 2) * v.scale + v.ty };
}

// A BUSY level: 3 × 4 cards, wide and tall enough that a plain fit shrinks it
// well below 1×. The target is an off-centre card, so "centred" cannot pass by
// accident of being the level's middle.
const W = 300;
const H = 120;
const grid: CanvasNode[] = Array.from({ length: 12 }, (_, i) => ({
  id: `n${i}`,
  x: (i % 4) * 400,
  y: Math.floor(i / 4) * 260,
  width: W,
  height: H,
}));
const target = grid[5]!;
const targetRect = { x: target.x, y: target.y, w: W, h: H };
const levelFit = fitView(nodesBounds(grid.map((n) => ({ x: n.x, y: n.y, w: W, h: H }))), VP);

describe('PlanningCanvas — arrivalCentre', () => {
  it('opens with the named card centred at the given scale, not the level fitted', async () => {
    render(
      <PlanningCanvas
        nodes={grid}
        edges={[]}
        renderNode={(n) => <div>Node {n.id}</div>}
        arrivalCentre={{ nodeId: target.id, scale: 1 }}
      />,
    );
    await measure();

    expect(transform().scale).toBe(1);
    expect(screenCentre(targetRect)).toEqual({ x: VP.w / 2, y: VP.h / 2 });
    // The level's own fit is a different, smaller view — that is the bug.
    expect(levelFit.scale).toBeLessThan(1);
  });

  it('outranks the readable-floor arrival when both are asked for', async () => {
    render(
      <PlanningCanvas
        nodes={grid}
        edges={[]}
        renderNode={(n) => <div>Node {n.id}</div>}
        arrival={{ floor: 0.8, focalNodeId: 'n0' }}
        arrivalCentre={{ nodeId: target.id, scale: 1 }}
      />,
    );
    await measure();

    expect(transform().scale).toBe(1);
    expect(screenCentre(targetRect)).toEqual({ x: VP.w / 2, y: VP.h / 2 });
  });

  it('falls back to the plain fit when the named card is not on the level', async () => {
    render(
      <PlanningCanvas
        nodes={grid}
        edges={[]}
        renderNode={(n) => <div>Node {n.id}</div>}
        arrivalCentre={{ nodeId: 'elsewhere', scale: 1 }}
      />,
    );
    await measure();

    expect(transform()).toEqual(levelFit);
  });

  it('leaves the fit-to-view control framing the whole level', async () => {
    render(
      <PlanningCanvas
        nodes={grid}
        edges={[]}
        renderNode={(n) => <div>Node {n.id}</div>}
        arrivalCentre={{ nodeId: target.id, scale: 1 }}
      />,
    );
    await measure();
    expect(transform().scale).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Fit to view' }));
    expect(transform()).toEqual(levelFit);
  });

  it('is absent by default — the arrival is the plain fit', async () => {
    render(<PlanningCanvas nodes={grid} edges={[]} renderNode={(n) => <div>Node {n.id}</div>} />);
    await measure();

    expect(transform()).toEqual(levelFit);
  });
});

// ── the roadmap canvas: a mount-time seed for the ARRIVAL level only ──

function node(id: string, label: string, drillable = false): ProjectCanvasNode {
  return {
    id,
    parentId: null,
    searchText: label,
    crumbLabel: id,
    drillable,
    content: <div>{label}</div>,
  };
}

// root → [P (drillable)] ; P → [A, B, T, C, D, E] (T is the target, a leaf) ; A → [X].
const levels: Record<string, RoadmapLevel> = {
  __root__: { nodes: [node('P', 'Parent story', true)], deps: [] },
  P: {
    nodes: [
      node('A', 'Card A', true),
      node('B', 'Card B'),
      node('T', 'Target card'),
      node('C', 'Card C'),
      node('D', 'Card D'),
      node('E', 'Card E'),
    ],
    deps: [],
  },
  A: { nodes: [node('X', 'Card X'), node('Y', 'Card Y')], deps: [] },
};
const loadLevel = (parentId: string | null): Promise<RoadmapLevel> =>
  Promise.resolve(levels[parentId ?? '__root__'] ?? { nodes: [], deps: [] });

/** The drawn card's world rect: its laid-out position, at the canvas's node size. */
function drawnRect(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
  if (!el) throw new Error(`node ${id} not drawn`);
  return { x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: NODE_W, h: NODE_H };
}

describe('ProjectRoadmapCanvas — initialCentreId', () => {
  it('opens the arrival level centred on the target card at the Locate zoom', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        initialTrail={[{ id: 'P', label: 'MOTIR-1 · Parent story' }]}
        initialCentreId="T"
      />,
    );
    await screen.findByText('Target card');
    await measure();

    expect(transform().scale).toBe(1);
    expect(screenCentre(drawnRect('T'))).toEqual({ x: VP.w / 2, y: VP.h / 2 });
    // …which is NOT the whole level's fit (the view this card replaces).
    const ids = ['A', 'B', 'T', 'C', 'D', 'E'];
    expect(transform()).not.toEqual(fitView(nodesBounds(ids.map(drawnRect)), VP));
    // Siblings are still on the level, reachable by panning.
    expect(screen.getByText('Card E')).toBeTruthy();
  });

  it('centres a ROOT-level target too — no trail, the root is the arrival level', async () => {
    const root: RoadmapLevel = levels['P']!;
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(root)} initialCentreId="T" />);
    await screen.findByText('Target card');
    await measure();

    expect(transform().scale).toBe(1);
    expect(screenCentre(drawnRect('T'))).toEqual({ x: VP.w / 2, y: VP.h / 2 });
  });

  it('keeps the plain fit for a launch with no target', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        initialTrail={[{ id: 'P', label: 'MOTIR-1 · Parent story' }]}
      />,
    );
    await screen.findByText('Target card');
    await measure();

    const ids = ['A', 'B', 'T', 'C', 'D', 'E'];
    expect(transform()).toEqual(fitView(nodesBounds(ids.map(drawnRect)), VP));
  });

  it('changes nothing when the target is not a card on the arrival level', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        initialTrail={[{ id: 'P', label: 'MOTIR-1 · Parent story' }]}
        initialCentreId="P"
      />,
    );
    await screen.findByText('Target card');
    await measure();

    const ids = ['A', 'B', 'T', 'C', 'D', 'E'];
    expect(transform()).toEqual(fitView(nodesBounds(ids.map(drawnRect)), VP));
  });

  it('shapes the FIRST arrival only — a level drilled to afterwards arrives fitted', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        initialTrail={[{ id: 'P', label: 'MOTIR-1 · Parent story' }]}
        initialCentreId="T"
      />,
    );
    await screen.findByText('Target card');
    await measure();
    expect(transform().scale).toBe(1);

    // Drill into A, then come back: neither arrival is the opening centre.
    fireEvent.keyDown(document.querySelector('[data-node-id="A"]')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('Card X');
    await measure();
    expect(transform()).toEqual(fitView(nodesBounds(['X', 'Y'].map(drawnRect)), VP));

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByText('Target card');
    await measure();
    const ids = ['A', 'B', 'T', 'C', 'D', 'E'];
    expect(transform()).toEqual(fitView(nodesBounds(ids.map(drawnRect)), VP));
  });
});
