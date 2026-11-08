# Style — Claymorphism (`data-style="claymorphism"`)

> Soft, inflated tiles pressed from clay. Its token block is the
> `[data-style='claymorphism']` block in
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css),
> with its dark-theme ink rebalance and its palette-derived material rules beside
> it in the same file, and it is registered in
> [`packages/design-system/src/theme/styles.ts`](../../packages/design-system/src/theme/styles.ts)
> in the gallery slot after `retrofuturism`. This document is the style's design
> record; the mock is
> [`design/styles/claymorphism.mock.html`](../../design/styles/claymorphism.mock.html).

| field         | value                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id            | `claymorphism`                                                                                                                                                                                                                                         |
| name          | `Claymorphism`                                                                                                                                                                                                                                         |
| tagline       | `Soft, inflated tiles that look pressed from clay — friendly, tactile and calm.`                                                                                                                                                                       |
| inspiration   | `Claymorphism, coined by Michal Malewicz in his 2021 Hype4 Academy write-up (hype4.academy/articles/design/claymorphism-in-user-interfaces) as the friendlier successor to neumorphism: oversized corners, two inner shadows and one soft outer drop.` |
| defaultTypeId | `rounded`                                                                                                                                                                                                                                              |
| designDoc     | `docs/styles/claymorphism.md`                                                                                                                                                                                                                          |

**Naming.** The style is **Claymorphism** everywhere, never the bare short form.
The short form already names something else in this codebase: the two-step
sign-in layout, "The two-step Clay pattern: identify first, authenticate second"
(`design/auth/design-notes.md`, line 124). The two have nothing to do with each
other, and keeping the full name keeps every later search unambiguous.

This is the STYLE (shape/feel) axis only. **Colour is the independent
`data-palette` axis**: every surface is the palette's own opaque surface, every
border and hero colour is derived from palette tokens, and the only literal inks
are neutral shadow ink.

## Reference

Read at the addresses given, not remembered:

- Hype4 Academy, Michal Malewicz, 2021 —
  <https://hype4.academy/articles/design/claymorphism-in-user-interfaces>:
  "The whole effect is achieved using two inner shadows that give it that
  clay-like, 3d look".
- Setproduct, _Claymorphism design guide_ —
  <https://www.setproduct.com/blog/claymorphism-design-guide>: "a large border
  radius (20 to 40px), two inset shadows (light on top, dark underneath) that
  fake rounded volume, and an outer drop shadow that floats the element above
  the page".

**Taken:** the three-part recipe — oversized radius, the two inner shadows with
light on top and shade underneath, one soft outer drop.

**Not taken:** everything that belongs to a marketing illustration rather than a
product UI — pastel blob fills, a Play-Doh texture, character and 3D art. See
_Deviations from the reference_.

## Feel-bearing dimensions

In the registry's canonical order, worded to be pasted verbatim:

| key        | line                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| silhouette | Oversized soft corners — 16px buttons and inputs, 26px cards, 32px modals, 12px rows and menu items — with pills kept for chips.                                                                                         |
| stroke     | The hairline is kept at a palette border mix on every clay surface, because a soft shadow may never be the only carrier of structure.                                                                                    |
| elevation  | The three-part clay stack — a light band at the top inner edge, a shade band at the bottom inner edge and one soft outer drop — so a surface reads as pressed from clay rather than floating as glass.                   |
| surface    | Opaque palette surface; the clay volume is carried by shadow and radius and never by a tint of its own.                                                                                                                  |
| density    | Comfortable and roomy — 20x12 buttons, 28px card padding, 40px controls — so the inset band never crowds text.                                                                                                           |
| motion     | Gentle 200ms with a 0.97 press squish and no hover scaling; nothing in the style layer animates.                                                                                                                         |
| typography | Ships the Rounded pairing (Nunito headlines and body) as its default, overridable by any pinned type.                                                                                                                    |
| components | Claymorphism cards, popovers, modals, sidebar and inputs through the surface-material layer, a Claymorphism hero pill and orb through the seam variables, and chips, keyboard hints and tooltips carrying the drop only. |

## Default type

