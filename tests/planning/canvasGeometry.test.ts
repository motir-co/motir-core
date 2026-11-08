import { describe, expect, it } from 'vitest';
import type { Bounds, Rect } from '@/lib/planning/canvasGeometry';
import {
  ARRIVAL_MIN_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  arrivalView,
  centerOn,
  clampScale,
  fitView,
  nodesBounds,
  routeEdges,
  screenDeltaToWorld,
  screenToWorld,
  zoomToward,
} from '@/lib/planning/canvasGeometry';

describe('centerOn', () => {
  it('pans a node to the viewport centre, preserving scale', () => {
    const rect = { x: 100, y: 200, w: 280, h: 132 };
    const viewport = { w: 1000, h: 600 };
    const v = centerOn(rect, viewport, 1.5);
    expect(v.scale).toBe(1.5);
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    expect(v.tx + cx * v.scale).toBeCloseTo(viewport.w / 2);
    expect(v.ty + cy * v.scale).toBeCloseTo(viewport.h / 2);
  });
});

describe('clampScale', () => {
  it('bounds the zoom range', () => {
    expect(clampScale(5)).toBe(MAX_SCALE);
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(1)).toBe(1);
  });
});

describe('zoomToward', () => {
  it('keeps the world point under the anchor fixed', () => {
    const v = { scale: 1, tx: 100, ty: 50 };
    const cx = 300;
    const cy = 200;
    const before = screenToWorld(v, cx, cy);
    const z = zoomToward(v, 1.5, cx, cy);
    const after = screenToWorld(z, cx, cy);
    expect(z.scale).toBeCloseTo(1.5);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('clamps to the zoom bounds (anchor still respected)', () => {
    expect(zoomToward({ scale: 1.8, tx: 0, ty: 0 }, 2, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomToward({ scale: 0.35, tx: 0, ty: 0 }, 0.5, 0, 0).scale).toBe(MIN_SCALE);
  });
});

describe('nodesBounds', () => {
  it('computes the bounding box of node rects', () => {
    expect(
      nodesBounds([
        { x: 10, y: 20, w: 100, h: 50 },
        { x: 200, y: 5, w: 80, h: 40 },
      ]),
    ).toEqual({ minX: 10, minY: 5, maxX: 280, maxY: 70 });
  });

  it('zeroes an empty set', () => {
    expect(nodesBounds([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe('fitView', () => {
  it('scales + centres the bounds into the viewport', () => {
    const v = fitView({ minX: 0, minY: 0, maxX: 1000, maxY: 500 }, { w: 940, h: 760 }, 20);
    // scale = min((940-40)/1000, (760-40)/500) = min(0.9, 1.44) = 0.9
    expect(v.scale).toBeCloseTo(0.9);
    expect(v.tx).toBeCloseTo((940 - 1000 * 0.9) / 2); // 20
    expect(v.ty).toBeCloseTo((760 - 500 * 0.9) / 2); // 155
  });

  it('clamps the fit scale to the zoom max for a tiny graph', () => {
    expect(fitView({ minX: 0, minY: 0, maxX: 20, maxY: 20 }, { w: 940, h: 760 }).scale).toBe(
      MAX_SCALE,
    );
  });
});

describe('screenDeltaToWorld / screenToWorld', () => {
  it('converts a screen drag delta to world units', () => {
    expect(screenDeltaToWorld(100, 50, 2)).toEqual({ dx: 50, dy: 25 });
  });
  it('inverts the view transform', () => {
    expect(screenToWorld({ scale: 2, tx: 100, ty: 40 }, 300, 240)).toEqual({ x: 100, y: 100 });
  });
});

// Parse an SVG `d` string into the ordered coordinate pairs it names (M/L
// endpoints and Q control+end points), so we can assert route geometry.
function points(d: string): Array<{ x: number; y: number }> {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i]!, y: nums[i + 1]! });
  return pts;
}

type RMap = Record<string, { x: number; y: number; w: number; h: number }>;
const lookup =
  (m: RMap) =>
  (id: string): RMap[string] | undefined =>
    m[id];

describe('routeEdges', () => {
  it('returns one route per edge (aligned to input), null when an endpoint is missing', () => {
    const m: RMap = { A: { x: 0, y: 0, w: 100, h: 50 }, B: { x: 300, y: 0, w: 100, h: 50 } };
    const r = routeEdges(
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'GONE' },
      ],
      lookup(m),
    );
    expect(r).toHaveLength(2);
    expect(r[0]).not.toBeNull();
    expect(r[1]).toBeNull();
  });

  it('connects the FACING sides — right→left for a forward edge, arrow pointing right', () => {
    const m: RMap = { A: { x: 0, y: 0, w: 100, h: 50 }, B: { x: 300, y: 200, w: 100, h: 50 } };
    const pts = points(routeEdges([{ from: 'A', to: 'B' }], lookup(m))[0]!.d); // [A,c1,c2,B]
    expect(pts[0]!.x).toBeCloseTo(100, 1); // leaves A's RIGHT side (a.x + a.w)
    const end = pts[3]!;
    expect(end.x).toBeCloseTo(300, 1); // arrives at B's LEFT side (b.x)
    expect(end.y).toBeGreaterThan(200); // …within B's height
    expect(end.y).toBeLessThan(250);
    expect(end.x - pts[2]!.x).toBeGreaterThan(1); // end tangent points RIGHT into the left side
  });

  it('connects the FACING sides for a BACK edge — left→right (no crossing the block)', () => {
    // B sits to the LEFT of A: the edge must leave A's left and enter B's right.
    const m: RMap = { A: { x: 300, y: 0, w: 100, h: 50 }, B: { x: 0, y: 0, w: 100, h: 50 } };
    const pts = points(routeEdges([{ from: 'A', to: 'B' }], lookup(m))[0]!.d);
    expect(pts[0]!.x).toBeCloseTo(300, 1); // leaves A's LEFT side (a.x)
    expect(pts[3]!.x).toBeCloseTo(100, 1); // arrives at B's RIGHT side (b.x + b.w)
  });

  it('connects TOP/BOTTOM for a stacked pair (target directly below)', () => {
    const m: RMap = { A: { x: 0, y: 0, w: 100, h: 50 }, B: { x: 0, y: 300, w: 100, h: 50 } };
    const pts = points(routeEdges([{ from: 'A', to: 'B' }], lookup(m))[0]!.d);
    expect(pts[0]!.y).toBeCloseTo(50, 1); // leaves A's BOTTOM (a.y + a.h)
    expect(pts[3]!.y).toBeCloseTo(300, 1); // arrives at B's TOP (b.y)
  });

  it('routes a row-WRAP edge through the inter-row band — bottom→top, not a backward horizontal sweep', () => {
    // The end of row 0 (right) links to the start of row 1 (left): a backward step
    // that changes row. It must leave the source's BOTTOM and enter the target's TOP
    // (the empty band between rows), never exit a side and swim back across the row.
    const m: RMap = {
      end: { x: 1400, y: 40, w: 280, h: 124 }, // last card of row 0
      start: { x: 40, y: 260, w: 280, h: 124 }, // first card of row 1
    };
    const pts = points(routeEdges([{ from: 'end', to: 'start' }], lookup(m))[0]!.d);
    expect(pts[0]!.y).toBeCloseTo(164, 1); // leaves end's BOTTOM (40 + 124)
    expect(pts[3]!.y).toBeCloseTo(260, 1); // arrives at start's TOP
    expect(pts[3]!.y - pts[2]!.y).toBeGreaterThan(1); // end tangent points DOWN into the top
  });

  it('fans two edges into one target to DISTINCT entry points (no shared arrowhead)', () => {
    const m: RMap = {
      A: { x: 0, y: 0, w: 100, h: 50 },
      B: { x: 0, y: 200, w: 100, h: 50 },
      T: { x: 300, y: 80, w: 100, h: 80 },
    };
    const [r1, r2] = routeEdges(
      [
        { from: 'A', to: 'T' },
        { from: 'B', to: 'T' },
      ],
      lookup(m),
    );
    expect(points(r1!.d)[3]!.y).not.toBe(points(r2!.d)[3]!.y); // distinct entry heights on T's left
  });

  // MOTIR-10630 (design MOTIR-10629 § "Two or more edges entering the here card's
  // top"): a card with a TAB on its top-left edge fans its TOP side from t = 0.5.
  describe('a tabbed card (the "You are here" tab)', () => {
    const W = 280;
    const H = 124;
    const m: RMap = {
      A: { x: 0, y: 0, w: W, h: H },
      B: { x: 100, y: 0, w: W, h: H },
      T: { x: 0, y: 400, w: W, h: H },
      L: { x: -600, y: 400, w: W, h: H },
    };
    const twoIntoTop = [
      { from: 'A', to: 'T' },
      { from: 'B', to: 'T' },
    ];

    it('without the flag, two top entries fan across the shared band (t = 0.28–0.72)', () => {
      const xs = routeEdges(twoIntoTop, lookup(m)).map((r) => points(r!.d)[3]!);
      expect(xs.map((p) => p.y)).toEqual([400, 400]);
      expect(xs.map((p) => p.x)).toEqual([78.4, 201.6]);
    });

    it('with the flag, the top band starts at the middle so every arrowhead clears the tab', () => {
      const xs = routeEdges(twoIntoTop, lookup(m), (id) => id === 'T').map((r) => points(r!.d)[3]!);
      expect(xs.map((p) => p.x)).toEqual([140, 201.6]);
      // The widest tab ends at 118px from the card's left edge.
      for (const p of xs) expect(p.x).toBeGreaterThan(118);
    });

    it('one top entry still lands at the middle', () => {
      const [r] = routeEdges([{ from: 'A', to: 'T' }], lookup(m), (id) => id === 'T');
      expect(points(r!.d)[3]!.x).toBe(140);
    });

    it('fans the tabbed card’s top EXITS right of the tab too', () => {
      const xs = routeEdges(
        [
          { from: 'T', to: 'A' },
          { from: 'T', to: 'B' },
        ],
        lookup(m),
        (id) => id === 'T',
      ).map((r) => points(r!.d)[0]!);
      expect(xs.map((p) => p.y)).toEqual([400, 400]);
      expect(xs.map((p) => p.x)).toEqual([140, 201.6]);
    });

    it('leaves every other side of the tabbed card, and every other card, on the shared band', () => {
      const tabbed = (id: string) => id === 'T' || id === 'A';
      // Two edges into T's LEFT side keep the shared band.
      const m2: RMap = {
        ...m,
        P: { x: -600, y: 380, w: W, h: H },
        Q: { x: -600, y: 420, w: W, h: H },
      };
      const left = routeEdges(
        [
          { from: 'P', to: 'T' },
          { from: 'Q', to: 'T' },
        ],
        lookup(m2),
        tabbed,
      ).map((r) => points(r!.d)[3]!);
      expect(left.map((p) => p.x)).toEqual([0, 0]);
      expect(left.map((p) => p.y)).toEqual([400 + H * 0.28, 400 + H * 0.72]);
      // A's BOTTOM exits (A is flagged, but the tab is on its top) keep the band.
      const bottom = routeEdges(
        [
          { from: 'A', to: 'T' },
          { from: 'A', to: 'L' },
        ],
        lookup(m),
        tabbed,
      ).map((r) => points(r!.d)[0]!);
      expect(bottom.map((p) => p.y)).toEqual([H, H]);
      expect(bottom.map((p) => p.x)).toEqual([201.6, 78.4]);
    });
  });

  it('fans two edges off one source to DISTINCT exit points', () => {
    const m: RMap = {
      S: { x: 0, y: 0, w: 100, h: 100 },
      X: { x: 300, y: 0, w: 100, h: 50 },
      Y: { x: 300, y: 300, w: 100, h: 50 },
    };
    const [rx, ry] = routeEdges(
      [
        { from: 'S', to: 'X' },
        { from: 'S', to: 'Y' },
      ],
      lookup(m),
    );
    expect(points(rx!.d)[0]!.y).not.toBe(points(ry!.d)[0]!.y);
  });

  it('ARCS a long horizontal edge so it clears a card between the columns', () => {
    // A and B are far apart on the same row → the curve must bow above the row.
    const m: RMap = { A: { x: 0, y: 0, w: 100, h: 50 }, B: { x: 900, y: 0, w: 100, h: 50 } };
    const pts = points(routeEdges([{ from: 'A', to: 'B' }], lookup(m))[0]!.d);
    expect(Math.min(...pts.map((p) => p.y))).toBeLessThan(0); // a control point rose above the row
  });

  it('does NOT arc a short neighbour edge (stays flat between adjacent cards)', () => {
    const m: RMap = { A: { x: 0, y: 0, w: 100, h: 50 }, B: { x: 200, y: 0, w: 100, h: 50 } };
    const pts = points(routeEdges([{ from: 'A', to: 'B' }], lookup(m))[0]!.d);
    expect(Math.min(...pts.map((p) => p.y))).toBeGreaterThanOrEqual(0); // no bow
  });
});

// ── THE ARRIVAL VIEW (MOTIR-3837) ───────────────────────────────────────────
//
// `fitView` with a legibility FLOOR: a level that would be shrunk below the floor
// arrives AT it, centred per axis rather than framed. A strict superset — every
// level that already fits legibly is untouched.
describe('arrivalView', () => {
  const viewport = { w: 1136, h: 620 };
  // The shipped 3-column layout's root level: 18 cards at 280x124, gaps 80/72.
  const bigLevel: Bounds = { minX: 40, minY: 40, maxX: 1040, maxY: 1364 };
  // A five-node level — two rows.
  const smallLevel: Bounds = { minX: 40, minY: 40, maxX: 1040, maxY: 360 };

  it('is IDENTICAL to fitView when the fit lands at or above the floor', () => {
    const fit = fitView(smallLevel, viewport);
    expect(fit.scale).toBeGreaterThanOrEqual(ARRIVAL_MIN_SCALE);
    expect(arrivalView(smallLevel, viewport, ARRIVAL_MIN_SCALE)).toEqual(fit);
    // …and a focal rect cannot change that: above the floor the level is framed.
    expect(
      arrivalView(smallLevel, viewport, ARRIVAL_MIN_SCALE, { x: 40, y: 40, w: 280, h: 124 }),
    ).toEqual(fit);
  });

  it('arrives AT the floor when the fit would be smaller, and centres the FOCAL card on the constrained axis', () => {
    expect(fitView(bigLevel, viewport).scale).toBeLessThan(ARRIVAL_MIN_SCALE);
    // The `here` frontier: row 3, column 1.
    const focal = { x: 40, y: 432, w: 280, h: 124 };
    const v = arrivalView(bigLevel, viewport, ARRIVAL_MIN_SCALE, focal);

    expect(v.scale).toBe(ARRIVAL_MIN_SCALE);
    // VERTICAL is constrained (1324 * 0.8 = 1059 > 620), so the focal card's centre
    // lands at the viewport's centre.
    const cy = focal.y + focal.h / 2;
    expect(cy * v.scale + v.ty).toBeCloseTo(viewport.h / 2, 6);
    // HORIZONTAL fits (1000 * 0.8 = 800, + 96 padding, < 1136), so the LEVEL is
    // centred — not the card. Centring the card on both axes would park a
    // first-column card in the middle and leave a third of the canvas empty.
    const levelCx = (bigLevel.minX + bigLevel.maxX) / 2;
    expect(levelCx * v.scale + v.tx).toBeCloseTo(viewport.w / 2, 6);
    expect(focal.x + focal.w / 2).not.toBeCloseTo(levelCx, 6); // the two really differ
  });

  it('centres the BOUNDS on both axes when there is no focal rect', () => {
    const v = arrivalView(bigLevel, viewport, ARRIVAL_MIN_SCALE);
    expect(v.scale).toBe(ARRIVAL_MIN_SCALE);
    const cx = (bigLevel.minX + bigLevel.maxX) / 2;
    const cy = (bigLevel.minY + bigLevel.maxY) / 2;
    expect(cx * v.scale + v.tx).toBeCloseTo(viewport.w / 2, 6);
    expect(cy * v.scale + v.ty).toBeCloseTo(viewport.h / 2, 6);
  });

  it('fits a SINGLE-node level exactly as fitView does — well above the floor', () => {
    const one: Bounds = { minX: 0, minY: 0, maxX: 280, maxY: 124 };
    expect(arrivalView(one, viewport, ARRIVAL_MIN_SCALE)).toEqual(fitView(one, viewport));
  });

  it('returns finite numbers for a ZERO-SIZE viewport — no NaN, no divide-by-zero', () => {
    const v = arrivalView(bigLevel, { w: 0, h: 0 }, ARRIVAL_MIN_SCALE);
    expect(Number.isFinite(v.scale)).toBe(true);
    expect(Number.isFinite(v.tx)).toBe(true);
    expect(Number.isFinite(v.ty)).toBe(true);
    expect(v.scale).toBe(ARRIVAL_MIN_SCALE);
  });

  it('never returns a scale outside the engine’s own zoom range', () => {
    // A floor above MAX_SCALE is clamped like any other scale.
    const v = arrivalView(bigLevel, viewport, 99);
    expect(v.scale).toBe(MAX_SCALE);
  });

  it('the FLOOR is the design’s measured number', () => {
    // `design/roadmap/design-notes.md` derives it: the title (14px) never renders
    // below the card's own smallest authored type (the 11px status chip).
    expect(ARRIVAL_MIN_SCALE).toBe(0.8);
    expect(14 * ARRIVAL_MIN_SCALE).toBeGreaterThanOrEqual(11);
  });
});

// ── routeEdges: the BOTH-OVERLAP axis choice ────────────────────────────────
describe('routeEdges — two boxes that overlap on BOTH axes', () => {
  it('picks the axis by the larger centre-to-centre delta', () => {
    const rects: Record<string, Rect> = {
      // Overlapping rects: neither axis separates them, so the tie-break is
      // distance — the arm the three separation cases above never reach.
      A: { x: 0, y: 0, w: 280, h: 124 },
      wide: { x: 200, y: 20, w: 280, h: 124 }, // |dx| 200 > |dy| 20 → horizontal
      tall: { x: 20, y: 100, w: 280, h: 124 }, // |dy| 100 > |dx| 20 → vertical
    };
    const [h, v] = routeEdges(
      [
        { from: 'A', to: 'wide' },
        { from: 'A', to: 'tall' },
      ],
      (id) => rects[id],
    );
    // Both route; what differs is which side they leave from, which the `d` string
    // records as its first point.
    expect(h).not.toBeNull();
    expect(v).not.toBeNull();
    expect(h!.d).not.toBe(v!.d);
  });
});
