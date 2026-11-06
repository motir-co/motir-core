// The RESIZABLE PLANNING SPLIT's geometry (MOTIR-6250), and the ONE clamp every
// caller goes through.
//
// ⚠️ NO `'use client'` DIRECTIVE, DELIBERATELY. These are pure numbers and pure
// functions, and they are read from BOTH sides of the render boundary: the client
// island that drags the divider (`lib/hooks/usePlanningRailWidth.ts`,
// `components/planning/PlanningResizableFrame.tsx`) and the plain module that
// derives the plan surface's arrival view (`lib/planning/planView.ts`). A shared
// symbol declared inside a client component would make every server-side importer
// a client reference — the boundary is a property of the MODULE the export lives
// in, not of the symbol — so this module exists precisely so neither side has to
// re-declare a number the other one also needs.
//
// ── WHERE THESE NUMBERS COME FROM ───────────────────────────────────────────
// Every one of them is a decision of the APPROVED design result on MOTIR-6249
// (`design/ai-chat/planning-workspace--resizable-split.mock.html` + its `##`
// section in `design/ai-chat/design-notes.md`). This module does not derive them
// and must not re-choose them; read the asset for the reasoning.

/**
 * The conversation pane's FLOOR, in CSS pixels — `22rem`, the width the rail
 * ships at today.
 *
 * It is the floor because it is the only narrow width this rail has ever been
 * drawn and MEASURED at: MOTIR-2225 measured the header row already full there
 * (status dot + `Motir AI` + mode chip), and both
 * `design/ai-chat/plan-change-run-live.mock.html` and MOTIR-6236's composer delta
 * draw at it. Below it every element in the rail is at a width nobody has drawn.
 */
export const RAIL_MIN_PX = 352;

/** The conversation's share of the split container on open — the requirement's "a third". */
export const RAIL_DEFAULT_FRACTION = 1 / 3;

/**
 * The conversation's CEILING as a fraction of the split container.
 *
 * Deliberately NOT a canvas pixel floor: `lib/planning/canvasGeometry.ts` puts a
 * full five-column level (MOTIR-10537) at 1376px wide at the `ARRIVAL_MIN_SCALE`
 * legibility floor, which with `arrivalView`'s 48px padding wants a 1472px canvas
 * — and the shipped surface is already below that at ordinary sizes, so a canvas
 * pixel floor would
 * be one the product does not honour today. What does not recover past half is the
 * MODEL — *the canvas IS the roadmap; the chat is a right rail* — because the
 * canvas's legibility is recoverable by pan and zoom and the model is not.
 */
export const RAIL_MAX_FRACTION = 0.5;

/**
 * Below this container width there is NO SPLIT — the panes stack and the divider
 * is not rendered at all.
 *
 * It is Tailwind's `md`, which is the breakpoint the frame already ships with
 * (`grid-cols-1 md:grid-cols-[1fr_22rem]`), inherited rather than invented: at
 * 768px the floor is 352px and half the container is 384px, so the whole travel
 * is 32px and the canvas is between 384px and 416px whatever anyone drags.
 */
export const SPLIT_MIN_CONTAINER_PX = 768;

/** One arrow press. 16px crosses 1440's 368px range in 23 presses. */
export const RAIL_KEYBOARD_STEP_PX = 16;

/** One `Shift` + arrow press — four steps, for crossing the range. */
export const RAIL_KEYBOARD_COARSE_STEP_PX = 64;

/** The reset-on-propose animation, in ms. Instant under `prefers-reduced-motion`. */
export const RAIL_RESET_DURATION_MS = 200;

/**
 * The persisted width's key.
 *
 * ⚠️ ONE GLOBAL KEY, in the `motir.*` namespace beside
 * `motir.shell.sidebar.collapsed` — and this CONTRADICTS MOTIR-6250's own
 * acceptance criterion, which asked for a key "scoped per user and per project,
 * never global". The card delegates the question in the same breath
 * (*"Persistence is whatever the design settles"*), and the design settled GLOBAL,
 * with its reasons: the number is about this person's screen and how they read
 * rather than about a project, and every member of the existing persisted-UI
 * family is global (`useSidebarCollapsed`, `useCommentsSort`,
 * `useAttachmentsView`, `useCollapsedLanes`), so a per-project key would ask
 * somebody to re-choose a width on every project they open and buy nothing. The
 * contradiction is amended on the card on the record rather than resolved
 * silently here.
 */
export const RAIL_WIDTH_STORAGE_KEY = 'motir.planning.railWidth';

/** Whether a container is wide enough to split at all. */
export function isSplittable(containerPx: number): boolean {
  return containerPx >= SPLIT_MIN_CONTAINER_PX;
}

/** The conversation's [min, max] for a given container, in CSS pixels. */
export function railBounds(containerPx: number): { min: number; max: number } {
  const max = containerPx * RAIL_MAX_FRACTION;
  // A container narrow enough that half of it is under the floor has no travel at
  // all; the floor wins, so `min` is never greater than `max` for any caller.
  return { min: Math.min(RAIL_MIN_PX, max), max };
}

/**
 * The conversation's width on OPEN — `clamp(352px, 33.333%, 50%)`.
 *
 * The upper bound never binds for the default (a third is always less than a
 * half); it is the DRAG ceiling, and it is written into the same expression so
 * there is one formula rather than two.
 */
export function defaultRailWidth(containerPx: number): number {
  const { min, max } = railBounds(containerPx);
  return Math.min(Math.max(containerPx * RAIL_DEFAULT_FRACTION, min), max);
}

/**
 * THE ONE CLAMP. The pointer, the arrow keys, `Home` / `End`, the reset and the
 * value read back out of storage all go through this — which is the only thing
 * that makes those five paths unable to disagree about what a legal width is.
 */
export function clampRailWidth(widthPx: number, containerPx: number): number {
  const { min, max } = railBounds(containerPx);
  if (!Number.isFinite(widthPx)) return defaultRailWidth(containerPx);
  return Math.min(Math.max(widthPx, min), max);
}

/**
 * The container width at which a third first reaches the floor — 1056px.
 *
 * Exported because it is the most useful number in the design for a reader: BELOW
 * it the default clamps to `RAIL_MIN_PX`, so the conversation opens at exactly the
 * width it shipped at before this change, and the resizable split is a no-op for
 * every split container between `SPLIT_MIN_CONTAINER_PX` and this.
 */
export const RAIL_DEFAULT_CROSSOVER_PX = RAIL_MIN_PX / RAIL_DEFAULT_FRACTION;
