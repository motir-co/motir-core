# Style — Dense / Pro (`data-style="dense-pro"`)

> The compact, information-dense alternate for power users. Its token block is
> the `[data-style='dense-pro']` block in
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css),
> and it is registered in
> [`packages/design-system/src/theme/styles.ts`](../../packages/design-system/src/theme/styles.ts)
> after `retrofuturism`. This document is the style's design record: the code
> card transcribes every value below and re-derives none of them. The mock is
> [`design/styles/dense-pro.mock.html`](../../design/styles/dense-pro.mock.html).

| field         | value                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id            | `dense-pro`                                                                                                                                                              |
| name          | `Dense / Pro`                                                                                                                                                            |
| tagline       | `Compact and information-dense — more rows, less chrome, a faster rhythm.`                                                                                               |
| inspiration   | `Pro-tool density — Material Design 3's density scale and a mail client's Compact inbox view: the same surfaces, drawn tighter, one 4px notch down the vertical rhythm.` |
| defaultTypeId | `motir-sans`                                                                                                                                                             |
| designDoc     | `docs/styles/dense-pro.md`                                                                                                                                               |

**Wrong moods:** roomy, soft, glassy, decorative, slow.

This is the STYLE (shape/feel) axis only. **Colour is the independent
`data-palette` axis**: Dense / Pro inherits whatever palette is active and
changes no hue. The block sets shape/feel tokens only, and no `--color-*`,
`--el-*` or `--font-*` token.

## Reference