`defaultTypeId: 'rounded'` — registered in `TYPE_REGISTRY` (Nunito headlines and
body/UI). A pinned type always overrides it; the block carries no font token.

## Token values

Every shape token the block sets, with units. No row is a `--color-*`, `--el-*`
or `--font-*` token. Base column: the Tier-0 `@theme` block of
`packages/design-system/theme.css`.

| token                                         | base                  | Claymorphism                              |
| --------------------------------------------- | --------------------- | ----------------------------------------- |
| `--radius-xs` / `-sm` / `-md` / `-lg` / `-xl` | 4 / 6 / 8 / 12 / 16px | 6 / 8 / 12 / 18 / 24px                    |
| `--radius-btn` / `--radius-input`             | 8px / 8px             | 16px / 16px                               |
| `--radius-card` / `--radius-modal`            | 12px / 12px           | 26px / 32px                               |
| `--radius-badge`                              | 9999px                | 9999px (restated: chips stay pills)       |
| `--radius-control` / `--radius-kbd`           | 6px / 4px             | 12px / 8px                                |
| `--shadow-subtle`                             | base                  | `0 1px 4px rgba(20, 20, 30, 0.06)`        |
| `--shadow-card`                               | base                  | `0 2px 18px rgba(20, 20, 30, 0.1)`        |
| `--shadow-elevated`                           | base                  | `0 6px 24px -4px rgba(20, 20, 30, 0.1)`   |
| `--shadow-modal`                              | base                  | `0 12px 40px -8px rgba(20, 20, 30, 0.1)`  |
| `--shadow-hero-mockup`                        | base                  | `0 18px 48px -12px rgba(20, 20, 30, 0.1)` |
| `--spacing-btn-x` / `-y`                      | 18px / 10px           | 20px / 12px                               |
| `--spacing-btn-x-sm` / `-y-sm`                | base                  | 16px / 8px                                |
| `--spacing-input-x` / `-y`                    | base                  | 16px / 12px                               |
| `--spacing-card-padding`                      | 24px                  | 28px                                      |
| `--spacing-control-x` / `-y`                  | 10px / 6px            | 14px / 8px                                |
| `--spacing-chip-x`                            | 10px                  | 12px                                      |
| `--height-btn-sm` / `-md` / `-lg`             | base                  | 36px / 44px / 52px                        |
| `--height-input`                              | base                  | 44px                                      |
| `--height-control`                            | 36px                  | 40px                                      |
| `--transition-duration` / `--transition-slow` | 150ms / 250ms         | 200ms / 300ms                             |
| `--hover-scale` / `--active-scale`            | 1 / 0.98              | 1 / 0.97                                  |
| `--focus-ring-width` / `--focus-ring-offset`  | 2px / 2px             | 2px / 2px (restated)                      |

**The seven clay scalars** — new names, fixed here, consumed only by the
material rules. Palette-agnostic: the inks are neutral shadow ink, never a hue.

| scalar              | light                       | dark                        | what it is                               |
| ------------------- | --------------------------- | --------------------------- | ---------------------------------------- |
| `--clay-inset`      | 3px                         | 3px                         | offset of each inner band from its edge  |
| `--clay-inset-blur` | 6px                         | 6px                         | blur of each inner band                  |
| `--clay-drop`       | 2px                         | 2px                         | offset of the outer drop                 |
| `--clay-drop-blur`  | 18px                        | 18px                        | blur of the outer drop                   |
| `--clay-light`      | `rgba(255, 255, 255, 0.55)` | `rgba(255, 255, 255, 0.07)` | the light band's ink (top inner edge)    |
| `--clay-shade`      | `rgba(20, 20, 30, 0.16)`    | `rgba(0, 0, 0, 0.42)`       | the shade band's ink (bottom inner edge) |
| `--clay-drop-ink`   | `rgba(20, 20, 30, 0.1)`     | `rgba(0, 0, 0, 0.46)`       | the outer drop's ink                     |

