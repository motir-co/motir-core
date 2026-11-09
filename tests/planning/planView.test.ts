import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARRIVAL_LEVEL_MAX_NODES,
  PLAN_VIEW_PARAM,
  PLAN_VIEW_VALUES,
  defaultPlanView,
  planViewFromParam,
} from '@/lib/planning/planView';
import { TREE_LEVEL_MAX_TAKE } from '@/lib/planning/levelCaps';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { planContainerCount } from '@/lib/planning/planShape';
import { planReview, planReviewItem } from '../helpers/planReview';
import {
  LOOSE_BAND_COLS,
  NODE_H,
  NODE_W,
  deterministicLayout,
} from '@/lib/planning/projectCanvasModel';
import { fitView, nodesBounds } from '@/lib/planning/canvasGeometry';

// MOTIR-3239 / MOTIR-3262 — the plan-detail view vocabulary, its URL parsing,
// and the DERIVED default.
//
// The seam MOTIR-3239 named is now filled: `defaultPlanView` answers Part IX §3's
// rule — the LIST when the plan's proposals sit under more than one distinct
// container, the canvas otherwise — reading the count from `planShape`, which is
// the one implementation of that question.
//
// ⚠️ `planViewFromParam` takes the RESOLVED default rather than the review, and
// that signature is the point: the default is a SEED for the arriving reader, and
// a `generating` plan's item set grows under a 2.5s poll. Passing a value the
// island pinned at mount makes "read once" structural instead of a rule somebody
// has to remember.

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'planned',
    title: 'A plan',
    summary: null,
    itemCount: 0,
    createdAt: '2026-08-20T00:00:00.000Z',
    plannedAt: '2026-08-20T00:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
    decisionReason: null,
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    items: [],
    stale: false,
    staleCount: 0,
    // A small level, so the derived default is the CANVAS unless a case says
    // otherwise (MOTIR-4024).
    arrivalLevelSize: 1,
    arrivalLevelTotal: 1,
    revision: null,
    ...over,
  };
}

describe('planViewFromParam', () => {
  it('takes each member of the vocabulary', () => {
    for (const value of PLAN_VIEW_VALUES) {
      expect(planViewFromParam(value, 'canvas')).toBe(value);
    }
  });

  it('falls back to the DEFAULT for absent, empty, unknown and malformed values', () => {
    // The value comes from a URL a person can type; there is no reading on which
    // `?view=nonsense` is worth a failure.
    for (const raw of [undefined, null, '', 'nonsense', 'CANVAS', 'list ']) {
      expect(planViewFromParam(raw, 'list')).toBe('list');
      expect(planViewFromParam(raw, 'canvas')).toBe('canvas');
    }
  });

  it('a `?view=` value always WINS over the default, in both directions', () => {
    // Including against the default a straddling plan would otherwise get.
    expect(planViewFromParam('canvas', 'list')).toBe('canvas');
    expect(planViewFromParam('list', 'canvas')).toBe('list');
  });
});

describe('defaultPlanView — DERIVED from the plan’s shape (MOTIR-3262)', () => {
  const at = (id: string, parent: string | null) =>
    planReviewItem({ planItemId: id, nodeId: id, parentNodeId: parent });

  it('a plan under ONE container opens on the CANVAS', () => {
    expect(defaultPlanView(review({ items: [at('a', 'wi_p'), at('b', 'wi_p')] }))).toBe('canvas');
  });

  it('a plan that STRADDLES two containers opens on the LIST', () => {
    // No single canvas level can show it, and the canvas draws one level at a
    // time — opening on it would be the surface insisting on a view that
    // structurally cannot answer the question.
    expect(defaultPlanView(review({ items: [at('a', 'wi_story'), at('b', 'wi_epic')] }))).toBe(
      'list',
    );
  });

  it('a plan of PURE ROOTS opens on the canvas — the top level is ONE container', () => {
    // Part IX §3 settles this: `null` counts as a container rather than being
    // skipped, so a plan of roots does not read as straddling.
    expect(defaultPlanView(review({ items: [at('a', null), at('b', null)] }))).toBe('canvas');
  });

  it('a PROPOSED container counts too', () => {
    // A story under an epic plus subtasks under that story touches two
    // containers, one of which does not exist yet.
    const items = [
      planReviewItem({ planItemId: 's', nodeId: 's', parentNodeId: 'wi_epic' }),
      planReviewItem({ planItemId: 'x', nodeId: 'x', parentNodeId: 's', parentIdentifier: null }),
    ];
    expect(defaultPlanView(review({ items }))).toBe('list');
  });

  it('an EMPTY plan opens on the canvas', () => {
    expect(defaultPlanView(review({ items: [] }))).toBe('canvas');
  });

  it('reads the count from `planShape` rather than re-deriving it', () => {
    // The count has exactly one implementation after MOTIR-3262. Driving the two
    // through the same fixtures is what states that without asserting an
    // internal: they must agree for every shape.
    for (const items of [
      [at('a', 'wi_p')],
      [at('a', 'wi_p'), at('b', 'wi_q')],
      [at('a', null)],
      [],
    ]) {
      const expected = planContainerCount(items) > 1 ? 'list' : 'canvas';
      expect(defaultPlanView(review({ items }))).toBe(expected);
    }
  });
});