**What was checked.** Material Design 3's density guidance
(<https://m3.material.io/foundations/layout/grids-spacing/density>) numbers its
scale from 0 downward — it "moves to negative numbers (-1, -2, -3) as space
decreases" — and says "higher density is typically applied by decreasing the top
and bottom padding or overall height by 4dp". Material's note _Using Material
Density on the Web_ (<https://m3.material.io/blog/material-density-web>) adds two
limits this design leans on: "each increment also decreases the height of a
component by 4px", and density "does not affect the horizontal spacing within" a
component. The second anchor is a shipped product's display-density control:
**Gmail's Settings → Density: Default / Comfortable / Compact**, a density chosen
once for the whole product rather than per screen — the same shape of choice as
a style picked beside palette and type.

**What Dense / Pro takes from them.** The vertical step: Warm Editorial's 36px
control to 32px is exactly one 4px density increment, and its 40px button to
32px is two. And the choice is made once and applies everywhere.

**Where it deliberately departs.** Material's web density leaves horizontal
spacing alone. The story asks for controls AND padding to be visibly tighter, so
Dense / Pro moves the horizontal values too: button padding 18 → 12, card
padding 24 → 16, row padding 10 → 6. That is a recorded decision, not drift.

**What is not claimed.** Neither source is a Motir screen, and nothing here is a
measurement of Motir's rendering. Every contrast ratio about this style is
measured by the story's style × palette × mode gate, not inferred from these
values.

## Feel-bearing dimensions

One line per key of `STYLE_DIMENSIONS`, written to paste into
`STYLE_REGISTRY['dense-pro'].dimensions` unedited.

| key        | line                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| silhouette | Compact near-square corners — 4px buttons and inputs, 6px cards, 8px modals. Tighter than Warm Editorial without Swiss's hard right angles.                                                                                   |
| stroke     | Hairline 1px structure only. With elevation pulled back to a shadow so shallow it never reads as a frame, the palette's hairline rule becomes the only thing dividing a dense surface from its neighbour.                     |
| elevation  | Near-flat by design — a 1-2px shadow on resting surfaces instead of a soft bloom, so rows stay legible in long lists and nothing lifts off the page to compete with content. Only modals keep a real lift.                    |
| surface    | Opaque and untinted — panels are told apart by the hairline rule and the tighter rhythm, never by a wash, a tint or a floating shadow.                                                                                        |
| density    | The identity axis, and the tightest rhythm in the library: 12x6 button padding, 32px buttons and controls, 16px card padding, 6px row padding — one 4px density notch tighter than Warm Editorial's controls.                 |
| motion     | Quick and functional — 100ms transitions and a 1% press scale, so a click confirms itself without the control appearing to move.                                                                                              |
| typography | All-sans — the motir-sans pairing puts Inter on headlines and body over JetBrains Mono meta, so a dense screen keeps one voice instead of two.                                                                                |
| components | Compact rectangular buttons and inputs (4px), near-rectangular 3px status chips, dense table and sidebar rows on a 32px rhythm, hairline-ruled flat cards; the hero AI pill and orb flatten to a hairline-rimmed accent chip. |

## Default type

`defaultTypeId: 'motir-sans'` — a registered entry of `TYPE_REGISTRY`
(`packages/design-system/src/theme/typography.ts`) whose faces are Inter
headlines and body over JetBrains Mono meta. With no type pinned the app renders
that pairing under this style; **a pinned type always overrides it**.

## Token values — the block's content

The base column is Motir's Tier-0 base, the `@theme` block of
`packages/design-system/theme.css`. Warm Editorial IS that base. Its
`[data-style='warm-editorial']` block (Tier 2, directly above the other style
blocks) repeats the same values token for token so that a nested base-style
scope shadows a foreign active style; it is a mirror of `@theme`, not a second
source, so either can be used to re-check this column.

**Radius (silhouette)**

| token              | base          | Dense / Pro |
| ------------------ | ------------- | ----------- |
| `--radius-xs`      | 4px           | 2px         |
| `--radius-sm`      | 6px           | 3px         |
| `--radius-md`      | 8px           | 4px         |
| `--radius-lg`      | 12px          | 6px         |
| `--radius-xl`      | 16px          | 8px         |
| `--radius-btn`     | 8px           | 4px         |
| `--radius-input`   | 8px           | 4px         |
| `--radius-card`    | 12px          | 6px         |
| `--radius-modal`   | 12px          | 8px         |
| `--radius-badge`   | 9999px (pill) | 3px         |
| `--radius-control` | 6px           | 3px         |
| `--radius-kbd`     | 4px           | 3px         |

`--radius-pill` (9999px) is deliberately untouched, so genuinely circular
affordances — avatars, status dots, the spinner — stay round.

**Elevation (shadow)**

| token                  | base                                      | Dense / Pro                               |
| ---------------------- | ----------------------------------------- | ----------------------------------------- |
| `--shadow-subtle`      | `0 1px 2px rgba(15, 15, 15, 0.04)`        | `0 1px 1px rgba(15, 15, 15, 0.03)`        |
| `--shadow-card`        | `0 4px 12px rgba(15, 15, 15, 0.08)`       | `0 1px 2px rgba(15, 15, 15, 0.06)`        |
| `--shadow-elevated`    | `0 8px 24px rgba(15, 15, 15, 0.12)`       | `0 4px 8px -2px rgba(15, 15, 15, 0.10)`   |
| `--shadow-modal`       | `0 16px 48px -8px rgba(15, 15, 15, 0.16)` | `0 12px 32px -8px rgba(15, 15, 15, 0.16)` |
| `--shadow-hero-mockup` | `0 24px 48px -8px rgba(15, 15, 15, 0.2)`  | `0 12px 24px -6px rgba(15, 15, 15, 0.16)` |

Shadow ink stays a literal rgba, as in the base and every shipped style block:
the axis rule forbids colour _tokens_, and a shadow's ink is not one.
`--shadow-flat` stays at its `none` base and is not restated.

**Density — spacing**

| token                    | base | Dense / Pro |
| ------------------------ | ---- | ----------- |
| `--spacing-btn-x`        | 18px | 12px        |
| `--spacing-btn-y`        | 10px | 6px         |
| `--spacing-btn-x-sm`     | 12px | 10px        |
| `--spacing-btn-y-sm`     | 8px  | 6px         |
| `--spacing-input-x`      | 16px | 10px        |
| `--spacing-input-y`      | 12px | 8px         |
| `--spacing-card-padding` | 24px | 16px        |
| `--spacing-control-x`    | 10px | 6px         |
| `--spacing-control-y`    | 6px  | 4px         |
| `--spacing-icon-btn`     | 4px  | 3px         |
| `--spacing-chip-x`       | 10px | 6px         |
| `--spacing-kbd-x`        | 6px  | 4px         |
| `--spacing-kbd-y`        | 2px  | 2px (kept)  |
| `--spacing-tooltip-x`    | 8px  | 6px         |
| `--spacing-tooltip-y`    | 4px  | 3px         |

**Density — heights.** These make the compaction visible: many buttons paint an
explicit height utility rather than deriving their height from padding, so a
padding-only change would leave them 40px tall.

| token              | base | Dense / Pro |
| ------------------ | ---- | ----------- |
| `--height-btn-sm`  | 32px | 28px        |
| `--height-btn-md`  | 40px | 32px        |
| `--height-btn-lg`  | 48px | 40px        |
| `--height-input`   | 44px | 36px        |
| `--height-control` | 36px | 32px        |

**Motion**

| token                   | base  | Dense / Pro |
| ----------------------- | ----- | ----------- |
| `--transition-duration` | 150ms | 100ms       |
| `--transition-fast`     | 100ms | 80ms        |
| `--transition-slow`     | 250ms | 140ms       |
| `--active-scale`        | 0.98  | 0.99        |
| `--hover-scale`         | 1     | 1 (held)    |

A dense UI does not grow under the cursor, so the hover scale is held at 1.
`--active-scale: 0.99` is a small, deliberate confirmation: on a 32px control it
moves 0.32px, which reads as a click without the control appearing to animate,
and it is distinct from Swiss's zero-scale calm.

**Left at the shipped value, on purpose:** `--spacing-rail-inset` (0px),
`--width-rail-chrome` (20px — a style moves the CONTROL and the rail follows
it), `--focus-ring-width` and `--focus-ring-offset` (2px each — a dense style
must not lose focus visibility), `--radius-pill`, `--spacing-kbd-y`,
`--hover-scale`, and every one of the 21 derived density steps.

The block above, as the code card writes it:

```css
[data-style='dense-pro'] {
  --radius-xs: 2px;
  --radius-sm: 3px;
  --radius-md: 4px;
  --radius-lg: 6px;
  --radius-xl: 8px;
  --radius-btn: 4px;
  --radius-input: 4px;
  --radius-card: 6px;
  --radius-modal: 8px;
  --radius-badge: 3px;
  --radius-control: 3px;
  --radius-kbd: 3px;
  --shadow-subtle: 0 1px 1px rgba(15, 15, 15, 0.03);
  --shadow-card: 0 1px 2px rgba(15, 15, 15, 0.06);
  --shadow-elevated: 0 4px 8px -2px rgba(15, 15, 15, 0.1);
  --shadow-modal: 0 12px 32px -8px rgba(15, 15, 15, 0.16);
  --shadow-hero-mockup: 0 12px 24px -6px rgba(15, 15, 15, 0.16);
  --spacing-btn-x: 12px;
  --spacing-btn-y: 6px;
  --spacing-btn-x-sm: 10px;
  --spacing-btn-y-sm: 6px;
  --spacing-input-x: 10px;
  --spacing-input-y: 8px;
  --spacing-card-padding: 16px;
  --spacing-control-x: 6px;
  --spacing-control-y: 4px;
  --spacing-icon-btn: 3px;
  --spacing-chip-x: 6px;
  --spacing-kbd-x: 4px;
  --spacing-kbd-y: 2px;
  --spacing-tooltip-x: 6px;
  --spacing-tooltip-y: 3px;
  --height-btn-sm: 28px;
  --height-btn-md: 32px;
  --height-btn-lg: 40px;
  --height-input: 36px;
  --height-control: 32px;
  --transition-duration: 100ms;
  --transition-fast: 80ms;
  --transition-slow: 140ms;
  --active-scale: 0.99;
  --hover-scale: 1;
}
```

## Derived density steps

The steps are not written per style. `packages/design-system/theme.css` derives
each one from its base in a single `:root, [data-style]` rule —
`value = round(nearest, base × n / reference px, 1px)` — so a style that moves a
base moves every step with it, and the block declares bases only. Under Warm
Editorial each step equals its own name in px; under Dense / Pro the same 21
steps resolve as below. **All 21 are positive whole pixels.**

| base token               | ref px | Dense / Pro base | step → resolved                             |
| ------------------------ | ------ | ---------------- | ------------------------------------------- |
| `--spacing-card-padding` | 24     | 16px             | 16 → 11, 12 → 8, 8 → 5, 4 → 3               |
| `--spacing-control-x`    | 10     | 6px              | 16 → 10, 12 → 7, 8 → 5, 6 → 4, 4 → 2, 2 → 1 |
| `--spacing-control-y`    | 6      | 4px              | 8 → 5, 4 → 3, 2 → 1                         |
| `--spacing-chip-x`       | 10     | 6px              | 8 → 5, 6 → 4, 4 → 2, 2 → 1                  |
| `--height-control`       | 36     | 32px             | 28 → 25, 32 → 28, 40 → 36, 48 → 43          |

**The closest call is `--height-control-28`:** 32 × 28 / 36 = 24.889, so
**25px**. That value is load-bearing:

1. The density suite (`tests/theme/densityIntegration.test.ts`) requires every
   one of the 21 steps to have a live site in the tree, with one accepted
   exception (`--spacing-chip-x-2`), so `--height-control-28` renders somewhere
   real.
2. **24px is WCAG 2.5.8's minimum target size.** At a 30px base that step would
   resolve to 23px (23.33), under the minimum. **32px is therefore the smallest
   base this style may have** — and it is exactly one 4px density notch below
   Warm Editorial's 36px, the increment Material documents.

Nothing else is near a rounding hazard. The fractional values are 10.667, 9.6,
7.2, 4.8, 3.6, 2.4, 1.2, 5.333, 2.667, 1.333, 24.889, 28.444, 35.556 and
42.667; none lands on a half pixel, and the smallest resolved value anywhere
(1px, on the rarely rendered control-x-2 and chip-x-2 steps) never rounds to 0.

## Why this is more than a token swap

- **Which primitives consume what.** `Button` reads `--radius-btn`,
  `--spacing-btn-x` and `--height-btn-{sm,md,lg}` (its height is fixed by the
  height token, which is why the heights move); `Input` reads `--radius-input`,
  `--spacing-input-x` and `--height-input`; `Card` reads
  `--radius-card`, `--spacing-card-padding` (and its steps) and `--shadow-card`;
  menu, list, combobox and sidebar rows read `--radius-control`,
  `--spacing-control-x/y` and `--height-control` with their steps; `Pill` reads
  `--radius-badge` and `--spacing-chip-x/y`; `Modal` reads `--radius-modal`,
  `--shadow-modal` and `--spacing-card-padding`. Every one of them follows the block with no component edit.
- **Density → rail width.** The collapsed rail is composed from
  `--height-control`, so shrinking the control narrows the chrome (below). That
  is the axis working, and the reason the rail tokens are left alone.
- **Density → step resolution.** The control base is bounded from below by the
  24px floor on its smallest derived step, not by taste.
- **Motion → press feedback.** The faster transitions and the 0.99 press scale
  are paired: a long transition with a tiny scale would read as lag.

## The rail and the chrome

`--width-rail-chrome` stays 20px and `--spacing-rail-inset` stays 0px, so the
collapsed rail is composed exactly as it is today — chrome plus one control
square — and stays flush (`tests/theme/immersiveShellChrome.test.ts`).

|                                     | Warm Editorial | Dense / Pro    |
| ----------------------------------- | -------------- | -------------- |
| rail column                         | 20 + 36 = 56px | 20 + 32 = 52px |
| content box (rail minus 8, 8 and 1) | 39px           | 35px           |
| row control                         | 36px           | 32px           |
| slack                               | 3px            | 3px            |

The rail narrows because the control narrowed, and the control still fits its
track with the same 3px slack the shipped styles have, so no horizontal
scrollbar appears in the rail's scroller
(`tests/theme/railTracksControlHeight.test.ts`).

## The hero AI control

`tests/theme/aiCtaStyleSeam.test.ts` derives the styles owing a treatment from
`STYLE_IDS` minus the base and the depth-only style, so Dense / Pro owes the
plan-with-AI pill (`components/planning/PlanWithAILauncher.tsx`) and the orb
(`components/planning/PlanWithAIFab.tsx`) a rule. The components declare
`background-image` and `box-shadow` inline, so the treatment is written onto
the four seam variables (`--plan-hero-fill`, `--plan-orb-fill`,
`--plan-hero-shadow`, `--plan-orb-shadow`) inside `@scope ([data-style='dense-pro']) to ([data-style])` blocks under
`[data-surface='ai-cta']`, one rule per block (the shape the registry suite reads).

- **Geometry is not restated.** The pill's radius, padding and height already
  flow through `--radius-badge` (3px here), `--spacing-btn-x` (12px) and
  `--height-btn-md` (32px), so it becomes a compact 32px chip with no rule
  saying so. The orb is a fixed 56px circle (`h-14 w-14 rounded-full`) under
  every style and stays one.
- **Pill fill** — flat and accent-dominant, not a sheen: a 135° gradient from
  `color-mix(in srgb, var(--el-accent) 92%, var(--el-highlight))` to
  `var(--el-accent)`. Every stop stays at or above 92% accent, shallower than
  the component's own fallback, whose far stop is 86% accent — the value at
  which the label measured 5.97:1 light and 4.64:1 dark, because the label spans
  the whole pill.
- **Orb fill** — the shipped lit-sphere geometry (`circle at 33% 27%`) carried
  flat: the crown keeps the shipped first stop
  (`color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent))`),
  the body is accent to 45%, and the rim mixes 12% toward the page ground
  instead of toward the highlight, so the sphere reads as a plate. The crown sits
  inside the glyph box and is the sphere's lightest point, and the mark is
  `--el-accent-text`: the code card must hold the mark's ratio there, and
  `--orb-lit-mix` — the guarded knob measured across twenty palette × theme
  contexts (`tests/theme/orb-glyph-contrast.test.ts`) — is read, never
  re-declared.
- **Shadows** — one whisper on both controls, no bloom:
  `0 1px 2px 0 color-mix(in srgb, var(--el-accent) 22%, transparent)`.
- **Structure is a hairline, not a shadow.** The edge is a
  `border: 1px solid color-mix(in srgb, var(--el-accent) 55%, var(--el-border-strong))`,
  so no control depends on a shadow to show where it ends.
- **No animation** is added, so there is nothing new to gate behind
  `prefers-reduced-motion`; the shipped shimmer and pulse stay behind the gate
  they already sit behind.
- Palette-derived throughout, so a palette swap re-tints the pill, the orb and
  the rim and changes no shape.

```css
@scope ([data-style='dense-pro']) to ([data-style]) {
  [data-surface='ai-cta'] {
    --plan-hero-shadow: 0 1px 2px 0 color-mix(in srgb, var(--el-accent) 22%, transparent);
    --plan-orb-shadow: 0 1px 2px 0 color-mix(in srgb, var(--el-accent) 22%, transparent);
    border: 1px solid color-mix(in srgb, var(--el-accent) 55%, var(--el-border-strong));
  }
}
@scope ([data-style='dense-pro']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    --plan-hero-fill: linear-gradient(
      135deg,
      color-mix(in srgb, var(--el-accent) 92%, var(--el-highlight)),
      var(--el-accent)
    );
  }
}
@scope ([data-style='dense-pro']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='orb'] {
    --plan-orb-fill: radial-gradient(
      circle at 33% 27%,
      color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent)) 0%,
      var(--el-accent) 45%,
      color-mix(in srgb, var(--el-accent) 88%, var(--el-page-bg)) 100%
    );
  }
}
```

Dense / Pro ships no other `@scope` material layer: it is not one of the
story's material styles, and its identity is the rhythm, not a surface.

## States

- **Light and dark, every registered palette, at rest** — the block sets no
  colour token, so every shape, spacing and motion value is identical in light
  and dark and under every palette; only the palette's own layer differs.
- **Control interaction states** — the style's own contributions are pressed
  (`--active-scale` 0.99) and the untouched 2px focus ring. Hover and disabled
  stay palette-driven and are not re-styled.
- **The hero AI control, both forms** — at rest, hover, `focus-visible` and
  pressed, light and dark: the fill and shadow above, nothing else.
- **Reduced motion** — the style adds no animation, so it changes nothing here.
- **Empty, loading and error states** — no state-specific rule: a skeleton keeps
  `--radius-control`, an empty-state panel keeps `--radius-card` and the shallow
  card shadow, an error banner keeps the palette's danger colour. The omission
  is deliberate.
- **Unknown `data-style` value** — resolves to Warm Editorial through
  `resolveStyle`, unchanged.

## Accessibility

- **No colour token changes**, so the palette's ratios are untouched by
  construction; the story's style × palette × mode gate measures them anyway.
- **The 24px floor** holds on every resolved control step (smallest: 25px).
- **The focus ring stays 2px wide with a 2px offset.**

## What this record does not write

No registry entry, no CSS and no test: the code card
(_Dense/Pro — registry entry, token block, density proof and hero AI-control
treatment_) creates the `dense-pro` id and writes all three from this record.
Where the shipped CSS cannot carry a value fixed here, that card corrects this
document in the same pull request, with the measurement that forced it.