```css
[data-style='claymorphism'] {
  --radius-xs: 6px;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 18px;
  --radius-xl: 24px;
  --radius-btn: 16px;
  --radius-input: 16px;
  --radius-card: 26px;
  --radius-modal: 32px;
  --radius-badge: 9999px;
  --radius-control: 12px;
  --radius-kbd: 8px;
  --shadow-subtle: 0 1px 4px rgba(20, 20, 30, 0.06);
  --shadow-card: 0 2px 18px rgba(20, 20, 30, 0.1);
  --shadow-elevated: 0 6px 24px -4px rgba(20, 20, 30, 0.1);
  --shadow-modal: 0 12px 40px -8px rgba(20, 20, 30, 0.1);
  --shadow-hero-mockup: 0 18px 48px -12px rgba(20, 20, 30, 0.1);
  --spacing-btn-x: 20px;
  --spacing-btn-y: 12px;
  --spacing-btn-x-sm: 16px;
  --spacing-btn-y-sm: 8px;
  --spacing-input-x: 16px;
  --spacing-input-y: 12px;
  --spacing-card-padding: 28px;
  --spacing-control-x: 14px;
  --spacing-control-y: 8px;
  --spacing-chip-x: 12px;
  --height-btn-sm: 36px;
  --height-btn-md: 44px;
  --height-btn-lg: 52px;
  --height-input: 44px;
  --height-control: 40px;
  --transition-duration: 200ms;
  --transition-slow: 300ms;
  --hover-scale: 1;
  --active-scale: 0.97;
  --focus-ring-width: 2px;
  --focus-ring-offset: 2px;
  --clay-inset: 3px;
  --clay-inset-blur: 6px;
  --clay-drop: 2px;
  --clay-drop-blur: 18px;
  --clay-light: rgba(255, 255, 255, 0.55);
  --clay-shade: rgba(20, 20, 30, 0.16);
  --clay-drop-ink: rgba(20, 20, 30, 0.1);
}
[data-theme='dark'] [data-style='claymorphism'],
[data-style='claymorphism'][data-theme='dark'] {
  --clay-light: rgba(255, 255, 255, 0.07);
  --clay-shade: rgba(0, 0, 0, 0.42);
  --clay-drop-ink: rgba(0, 0, 0, 0.46);
}
```