describe('the parameter name', () => {
  it('is `view`', () => {
    // Pinned because it is a public URL surface: a link written today must keep
    // resolving after any later change to how the default is computed.
    expect(PLAN_VIEW_PARAM).toBe('view');
  });
});

// ── THE DERIVED DEFAULT, WIDENED (MOTIR-4024, design Part XIII §6) ────────────
//
// The shipped rule saw a plan SPREAD across containers and was blind to one
// CROWDED inside a single container — which looks identical to the reader and is
// worse, because the cards are somewhere on the level rather than honestly
// absent.
//
// ⚠️ THE RULE IS THE DESIGN'S. Part XIII §6 measured 24 arrival scales in
// Chromium and found that `ARRIVAL_MIN_SCALE = 0.80` is NOT REACHABLE on this
// surface — the 22rem rail leaves the canvas 782px wide at 1440x900 against a
// world box 1000px wide on the 3-column band it measured, and 1720px on the
// 5-column band that ships now (MOTIR-10537). A predicate asking "does it clear
// the floor" answers *two nodes* and sends every plan to the list. The number is
// the largest level still at the canvas's own ceiling at the tightest viewport —
// 12 on three columns, 35 on five, and the block below re-runs that rule.
describe('the ARRIVAL LEVEL’s size decides the default too (MOTIR-4024)', () => {
  const level = (size: number, over: Partial<PlanReviewDto> = {}) =>
    planReview([planReviewItem({ planItemId: 'a1', parentNodeId: 'epic-1' })], {
      arrivalLevelSize: size,
      arrivalLevelTotal: size,
      ...over,
    });

  it('is the largest level still at the canvas’s own ceiling at 1366x768, re-run on the SHIPPED layout (MOTIR-10537)', () => {
    // Part XIII §6's rule, measured through the shipped layout and fit rather than
    // a copy of their arithmetic: the canvas box at the tightest viewport once the
    // pane fills the fold (§2), and the CEILING is the scale of a level one full
    // band row wide — no level of that width or more can arrive any larger.
    const box = { w: 708, h: 589 };
    const arrival = (n: number) => {
      const ids = Array.from({ length: n }, (_, i) => `n${i}`);
      const pos = deterministicLayout(ids, []);
      return fitView(
        nodesBounds(ids.map((id) => ({ x: pos[id]!.x, y: pos[id]!.y, w: NODE_W, h: NODE_H }))),
        box,
      ).scale;
    };
    const ceiling = arrival(LOOSE_BAND_COLS);
    let largest = LOOSE_BAND_COLS;
    while (arrival(largest + 1) >= ceiling) largest += 1;
    expect(ceiling).toBeCloseTo(0.3558, 4);
    expect(largest).toBe(ARRIVAL_LEVEL_MAX_NODES);
    // …and the boundary is a ROW boundary: one card more opens a row the height
    // term can no longer pay for.
    expect(ARRIVAL_LEVEL_MAX_NODES % LOOSE_BAND_COLS).toBe(0);
    expect(arrival(ARRIVAL_LEVEL_MAX_NODES + 1)).toBeLessThan(ceiling);
  });

  it('opens on the CANVAS at the boundary — thirty-five nodes is still at the ceiling', () => {
    expect(defaultPlanView(level(ARRIVAL_LEVEL_MAX_NODES))).toBe('canvas');
  });

  it('opens on the LIST one node past it', () => {
    // A case on each side of the boundary, because a threshold off by one is
    // exactly what a coverage percentage cannot see.
    expect(defaultPlanView(level(ARRIVAL_LEVEL_MAX_NODES + 1))).toBe('list');
  });

  it('opens on the LIST when the level is TRUNCATED, whatever its drawn size', () => {
    // The second arm, and it is not about legibility at all: the level read sorts
    // key-ASCENDING and discards the HIGHEST keys — the most recently created
    // cards — and a `modify` / `remove` targets a committed work item, so the
    // cards a plan is most likely to be about are the ones truncation drops. The
    // drawn size is capped AT the cap, so only the total can say this happened.
    expect(
      defaultPlanView(
        level(TREE_LEVEL_MAX_TAKE, {
          arrivalLevelSize: TREE_LEVEL_MAX_TAKE,
          arrivalLevelTotal: TREE_LEVEL_MAX_TAKE + 1,
        }),
      ),
    ).toBe('list');
    // …and a level exactly AT the cap, untruncated, is only judged on its size.
    expect(
      defaultPlanView(
        level(TREE_LEVEL_MAX_TAKE, {
          arrivalLevelSize: TREE_LEVEL_MAX_TAKE,
          arrivalLevelTotal: TREE_LEVEL_MAX_TAKE,
        }),
      ),
    ).toBe('list'); // still a list — 200 nodes is far past the legibility arm
  });

  it('keeps Part IX §3’s container arm, unchanged and LAST', () => {
    // A plan spread across containers has no single level that can show it,
    // whatever any level's size is.
    const straddling = planReview(
      [
        planReviewItem({ planItemId: 'a1', parentNodeId: 'epic-1' }),
        planReviewItem({ planItemId: 'a2', parentNodeId: 'story-1' }),
      ],
      { arrivalLevelSize: 2, arrivalLevelTotal: 2 },
    );
    expect(defaultPlanView(straddling)).toBe('list');
  });

  it('is unchanged for a small, single-container plan — the case that must stay a canvas', () => {
    expect(defaultPlanView(level(3))).toBe('canvas');
  });

  it('opens a plan with NO items on the CANVAS, whatever the level sizes say (MOTIR-10739)', () => {
    // An empty plan has no arrival container, so neither size describes a level of
    // it — an older read counted the project ROOT there, and a large project's root
    // sent every freshly started plan to an empty List. Both size arms, past both
    // thresholds, and the empty plan still opens on the canvas.
    const empty = (size: number, total: number) =>
      planReview([], { arrivalLevelSize: size, arrivalLevelTotal: total });
    expect(defaultPlanView(empty(ARRIVAL_LEVEL_MAX_NODES + 1, ARRIVAL_LEVEL_MAX_NODES + 1))).toBe(
      'canvas',
    );
    expect(defaultPlanView(empty(TREE_LEVEL_MAX_TAKE, TREE_LEVEL_MAX_TAKE + 50))).toBe('canvas');
    expect(defaultPlanView(empty(0, 0))).toBe('canvas');
    // …and ONE item is enough for the size arms to rule again.
    expect(defaultPlanView(level(ARRIVAL_LEVEL_MAX_NODES + 1))).toBe('list');
  });
});

