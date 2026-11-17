// Acceptance-criteria bodies of real `type: design` cards that the
// SELF-BLOCKING-DESIGN prose predicate reads as drawing AND building (MOTIR-6245).
//
// Both are the design card's OWN criteria: the card draws panels and builds
// nothing, so the advisory's LIFT remedy — move the drawing into its own
// `type: design` card — is incoherent for it. They are shared by the pure, the
// validate and the dispatch suites so the three pin one population.

/**
 * MOTIR-6236's acceptance criteria as they stand after its 2026-09-24 re-scope,
 * verbatim except that the `[MOTIR-6249](motir:…)` link in criterion 1 is
 * replaced by the words *the resizable split*, so the body carries no reference
 * for the reference scan to resolve.
 *
 * Criterion 2 (*"Panel 12 draws the composer at the conversation's MINIMUM
 * width…"*) identifies its panel by NUMBER and names no asset, so the
 * per-criterion design-asset exclusion misses it and it is read as building a
 * surface. As filed, the bug reported criterion 3 (*"Panels 2, 3 and 10 show
 * that growth moves nothing outside the rail…"*), the same panel-number shape;
 * the re-scope reordered and reworded the criteria, and the current text is
 * pinned because it is the durable source.
 */
export const MOTIR_6236_DESIGN_CARD_CRITERIA = [
  '## Acceptance criteria',
  '',
  '- The delta mock carries all twelve panels, in light and dark, **at the width the resizable split',
  "  settles** — not at `22rem`. Each is composed from the shipped components' markup, not a stand-in.",
  "- Panel 12 draws the composer at the conversation's MINIMUM width with the `@` trigger, the field",
  '  and Send all usable.',
  '- `design/ai-chat/design-notes.md` states the cap as a row count with its arithmetic at the new',
  '  width, where the `@` trigger and Send align, that the resize handle is gone, and the',
  '  keyboard-hint decision with its cited references.',
  '- Panels 2, 3 and 10 show that growth moves nothing outside the pane the composer sits in.',
  '- Panel 9 draws a multi-line user bubble and a long unbroken token wrapping inside it.',
  '- `design/ai-planning/design-notes.md` Part XII carries an amendment pointer to the delta.',
  "- The board is RENDERED and its boxes measured before the PR — a lifted stylesheet's missing",
  '  rules and tree-shaken tokens are invisible in the markup.',
].join('\n');

/**
 * The second sub-shape (the comment on MOTIR-6245): MOTIR-6241's criterion 2, the
 * design-against-shipped-reality precondition, quoted verbatim. It obliges the
 * card to LOOK AT a surface somebody else built and reads as one that BUILDS a
 * surface. The design-asset criterion beside it is synthetic — MOTIR-6241's
 * reported design criterion was its fifth — and placed first so the pair is
 * formed without depending on the rest of that card's body.
 */
export const MOTIR_6241_DESIGN_CARD_CRITERIA = [
  '## Acceptance criteria',
  '',
  '1. `design/ai-planning/design-notes.md` carries the new section and the delta mock is built from',
  '   the real design system.',
  '2. The shipped surface is RENDERED before anything is drawn (the live app, or a headless render of',
  '   the real `PlanReviewCanvas` + real `globals.css`), and the notes say which.',
].join('\n');
