// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { PlanningCanvas, type CanvasNode } from '@/components/planning/PlanningCanvas';

// AN EXPLICIT FOCUS OUTRANKS THE ONE-TIME FIT (MOTIR-11298). Locate can open
// another level to centre a card being worked on, so that level's engine mounts
// with the focus already requested. The fit runs later, from a ResizeObserver
// callback, and must not throw the centred card back out to the fitted view.

const observers: Array<(entries: unknown[]) => void> = [];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  observers.length = 0;
});

const nodes: CanvasNode[] = [
  { id: 'a', x: 0, y: 0 },
  { id: 'b', x: 2000, y: 1200 },
];

describe('PlanningCanvas — a focus requested at mount survives the fit', () => {
  it('keeps the requested scale after the viewport is first measured', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: (entries: unknown[]) => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    render(
      <PlanningCanvas
        nodes={nodes}
        edges={[]}
        renderNode={(n) => <div>Node {n.id}</div>}
        focusNodeId="b"
        focusNonce={1}
        focusScale={1}
      />,
    );
    const world = () => screen.getByTestId('canvas-world');
    expect(world().style.transform).toContain('scale(1)');
    // The fit's callback fires after the focus; it must leave the focus alone.
    act(() => {
      for (const cb of observers) cb([]);
    });
    expect(world().style.transform).toContain('scale(1)');
  });
});