describe('the PREMISE the legibility arm is justified against (MOTIR-6250)', () => {
  // `ARRIVAL_LEVEL_MAX_NODES`'s derivation reasons from a canvas width, and that
  // width comes from the frame: *"the plan detail's canvas is the `1fr` of a
  // `grid-cols-[1fr_22rem]`, so the rail takes 352px and the canvas is 782px wide
  // at 1440x900"*. MOTIR-6250 made the planning WORKSPACE's frame a resizable
  // split, so that premise is now true of one host and false of the other.
  //
  // It still holds where it is READ. `defaultPlanView` has exactly TWO production
  // callers, and each has been asked which frame it reasons about:
  //
  // - `PlanDetail`, which keeps the FIXED frame the derivation was measured in.
  // - `PlanningWorkspaceHost` (MOTIR-6155, Part XXI decision 2), which IS the
  //   split. Its seed is read on the plan's first proposed read, which is the same
  //   transition `PlanningResizableFrame` resets the rail on, so at the moment the
  //   seed is read the rail is at most its default `max(352px, a third)`. The
  //   overlay is full-bleed, with none of the app chrome the plan page's canvas
  //   loses, so the canvas is AT LEAST as wide as the plan page's at every viewport
  //   Part XIII §6 measured. The number was derived against the narrower frame.
  //
  // This test is what stops a THIRD caller becoming accidental, and stops the plan
  // page opting into the split without the derivation noticing: either one fails
  // here NAMING the derivation rather than letting a stale comment stand.
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

  it('has exactly TWO production callers — the plan detail and the workspace host', () => {
    const callers = [
      'components/planning/PlanDetail.tsx',
      'components/planning/PlanningWorkspaceHost.tsx',
    ];
    for (const c of callers) expect(read(c)).toMatch(/defaultPlanView\(/);
    // Any NEW production caller has to re-ask which frame it is reasoning about.
    const others = execFileSync(
      'git',
      ['grep', '-l', 'defaultPlanView(', '--', 'app', 'components', 'lib'],
      {
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter((f) => f && f !== 'lib/planning/planView.ts' && !callers.includes(f));
    expect(others).toEqual([]);
  });

  it('the workspace host seeds on the SAME transition the rail resets on', () => {
    // The premise above holds only because the seed is read when the rail is at
    // its default. The reset is keyed on `proposalPresent`, which the host feeds
    // from `paneReview !== null` — the same plan the seed effect waits for. (Since
    // MOTIR-6300 that is the PANE's plan: the live review from its first read, then
    // the proposed one, so both fire once, at the first read, and not at the
    // hand-over.)
    const host = read('components/planning/PlanningWorkspaceHost.tsx');
    expect(host).toMatch(/proposalPresent=\{paneReview !== null\}/);
    expect(host).toMatch(/setView\(defaultPlanView\(paneReview\)\)/);
  });

  it('the plan detail does NOT opt into the resizable split', () => {
    const planDetail = read('components/planning/PlanDetail.tsx');
    // Both cards say so in terms — MOTIR-6250's *"Does NOT change: … the plan
    // page's rail"* and MOTIR-6236's *"This host is NOT a split"*.
    expect(planDetail).not.toMatch(/\bresizable\b/);
  });

  it('the resizable frame is opt-in, so every other consumer keeps the fixed column', () => {
    const frame = read('components/planning/PlanningWorkspace.tsx');
    expect(frame).toMatch(/resizable = false/);
    expect(frame).toMatch(/md:grid-cols-\[1fr_22rem\]/);
  });
});
