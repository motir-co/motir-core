import type { PlanReviewDto } from '@/lib/dto/planReview';
import { planContainerCount } from '@/lib/planning/planShape';
import { TREE_LEVEL_MAX_TAKE } from '@/lib/planning/levelCaps';

// WHICH BODY the plan-detail pane shows — the canvas or the list (MOTIR-3239,
// `design/ai-planning/design-notes.md` Part VIII).
//
// A canvas is the right way to see SHAPE: where a proposal lands, what it hangs
// under, what blocks what. It is a poor way to answer *"what exactly am I
// approving?"*, which is a question about a SET — these cards get created, these
// get changed, this one gets archived. The work-item detail already learned this
// and shipped a List ↔ Graph switcher on its Children section; the plan detail is
// the same reader asking the same question about a different tree.
//
// This module is deliberately PURE and separate from the island: it holds the
// vocabulary, the URL parsing, and — the reason it exists at all — the DEFAULT,
// as one named symbol.

export type PlanViewDto = 'canvas' | 'list';

/**
 * The largest ARRIVAL LEVEL the canvas can still open as well as it can open
 * anything — **thirty-five nodes**, seven rows of the shipped 5-column
 * `deterministicLayout` loose band (`LOOSE_BAND_COLS`).
 *
 * ⚠️ THE RULE IS THE DESIGN'S (MOTIR-4024, design Part XIII §6); THE NUMBER IS
 * THAT RULE RE-RUN FOR FIVE COLUMNS (MOTIR-10537). Part XIII §6 fitted a closed
 * form to 24 arrival scales measured in Chromium — `min((W-96)/bw, (H-96)/bh)`
 * over `NODE_W`/`NODE_H` = 280x124 with the layout's 80/72 gaps — and set the
 * predicate to the largest level still at the canvas's own WIDTH-bound CEILING at
 * the tightest viewport (1366x768, a 708x589 canvas once the pane fills the
 * fold). It drew 12 from a 3-column band: a 1000px world box, a 0.612 ceiling,
 * and a fifth row (`bh` 908) falling to 0.543.
 *
 * The band is 5 columns now, so the world box of any level of five or more is
 * 1720px wide and the ceiling at 1366x768 is `612 / 1720` = 0.356. A row costs
 * 196px of height against that much smaller ceiling, so the height term stays
 * above it through SEVEN rows (`bh` 1300: 0.379) and falls under it at eight
 * (`bh` 1496: 0.330). Seven rows of five is 35. The same form puts the ceiling at
 * 0.306 / 0.399 / 0.678 at 1280x800 / 1440x900 / 1920x1080, where it holds for
 * nine, eight and six rows. `tests/planning/planView.test.ts` re-runs the closed
 * form against `LOOSE_BAND_COLS`, so a change to the band fails there NAMING this
 * derivation rather than leaving a stale number behind.
 *
 * What the wider band costs is the CEILING, not this threshold: a six-node level
 * arrives at 0.356 at 1366x768 where it arrived at 0.612 on three columns, and a
 * list does not make that level any more legible. Sending 13–35-node levels to
 * the list would only hide a canvas that draws them exactly as well as it draws
 * six.
 *
 * A legibility threshold picked in code is a guess wearing a constant's
 * authority; this one is the design's rule, re-run.
 */
export const ARRIVAL_LEVEL_MAX_NODES = 35;

/** The query parameter that carries the chosen view. */
export const PLAN_VIEW_PARAM = 'view';

export const PLAN_VIEW_VALUES = ['canvas', 'list'] as const satisfies readonly PlanViewDto[];

/**
 * WHICH VIEW a plan opens in when the URL says nothing — DERIVED from the plan's
 * own shape (MOTIR-3262, `design/ai-planning/design-notes.md` Part IX §3).
 *
 * **The canvas when the plan lives on one level; the LIST when its proposals sit
 * under MORE THAN ONE distinct container.**
 *
 * A straddling plan has no single canvas level that can show it — the canvas
 * draws one level at a time — so opening on it is the surface insisting on a view
 * that structurally cannot answer the question the reader came with. The list
 * already exists by then, and making it the default in that one case is the
 * cheapest of Part IX's three fixes and the one that admits the most.
 *
 * WHAT COUNTS AS A CONTAINER is `planShape`'s answer, not a second one: a
 * distinct `parentNodeId`, whether that parent is committed or itself proposed,
 * with **`null` — a root proposal — counting as ONE container, the top level**.
 * So a plan of pure roots has exactly one and opens on the canvas. There is no
 * second implementation of that question after this card.
 *
 * ⚠️ THIS IS A SEED, READ ONCE, and the island reads it on every render only
 * because the URL is the source of truth and this is its fallback. A `generating`
 * plan can cross the one-container threshold WHILE a reviewer is looking at it —
 * the detail re-fetches every 2.5s — and a reader must never be moved between
 * views by a poll tick. `PlanDetail` pins the first answer for that reason.
 *
 * The property that survives from MOTIR-3239 unchanged is the CLEAN URL: the
 * default writes no query parameter, whatever the default is, so every existing
 * `/plans/[id]` link stays byte-identical.
 */