**The dark block is not a bare token block.** It names both axes — the compound
`[data-style][data-theme]` arm the Neumorphism record uses, plus a descendant arm
so a scoped preview under a dark ancestor (the Appearance pane's vignette) gets
it too — so the colour-free token-block check does not read it as one. It sets
only the three neutral inks: a 0.55 white band on a dark surface is far too loud
and a 0.16 near-black shade barely shows.

**What the block leaves unset.** No colour token and no font token. Not
`--spacing-rail-inset` — it stays at the base 0px, so the rail stays flush. Not
`--width-rail-chrome`, and none of the derived density steps, which the shared
`:root, [data-style]` rule derives.

### Derived density steps

| base token               | ref px | base here | step → resolved                               |
| ------------------------ | ------ | --------- | --------------------------------------------- |
| `--spacing-card-padding` | 24     | 28px      | 16 → 19, 12 → 14, 8 → 9, 4 → 5                |
| `--spacing-control-x`    | 10     | 14px      | 16 → 22, 12 → 17, 8 → 11, 6 → 8, 4 → 6, 2 → 3 |
| `--spacing-control-y`    | 6      | 8px       | 8 → 11, 4 → 5, 2 → 3                          |
| `--spacing-chip-x`       | 10     | 12px      | 8 → 10, 6 → 7, 4 → 5, 2 → 2                   |
| `--height-control`       | 36     | 40px      | 28 → 31, 32 → 36, 40 → 44, 48 → 53            |

**The rail.** 40 + 20 = 60px collapsed column, a 43px content box (60 − 8 − 8 −

1. for a 40px control: the same 3px slack the shipped styles keep.

## The clay recipe — exactly three parts

1. **The oversized radius scale** — the radius rows above: 16px controls, 26px
   cards, 32px modals, pills for chips.
2. **Two inset shadows**, sign convention spelled out because it is the detail
   most easily inverted: a **light band at the TOP inner edge**
   (`inset 0 var(--clay-inset) var(--clay-inset-blur) var(--clay-light)` — a
   positive y offset pushes the light down from the top edge) and a **shade band
   at the BOTTOM inner edge**
   (`inset 0 calc(-1 * var(--clay-inset)) var(--clay-inset-blur) var(--clay-shade)`
   — a negative y offset pushes the shade up from the bottom edge). Offset 3px,
   blur 6px, ink 0.55 light / 0.16 shade in the light theme.
3. **One outer soft drop** — `0 var(--clay-drop) var(--clay-drop-blur) var(--clay-drop-ink)`:
   2px offset, 18px blur, 0.10 ink, so the tile sits above the canvas.

**An input well inverts part 2** — shade at the top, light at the bottom — which
is what makes a field read as pressed in. It carries no outer drop.

## The clay surfaces

| surface          | selector                                            | parts                                                                                                        |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| card and popover | `[data-surface='card']`, `[data-surface='popover']` | all three                                                                                                    |
| modal            | `[data-surface='modal']`                            | all three, one step deeper: bands at 4px, drop at 8px offset / 36px blur                                     |
| sidebar          | `[data-surface='sidebar']`                          | all three, the bands on the horizontal edges (light left, shade right) so the rail reads as a pressed column |
| input            | `[data-surface='input']`                            | the inverted pair plus the hairline, no outer drop                                                           |
| hero pill        | `[data-surface='ai-cta'][data-ai-cta='pill']`       | all three through the seam variables, the drop tinted by the accent                                          |
| hero orb         | `[data-surface='ai-cta'][data-ai-cta='orb']`        | all three through the seam variables, bands at 4px                                                           |
| canvas           | none — **Claymorphism adds no canvas rule**         | —                                                                                                            |

**Why no canvas rule.** A clay tile has to sit distinct from the field it rests
on — the drop floats it and the edge bands inflate it against a different
ground. This is Claymorphism's documented difference from Neumorphism, whose
canvas and panels share one surface so panels look moulded out of the field.
The shell keeps its own page fill.

Interactive cards (`a`, `button` or `[role='button']` carrying
`data-surface='card'`) deepen the drop one step on hover and press the bands to
the well depth on `:active`; a disabled input or an `aria-disabled` card loses
both bands and the drop and keeps its hairline.

```css
@scope ([data-style='claymorphism']) to ([data-style]) {
  [data-surface='card'],
  [data-surface='popover'] {
    background-color: var(--el-surface);
    border-color: color-mix(in srgb, var(--el-border) 60%, transparent);
    box-shadow:
      inset 0 var(--clay-inset) var(--clay-inset-blur) var(--clay-light),
      inset 0 calc(-1 * var(--clay-inset)) var(--clay-inset-blur) var(--clay-shade),
      0 var(--clay-drop) var(--clay-drop-blur) var(--clay-drop-ink);
  }
}
@scope ([data-style='claymorphism']) to ([data-style]) {
  [data-surface='modal'] {
    background-color: var(--el-surface);
    border-color: color-mix(in srgb, var(--el-border) 60%, transparent);
    box-shadow:
      inset 0 calc(var(--clay-inset) + 1px) var(--clay-inset-blur) var(--clay-light),
      inset 0 calc(-1 * (var(--clay-inset) + 1px)) var(--clay-inset-blur) var(--clay-shade),
      0 calc(var(--clay-drop) * 4) calc(var(--clay-drop-blur) * 2) var(--clay-drop-ink);
  }
}
@scope ([data-style='claymorphism']) to ([data-style]) {
  [data-surface='sidebar'] {
    background-color: var(--el-surface);
    border-color: color-mix(in srgb, var(--el-border) 60%, transparent);
    box-shadow:
      inset var(--clay-inset) 0 var(--clay-inset-blur) var(--clay-light),
      inset calc(-1 * var(--clay-inset)) 0 var(--clay-inset-blur) var(--clay-shade),
      var(--clay-drop) 0 var(--clay-drop-blur) var(--clay-drop-ink);
  }
}
@scope ([data-style='claymorphism']) to ([data-style]) {
  [data-surface='input'] {
    background-color: var(--el-surface);
    border-color: color-mix(in srgb, var(--el-border) 60%, transparent);
    box-shadow:
      inset 0 var(--clay-inset) var(--clay-inset-blur) var(--clay-shade),
      inset 0 calc(-1 * var(--clay-inset)) var(--clay-inset-blur) var(--clay-light);
  }
}
@scope ([data-style='claymorphism']) to ([data-style]) {
  [data-surface='card']:is(a, button, [role='button']):hover {
    box-shadow:
      inset 0 var(--clay-inset) var(--clay-inset-blur) var(--clay-light),
      inset 0 calc(-1 * var(--clay-inset)) var(--clay-inset-blur) var(--clay-shade),
      0 calc(var(--clay-drop) * 2) calc(var(--clay-drop-blur) + 6px) var(--clay-drop-ink);
  }
}
@scope ([data-style='claymorphism']) to ([data-style]) {
  [data-surface='card']:is(a, button, [role='button']):active {
    box-shadow:
      inset 0 calc(var(--clay-inset) * 2) var(--clay-inset-blur) var(--clay-shade),
      inset 0 calc(-1 * var(--clay-inset)) var(--clay-inset-blur) var(--clay-light);
  }
}
@scope ([data-style='claymorphism']) to ([data-style]) {
  [data-surface='input']:disabled,
  [data-surface='card'][aria-disabled='true'] {
    box-shadow: none;
    border-color: var(--el-border);
  }
}
```

## The hero AI control

The pill and the orb declare their fill and shadow inline, and an inline
declaration beats any stylesheet rule, so this block writes the four seam
variables — `--plan-hero-fill`, `--plan-hero-shadow`, `--plan-orb-fill`,
`--plan-orb-shadow` — and **never a literal `background-image` or `box-shadow`**.

- **Pill fill** — `linear-gradient(180deg, color-mix(in srgb, var(--el-accent) 90%, var(--el-surface)), var(--el-accent))`:
  every stop at or above 90% accent, above the 86% floor the shipped recipe's far
  stop uses.
- **Orb fill** — the shipped lit-sphere crown
  (`color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent))`
  at 33% / 27%) settling to the accent by 55% and a 90% accent rim. `--orb-lit-mix`
  is read, never re-declared.
- **Shadows** — the two clay bands from the neutral inks, plus an outer drop
  tinted 30% (pill) / 34% (orb) accent so it stays visible in dark.
- **Border** — `1px solid color-mix(in srgb, var(--el-accent) 70%, var(--el-text))`,
  the hairline kept on the hero too.
- **No `animation`.** The pill's shimmer and the orb's pulse stay the
  reduced-motion-gated classes they already are.

```css
@scope ([data-style='claymorphism']) to ([data-style]) {
  [data-surface='ai-cta'] {
    border: 1px solid color-mix(in srgb, var(--el-accent) 70%, var(--el-text));
    --plan-hero-shadow:
      inset 0 var(--clay-inset) var(--clay-inset-blur) var(--clay-light),
      inset 0 calc(-1 * var(--clay-inset)) var(--clay-inset-blur) var(--clay-shade),
      0 var(--clay-drop) var(--clay-drop-blur) color-mix(in srgb, var(--el-accent) 30%, transparent);
    --plan-orb-shadow:
      inset 0 calc(var(--clay-inset) + 1px) var(--clay-inset-blur) var(--clay-light),
      inset 0 calc(-1 * (var(--clay-inset) + 1px)) var(--clay-inset-blur) var(--clay-shade),
      0 calc(var(--clay-drop) * 2) var(--clay-drop-blur)
        color-mix(in srgb, var(--el-accent) 34%, transparent);
  }
}
@scope ([data-style='claymorphism']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    --plan-hero-fill: linear-gradient(
      180deg,
      color-mix(in srgb, var(--el-accent) 90%, var(--el-surface)),
      var(--el-accent)
    );
  }
}
@scope ([data-style='claymorphism']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='orb'] {
    --plan-orb-fill: radial-gradient(
      circle at 33% 27%,
      color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent)) 0%,
      var(--el-accent) 55%,
      color-mix(in srgb, var(--el-accent) 90%, var(--el-text)) 100%
    );
  }
}
```

## Accessibility contract

Rules, not intentions:

- **Opaque palette fills** on every text-bearing surface (`var(--el-surface)`).
- **The hairline is kept** on every clay surface, at
  `color-mix(in srgb, var(--el-border) 60%, transparent)`.
- **The inset-band rule.** Insets go only where the clearance between a
  surface's edge and its text is at least twice the inset blur (2 × 6px = 12px):
  cards and modals (28px padding), popovers (a 4px panel inset plus a 40px row:
  14px), the sidebar (its rows' 14px padding), inputs (44px tall with a 20px
  line: 12px), the pill (44px tall: 12px) and the orb (56px with a 16px mark:
  20px). Badges, keyboard hints and tooltips carry the drop only — the style
  adds no rule for them, so they keep the shadow token their primitive reads.
- **Light-theme ink caps** — light at or below 0.55 alpha, shade at or below
  0.16, drop at or below 0.10.
- **Focus** — the palette's ring at 2px with a 2px offset, drawn outside the
  band on every control, inputs included; the soft shadow is never the only
  focus affordance.
- **More contrast** — under `prefers-contrast: more` the hairline turns solid
  (`--el-border-strong`) and the stack flattens to a single readable lift
  (`--shadow-card`).
- **Forced colours** — the border turns solid and the shadow is removed; the
  operating system owns contrast.

```css
@media (prefers-contrast: more) {
  @scope ([data-style='claymorphism']) to ([data-style]) {
    [data-surface='card'],
    [data-surface='popover'],
    [data-surface='modal'],
    [data-surface='input'],
    [data-surface='sidebar'] {
      border-color: var(--el-border-strong);
      box-shadow: var(--shadow-card);
    }
  }
}
@media (forced-colors: active) {
  @scope ([data-style='claymorphism']) to ([data-style]) {
    [data-surface='card'],
    [data-surface='popover'],
    [data-surface='modal'],
    [data-surface='input'],
    [data-surface='sidebar'] {
      border-color: var(--el-border-strong);
      box-shadow: none;
    }
  }
}
```

Every colour value here resolves to `var(--el-*)`, a single two-operand
`color-mix(in srgb, var(--el-…) P%, var(--el-…))` (or `transparent` as the
second operand) with the percentage on the first operand, or a neutral rgba ink
— no hex, no three-way or nested mix, no hue keyword — so the colour helpers can
fold each value and the contrast measurement can resolve it.

## States

- **Rest** — opaque surface, hairline, the three-part stack.
- **Hover** — the drop deepens one step on an interactive card; nothing else
  moves, and `--hover-scale` stays 1 because clay tiles sit in dense rows.
- **Pressed** — the bands deepen to the well and `--active-scale` 0.97 squashes
  the tile, returning over 200ms.
- **Focus-visible** — the ring above.
- **Disabled** — bands and drop removed, hairline kept; no new colour.
- **Selected / current row** — inherited from the palette axis; the style adds
  no selection colour.
- **Empty, loading, error** — content states, inherited unchanged; no per-state
  variation and no animation.
- **Light and dark** — the dark block rebalances the three inks; nothing else
  changes.
- **More contrast / forced colours** — above.
- **Reduced motion** — nothing to gate; the style animates nothing.
- **An unregistered stored style id** — the axis keeps its shipped fallback and
  renders Warm Editorial.

## Deviations from the reference

- **No pastel colour literals.** Colour belongs to the palette axis, so the
  reference's pastel fills become the palette's own surface, which also keeps
  text on the colour each palette tuned for AA.
- **No raster texture and no illustration.** The identity is radius plus shadow,
  drawn entirely in CSS.
- **Radii in the lower half of the reference's band** — 16–32px rather than up to
  40px — because the densest chrome (rows, chips, toolbars) cannot carry an
  extreme radius; the reference's pill-everything read is kept for badges only.
- **Neutral shadow ink, not a palette-derived shade.** Deriving the shade from a
  palette text token inverts it in dark mode — the ink goes light and the
  inflation collapses — the same trap the Neumorphism record documents and
  solves the same way, with a dark-theme rebalance.
- **A 6px inset blur, not 8px.** At 8px the inset-band rule (clearance at least
  twice the blur) would fail on the popover's first row, the input and the pill,
  which sit 12–14px from their edges. 6px keeps the bands on all of them and the
  inflation still reads (see the mock).
