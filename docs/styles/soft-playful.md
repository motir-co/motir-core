# Style — Soft / Playful (`data-style="soft-playful"`)

> The energetic pill-shape alternate. Shipped as the `[data-style='soft-playful']`
> block in [`app/globals.css`](../../app/globals.css) (Tier 2), registered in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts).

**Tagline:** More energy — rounded, generous, gently animated.
**Inspiration:** Figma's pill-shape language (50px pills, roomy spacing).

This is the STYLE (shape/feel) axis only. Colour is the independent
`data-palette` axis — Soft / Playful inherits whatever palette is active and
changes no hue. The block overrides ONLY shape/feel tokens.

## Feel-bearing dimensions

| Dimension             | Soft / Playful                                                                |
| --------------------- | ----------------------------------------------------------------------------- |
| Shape / silhouette    | Pill buttons (fully rounded) and large 24px card/input radii. Friendly.       |
| Border / stroke       | Same hairline borders as the base; identity comes from radius, not weight.    |
| Elevation philosophy  | Softer, more diffused shadows — surfaces float a touch more.                  |
| Surface / background  | Opaque, like the base — only the shape softens (colour stays the palette).    |
| Density rhythm        | Roomier — 20×12 button padding, 28px card padding, taller controls.           |
| Motion                | Gentler 200ms ease and a slightly deeper press scale for a springy feel.      |
| Typography            | Inherits the base type pairing; the personality is in shape, not type.        |
| Component silhouettes | Pill buttons, heavily-rounded inputs/cards/modals, rounder small affordances. |

## Token overrides (`[data-style='soft-playful']`)

Only shape/feel tokens — no colour token appears in the block:

- **Radius:** `--radius-btn: 9999px` (pill), `--radius-input: 24px`,
  `--radius-card: 24px`, `--radius-modal: 32px`, `--radius-control: 12px`,
  `--radius-kbd: 8px`.
- **Elevation:** softened `--shadow-card / -elevated / -modal`.
- **Density:** `--spacing-btn-x/y: 20/12`, `--spacing-input-x/y: 18/14`,
  `--spacing-card-padding: 28px`, roomier control/chip/kbd/tooltip spacing,
  `--height-control: 40px`.
- **Motion:** `--transition-duration: 200ms`, `--active-scale: 0.97`.

## Background: the Wave

The Wave (`@motir/design-system`, `wave` in the background registry) redraws per
style. Every style keeps the mark — the deep dip first and the crest later, the
lines gathering around the main content, the sliding band of the palette's wave
hues and the decision squares riding the lines — and changes only shape, stroke,
glow and motion. Under this style:

Shape: 16 rounded lines with round caps and joins. Stroke: 2.6px in the palette band. Glow: a soft diffused blur under every line; decision squares are rounded 16px chips on a soft shadow. Motion: a gentle springy bob on top of the drift.

Every ink is a token read off the live theme; "accent" is
`--el-showcase-decision`. Under reduced motion it holds one still frame. The
drawing is `packages/design-system/src/backgrounds/wave.ts` (MOTIR-11606), built
to the approved design in `design/backgrounds/` (MOTIR-11602).

## Background: Topography

Topography (`topography` in the background registry) is contour lines over a
slowly moving height map, redrawn per style. Every style keeps one seeded height
field drifting slowly, contoured by marching squares, and the feathered clear area
behind the main content. Under this style:

Shape: 8 levels with every other terrace washed in a faint palette tint. Stroke: 2.6px round-capped lines cycling the three palette hues. Glow: none. Motion: drift with a slow bob.

Every ink is a token read off the live theme; "accent" is
`--el-showcase-decision`. Under reduced motion it holds one still frame. The
drawing is `packages/design-system/src/backgrounds/topography.ts` (MOTIR-11617),
built to the approved design in `design/backgrounds/` (MOTIR-11602).
