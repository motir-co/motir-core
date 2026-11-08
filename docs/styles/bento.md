# Style — Bento (`data-style="bento"`)

> Calm, equal compartments. Its token block is the `[data-style='bento']` block in
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css)
> (which `app/globals.css` imports), with its three hero rules beside it, and it
> is registered in
> [`packages/design-system/src/theme/styles.ts`](../../packages/design-system/src/theme/styles.ts)
> (which `lib/theme/styles.ts` re-exports), in the gallery slot after
> `retrofuturism`. This document is the style's design record; the mock is
> [`design/styles/bento.mock.html`](../../design/styles/bento.mock.html).

| field         | value                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| id            | `bento`                                                                                                                                               |
| name          | `Bento`                                                                                                                                               |
| tagline       | `Even, generous tiles — one radius, hairline gutters and a near-flat plate, so the work sits in calm compartments.`                                   |
| inspiration   | `Apple's bento-grid product pages — compartments sharing one corner radius, separated by even gutters, each tile near-flat with a generous interior.` |
| defaultTypeId | `motir-sans`                                                                                                                                          |
| designDoc     | `docs/styles/bento.md`                                                                                                                                |

**Not Bento:** loud, angular, skeuomorphic, glassy, dense.

This is the STYLE (shape/feel) axis only. **Colour is the independent
`data-palette` axis**, and Bento touches no colour at all.

## Reference

The look is drawn from Apple's bento-grid product pages. **Apple's own pages were
not loaded when this record was written**, and nothing here rests on them. What
was checked is the published bento-grid convention —
<https://www.setproduct.com/blog/bento-grid-layout-design-guide> — which is where
the numbers come from: tile radii of 12–24px with 16–24px the common band,
uniform gutters typically 12–24px, **gap and corner radius linked rather than
independent choices**, and varied tile footprints a property of the grid rather
than of a surface.

Three values follow from it: the tile radius sits at 20px, inside the published
band rather than at the base's 12px; the gutter is set above that radius,
because a gutter tighter than the radius reads two tiles as one merged shape;
and varied footprints are named below as the part of the look this axis cannot
deliver.

## Feel-bearing dimensions

| key        | line                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| silhouette | One generous radius for tiles (20px), a tighter one for controls (12px) and one for chips (10px); no two tiles differ, and no tile shares a control's corner.                     |
| stroke     | Hairline edges divide the compartments; the shadow only decorates. No heavy outline, no drawn frame, no border doing decoration's work.                                           |
| elevation  | A near-flat five-rung ladder — a whisper at the low rungs, with a real lift kept only for the modal and the hero mockup, so nothing competes with the content.                    |
| surface    | Opaque palette tiles — no tint, no texture, no translucency, and no canvas of the style's own; a tile is told apart by its radius, its gutter and its hairline.                   |
| density    | 38px controls, 24px card padding and gutters wider than the tile radius, so tiles read as separate compartments; control padding 12 × 8, chip padding 12.                         |
| motion     | 180ms transitions, no hover scale and a faint 0.99 press — the grid stays still and only the surface responds.                                                                    |
| typography | Ships the `motir-sans` pairing (Inter headlines, Inter body and UI) as its default; a pinned type always wins, and the style block sets no font token.                            |
| components | Equal-radius tile cards, popovers and modals (20px), hairline-edged with the near-flat shadow; 12px controls and inputs, 10px chips; the hero pill and orb as flat accent plates. |

## Token values

Every token the block sets. No `--color-*`, `--el-*` or `--font-*` token appears.

**Radius — one for tiles, one for controls, one for chips**

| token              | tier-0 | Bento |
| ------------------ | ------ | ----- |
| `--radius-xs`      | 4px    | 6px   |
| `--radius-sm`      | 6px    | 8px   |
| `--radius-md`      | 8px    | 10px  |
| `--radius-lg`      | 12px   | 14px  |
| `--radius-xl`      | 16px   | 18px  |
| `--radius-card`    | 12px   | 20px  |
| `--radius-modal`   | 12px   | 20px  |
| `--radius-btn`     | 8px    | 12px  |
| `--radius-input`   | 8px    | 12px  |
| `--radius-control` | 6px    | 10px  |
| `--radius-badge`   | 9999px | 10px  |
| `--radius-kbd`     | 4px    | 8px   |

**Elevation — a near-flat five-rung ladder**

| token                  | Bento                                      |
| ---------------------- | ------------------------------------------ |
| `--shadow-subtle`      | `0 1px 1px rgba(15, 15, 15, 0.03)`         |
| `--shadow-card`        | `0 1px 2px rgba(15, 15, 15, 0.05)`         |
| `--shadow-elevated`    | `0 2px 6px rgba(15, 15, 15, 0.07)`         |
| `--shadow-modal`       | `0 12px 32px -8px rgba(15, 15, 15, 0.16)`  |
| `--shadow-hero-mockup` | `0 18px 40px -12px rgba(15, 15, 15, 0.18)` |