export function defaultPlanView(review: PlanReviewDto): PlanViewDto {
  // ⚠️ A PLAN WITH NO PROPOSALS OPENS ON THE CANVAS, before either size arm
  // (MOTIR-10739). With nothing proposed there is no arrival container: the
  // review's `arrivalLevelSize` / `arrivalLevelTotal` describe no level of THIS
  // plan, and an older read counted the PROJECT ROOT in their place — so a large
  // project sent every freshly started plan to an empty List ("Nothing proposed
  // yet") and the pin above kept it there for the whole session. The canvas is
  // where an empty plan's reader watches it arrive: the planning workspace opens
  // it at the launch's level and follows the target, and the plan page opens it
  // at the root. Neither size arm can say anything about a plan with no items.
  if (review.items.length === 0) return 'canvas';

  // ⚠️ THE TRUNCATION ARM NEXT, because it is not about legibility at all
  // (MOTIR-4024, Part XIII §6). A level past `TREE_LEVEL_MAX_TAKE` is read
  // key-ASCENDING and the read discards the HIGHEST keys — the most recently
  // created cards — and a `modify` / `remove` targets a committed work item, so
  // the cards a plan is most likely to be about are exactly the ones truncation
  // drops. Past the cap the canvas can draw two hundred cards, ring none of them,
  // and show a reviewer a plan whose subject is not on the screen. That is worse
  // than illegible: it is absent while looking complete.
  if (review.arrivalLevelTotal > TREE_LEVEL_MAX_TAKE) return 'list';

  // ⚠️ THE LEGIBILITY ARM, AND ITS RULE IS THE DESIGN'S — do not pick a new one,
  // exactly as `canvasGeometry.ts` does not re-derive `ARRIVAL_MIN_SCALE`. The
  // number is that rule re-run for the 5-column band (MOTIR-10537); see
  // `ARRIVAL_LEVEL_MAX_NODES`.
  //
  // Part XIII §6 measured 24 arrival scales in Chromium, six level sizes across
  // four viewports, against a closed form that reproduces every one of them. The
  // finding that decides this line is that `ARRIVAL_MIN_SCALE = 0.80` is NOT
  // REACHABLE on this surface: the plan detail's canvas is the `1fr` of a
  // `grid-cols-[1fr_22rem]`, so the rail takes 352px and the canvas is 782px wide
  // at 1440x900 against a 1720px world box at five columns — a width term of
  // 0.399 before the level's height is considered at all, and 0.306 at 1280x800.
  // A THREE-node level already misses the floor. So the predicate cannot be "does
  // it arrive above the floor" (that answers *two nodes* and sends every plan to
  // the list); it is the largest level still at the canvas's OWN ceiling at the
  // tightest viewport, which is seven rows of the shipped 5-column layout.
  //
  // ⚠️ AND THE `grid-cols-[1fr_22rem]` ABOVE IS THE PLAN DETAIL'S FRAME, WHICH IS
  // STILL FIXED — read it as a premise about THAT host, not about every planning
  // surface (MOTIR-6250). The planning WORKSPACE's frame became a resizable split
  // whose rail is `clamp(352px, 33.333%, 50%)`, so a canvas width derived from a
  // constant `22rem` would be wrong there. It reaches this computation through
  // exactly two production callers, and each was asked which frame it reads:
  // `PlanDetail` (`:396`) deliberately does NOT opt into the split — MOTIR-6250
  // (*"Does NOT change: … the plan page's rail"*) and MOTIR-6236 (*"This host is
  // NOT a split"*) both say so — and `PlanningWorkspaceHost` (MOTIR-6155, Part XXI
  // decision 2) IS the split, but seeds on the plan's first proposed read, the same
  // transition the rail resets on. So at that moment the rail is at most
  // `max(352px, a third)` of a FULL-BLEED overlay, and the canvas is at least as
  // wide as the plan page's at every viewport Part XIII §6 measured: the number was
  // derived against the narrower frame. `tests/planning/planView.test.ts` pins both:
  // a third caller, or the plan page opting in, fails NAMING this derivation.
  if (review.arrivalLevelSize > ARRIVAL_LEVEL_MAX_NODES) return 'list';

  // Part IX §3's arm, unchanged and last: a plan SPREAD across containers has no
  // single level that can show it, whatever any level's size is.
  return planContainerCount(review.items) > 1 ? 'list' : 'canvas';
}

/**
 * The view a URL selects, falling back to a default the CALLER has already
 * resolved.
 *
 * ⚠️ IT TAKES THE RESOLVED DEFAULT, NOT THE REVIEW (MOTIR-3262). The default is a
 * SEED — the answer for the reader arriving — and a `generating` plan's item set
 * grows under a 2.5s poll, so recomputing it on every render would move a
 * reviewer between views mid-read. The island computes `defaultPlanView` ONCE at
 * mount and passes that value here, which makes "read once" structural rather
 * than a rule somebody has to remember.
 *
 * Unknown, absent and malformed values all take the default rather than erroring
 * — the value comes from a URL a person can type, and there is no reading on
 * which `?view=nonsense` is worth a failure.
 */
export function planViewFromParam(
  raw: string | null | undefined,
  fallback: PlanViewDto,
): PlanViewDto {
  return (PLAN_VIEW_VALUES as readonly string[]).includes(raw ?? '')
    ? (raw as PlanViewDto)
    : fallback;
}