`--shadow-flat` stays `none`. Shadow ink is literal neutral rgba, as in every
shipped block: the axis forbids colour tokens, and a shadow's ink is not one.

**Density and rhythm**

| token                    | tier-0 | Bento                                    |
| ------------------------ | ------ | ---------------------------------------- |
| `--height-control`       | 36px   | 38px                                     |
| `--spacing-control-x`    | 10px   | 12px                                     |
| `--spacing-control-y`    | 6px    | 8px                                      |
| `--spacing-chip-x`       | 10px   | 12px                                     |
| `--spacing-card-padding` | 24px   | 24px (restated; the derivation reads it) |
| `--spacing-lg`           | 20px   | 24px                                     |
| `--spacing-xl`           | 24px   | 32px                                     |

**Motion**

| token                   | tier-0 | Bento             |
| ----------------------- | ------ | ----------------- |
| `--transition-duration` | 150ms  | 180ms             |
| `--transition-fast`     | 100ms  | 140ms             |
| `--transition-slow`     | 250ms  | 260ms             |
| `--active-scale`        | 0.98   | 0.99              |
| `--hover-scale`         | 1      | stays 1 (not set) |

```css
[data-style='bento'] {
  --radius-xs: 6px;
  --radius-sm: 8px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 18px;
  --radius-card: 20px;
  --radius-modal: 20px;
  --radius-btn: 12px;
  --radius-input: 12px;
  --radius-control: 10px;
  --radius-badge: 10px;
  --radius-kbd: 8px;
  --shadow-subtle: 0 1px 1px rgba(15, 15, 15, 0.03);
  --shadow-card: 0 1px 2px rgba(15, 15, 15, 0.05);
  --shadow-elevated: 0 2px 6px rgba(15, 15, 15, 0.07);
  --shadow-modal: 0 12px 32px -8px rgba(15, 15, 15, 0.16);
  --shadow-hero-mockup: 0 18px 40px -12px rgba(15, 15, 15, 0.18);
  --height-control: 38px;
  --spacing-control-x: 12px;
  --spacing-control-y: 8px;
  --spacing-chip-x: 12px;
  --spacing-card-padding: 24px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;
  --transition-duration: 180ms;
  --transition-fast: 140ms;
  --transition-slow: 260ms;
  --active-scale: 0.99;
}
```

### Left at the tier-0 value, on purpose

- `--radius-pill` stays 9999px, so genuinely circular affordances — avatars,
  status dots, the spinner — stay round while chips become 10px rectangles.
- `--height-input` stays 44px: an input is where a person types, and Bento's
  calm register is not a denser one.
- `--spacing-btn-x` / `--spacing-btn-y` stay 18px / 10px, `--spacing-input-x` /
  `--spacing-input-y` stay 16px / 12px, and the button heights stay: the cadence
  Bento moves is the surface and row rhythm, and re-declaring an unchanged token
  only freezes an axis that already resolves.
- `--focus-ring-width` and `--focus-ring-offset` stay 2px / 2px.
- `--spacing-rail-inset` stays 0px and `--width-rail-chrome` stays 20px — a
  style moves the control and the rail follows it.

## Density steps

The steps are not written per style: the layer derives each from its base in one
`:root, [data-style]` rule, as **round(base × step ÷ reference px)**, with the
reference px and step lists of `tests/theme/densityIntegration.test.ts`.

| base                     | reference px | Bento base | steps → resolved                       |
| ------------------------ | ------------ | ---------- | -------------------------------------- |
| `--spacing-card-padding` | 24           | 24px       | 16→16 · 12→12 · 8→8 · 4→4              |
| `--spacing-control-x`    | 10           | 12px       | 16→19 · 12→14 · 8→10 · 6→7 · 4→5 · 2→2 |
| `--spacing-control-y`    | 6            | 8px        | 8→11 · 4→5 · 2→3                       |
| `--spacing-chip-x`       | 10           | 12px       | 8→10 · 6→7 · 4→5 · 2→2                 |
| `--height-control`       | 36           | 38px       | 28→30 · 32→34 · 40→42 · 48→51          |

All twenty-one are positive whole pixels; the smallest is 2px; the closest call
is `--height-control-28` at 38 × 28 ÷ 36 = 29.56 → 30px.

**The rail.** The collapsed column is `--height-control` + `--width-rail-chrome`

- twice the inset: 38 + 20 + 0 = 58px, whose content box is 58 − 8 − 8 − 1 =
  41px against a 38px row — 3px of slack, and the rail stays flush.

## The tile-rhythm law

1. **One radius per class.** Tiles — cards, popovers, modals — share
   `--radius-card` 20px; controls (buttons, inputs) take 12px; chips take 10px.
   No tile shares a control's radius, and no two tiles differ.
2. **Hairlines divide; the shadow decorates.** Every compartment keeps its
   hairline edge, so no state and no boundary is carried by shadow alone.

## The gutter, and what the axis cannot deliver

The two upper rhythm steps are widened (`--spacing-lg` 20→24px, `--spacing-xl`
24→32px) so the gap between tiles is wider than the 20px tile radius. The token
vocabulary declares no gutter name, and this record does not invent one that no
component can be shown to read, so the cadence goes through steps that already
exist. **The style changes no grid structure** — no column count, no row height,
no breakpoint, no tile footprint.

Varied tile footprints — the 1:1, 2:1, 1:2 and occasional 3:1 cells a bento page
is built from — are a property of a page's grid, not of a shape axis every screen
shares. Bento delivers the register (equal generous compartments, even gutters,
near-flat plates, a calm cadence) and deliberately not the composition.

## The hero AI control

Bento's only scoped rules are these three, each in its own
`@scope ([data-style='bento']) to ([data-style])` block. The style ships **no
material layer**: no canvas rule and no card, popover, modal, input or sidebar
rule, so it introduces no colour and a palette swap re-tints everything it
paints. The only surface hook it names is `ai-cta`, which both hero components
already carry.

```css
@scope ([data-style='bento']) to ([data-style]) {
  [data-surface='ai-cta'] {
    --plan-hero-shadow: none;
    --plan-orb-shadow: none;
  }
}
@scope ([data-style='bento']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    --plan-hero-fill: none;
    background-color: var(--el-accent);
  }
}
@scope ([data-style='bento']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='orb'] {
    --plan-orb-fill: none;
    background-color: var(--el-accent);
  }
}
```

Why it is written this way:

1. **No rule writes `background-image` or `box-shadow`.** Both components
   declare those inline, and an inline declaration beats every stylesheet rule:
   such a rule lands, reviews cleanly and changes nothing on screen.
2. **The fill property takes an image, not a colour.** A colour in
   `--plan-hero-fill` computes to no image and paints nothing, so the gradient
   is removed with `none` and the flat colour arrives as `background-color`.
3. **The pill and the orb get a rule each.** They set different properties, and
   one shared rule would have to set both names — which is how a pill's fill
   ends up overwriting the orb's recipe.

No rule adds an `animation`; the two shipped hero animations stay behind their
own reduced-motion gate. **This record claims no contrast ratio for the flat
fill** — it is a new ground for each control's ink, measured by the style ×
palette × mode contrast gate.

## Accessibility

- **No colour is touched.** The block sets no colour, element-palette or font
  token, so every text-on-surface pairing stays the one the palette tuned.
- **Structure never rides the shadow.** The hairline stays on every tile, so a
  compartment is visible at the faintest rung, in both modes and every palette.
- **Focus is kept.** The ring stays 2px at a 2px offset, drawn outside the tile
  radius.
- **Targets do not shrink.** `--height-control` rises to 38px; no button or
  input height is reduced.
- **The limit:** this record measures no ratio. The one pairing Bento cannot
  inherit is the flat accent ground under the hero pill's label and the orb's
  mark, which replaces a gradient recipe; the contrast gate measures it.

## States

- **Rest, light and dark, every palette** — the 20px tile radius, a hairline
  edge, the near-flat rung, the rhythm above; only the palette's colours differ.
- **Hover** — a tile steps up one shadow rung; nothing scales.
- **Pressed** — the 0.99 press, the ladder unchanged.
- **Focus-visible** — the tier-0 ring, outside the tile radius.
- **Selected / current** — the palette's own selected surface plus the
  hairline; no extra radius, border or accent bar.
- **Disabled** — reduced-opacity text over the same edge; the hairline stays.
- **Empty** — the tile keeps its edge and radius; no dashed border or texture.
- **Loading** — a skeleton carries the 20px radius and near-flat rung; no new
  shimmer or pulse.
- **Error** — the palette's danger role; no hue or stroke weight of the style's.
- **Density step** — the tile radius, the gutter cadence and the card padding
  stay fixed at every control-height step, so the grid does not reflow.
- **The hero control** — a flat accent plate on both, no gradient, glow or
  animation.
- **Reduced motion** — nothing in Bento animates on its own.
- **An unregistered style id** — still resolves to `warm-editorial`.

## Differentiation

- **Swiss / Minimal-Flat** squares every surface to 2px and sets every shadow
  rung to `none`. Bento keeps a near-flat ladder rather than removing it, and
  shares one generous radius per class rather than squaring everything.
- **Neumorphism** moulds every surface from one continuous field with a dual
  shadow and paints its canvas. Bento paints no canvas of its own and keeps a
  single, faint drop.
