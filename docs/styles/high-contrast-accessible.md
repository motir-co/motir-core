# Style — High-Contrast / Accessible (`data-style="high-contrast-accessible"`)

> A shape-and-feel style with a scoped accessibility layer: heavier strokes,
> big targets, a focus ring you cannot miss, and no motion. Its token block is
> the `[data-style='high-contrast-accessible']` block in
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css),
> and it is registered in
> [`packages/design-system/src/theme/styles.ts`](../../packages/design-system/src/theme/styles.ts),
> second of the eight styles that follow `retrofuturism`. This document is the
> style's design record; the mock is
> [`design/styles/high-contrast-accessible.mock.html`](../../design/styles/high-contrast-accessible.mock.html).

| field         | value                                                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id            | `high-contrast-accessible`                                                                                                                                                                                                                                                                 |
| name          | `High-Contrast / Accessible`                                                                                                                                                                                                                                                               |
| tagline       | `Maximum legibility — heavier strokes, big targets, and focus you cannot miss.`                                                                                                                                                                                                            |
| inspiration   | `Accessibility-first interface design — the WCAG 2.2 focus-appearance and target-size guidance, and operating-system high-contrast modes plus GitHub's high-contrast themes: structure drawn with borders rather than shadow, targets sized to the hand, and no meaning carried by depth.` |
| defaultTypeId | `humanist`                                                                                                                                                                                                                                                                                 |
| designDoc     | `docs/styles/high-contrast-accessible.md`                                                                                                                                                                                                                                                  |

**Wrong moods:** soft, translucent, atmospheric, delicate, shadow-drawn,
animated.

This is the STYLE (shape/feel) axis only. **Colour is the independent
`data-palette` axis**: the style paints no colour of its own. Its 2px edges are
drawn in whatever border colour the palette and the component already give a
surface, and its focus ring reads `--focus-ring-color` (Tier-0
`var(--color-primary)`) without declaring it. The high-contrast _palette_ is a
separate entry on the colour axis; this style works under every registered
palette and needs no special one.

## Feel-bearing dimensions

One line per key of `STYLE_DIMENSIONS`, written to paste into
`STYLE_REGISTRY['high-contrast-accessible'].dimensions` unedited.

| key        | line                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| silhouette | Plain, near-square corners — 4px buttons, inputs and rows, 6px cards, 8px modals, 4px rectangular status chips. Shape never competes with content.                                                                 |
| stroke     | Heavier strokes — every framed surface draws a 2px border in the colour its component already chose, so an edge is always a line you can see, never a shadow you have to infer.                                    |
| elevation  | None. All six shadow roles resolve to none; depth is a drawn 2px edge against an opaque palette surface, so no control relies on shadow alone to show where it ends.                                               |
| surface    | Opaque palette surfaces only — no tint, glass, wash or gradient — so text always sits on a colour the palette tuned for it.                                                                                        |
| density    | Roomy and reachable — 44px controls, 48px buttons and inputs, 20x12 button padding — plus a minimum-size floor that keeps every interactive control at least 44x44px at any density step.                          |
| motion     | Still — 0ms transitions, no hover growth, no press scale, and the hero's ambient shimmer and pulse stilled inside the style whatever the system's motion preference.                                               |
| typography | The humanist pairing — Fira Sans across headlines, body and UI over JetBrains Mono meta: open apertures and distinct letterforms that stay legible at small sizes and on washed-out screens.                       |
| components | Bordered rectangular buttons, inputs and chips at 44px or more, a 3px outline focus ring at a 2px offset on every focusable control, flat framed cards; the hero AI pill and orb become solid flat accent targets. |

## Default type

`defaultTypeId: 'humanist'` — a registered pairing in `TYPE_REGISTRY`
(`faces: 'Fira Sans headlines + body/UI · JetBrains Mono meta.'`). With no type
pinned the app renders it under this style; **a pinned type always overrides
it**, and the style block carries no font token of its own.

## Token values

Shape and feel only. Every name below is already declared in the Tier-0
`@theme` block of `packages/design-system/theme.css` (and mirrored by its
`[data-style='warm-editorial']` block), so the style introduces no new token.

| dimension  | token                                                                                                                   | base                  | High-Contrast / Accessible |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------- |
| silhouette | `--radius-xs` / `--radius-sm`                                                                                           | 4px / 6px             | 2px / 2px                  |
| silhouette | `--radius-md` / `--radius-lg` / `--radius-xl`                                                                           | 8px / 12px / 16px     | 4px / 4px / 6px            |
| silhouette | `--radius-btn` / `--radius-input` / `--radius-control` / `--radius-kbd`                                                 | 8px / 8px / 6px / 4px | 4px / 4px / 4px / 4px      |
| silhouette | `--radius-card` / `--radius-modal`                                                                                      | 12px / 12px           | 6px / 8px                  |
| silhouette | `--radius-badge`                                                                                                        | 9999px                | 4px — rectangular chips    |
| stroke     | _(the structure layer)_                                                                                                 | 1px                   | 2px, width only            |
| elevation  | `--shadow-flat` / `--shadow-subtle` / `--shadow-card` / `--shadow-elevated` / `--shadow-modal` / `--shadow-hero-mockup` | none / soft shadows   | `none`, all six            |
| density    | `--height-control`                                                                                                      | 36px                  | 44px                       |
| density    | `--height-btn-sm` / `--height-btn-md` / `--height-btn-lg`                                                               | 32px / 40px / 48px    | 44px / 48px / 56px         |
| density    | `--height-input`                                                                                                        | 44px                  | 48px                       |
| density    | `--spacing-btn-x` / `--spacing-btn-y`                                                                                   | 18px / 10px           | 20px / 12px                |
| density    | `--spacing-input-x` / `--spacing-input-y`                                                                               | 16px / 12px           | 16px / 14px                |
| density    | `--spacing-control-x` / `--spacing-control-y`                                                                           | 10px / 6px            | 12px / 10px                |
| density    | `--spacing-card-padding`                                                                                                | 24px                  | 24px (restated)            |
| motion     | `--transition-duration` / `--transition-fast` / `--transition-slow`                                                     | 150ms / 100ms / 250ms | 0ms / 0ms / 0ms            |
| motion     | `--hover-scale` / `--active-scale`                                                                                      | 1 / 0.98              | 1 / 1                      |
| focus      | `--focus-ring-width` / `--focus-ring-offset`                                                                            | 2px / 2px             | 3px / 2px                  |

**Left at their Tier-0 values, on purpose.** `--radius-pill` stays 9999px, so
avatars, status dots and the spinner stay round while chips become rectangles
through `--radius-badge`. `--spacing-rail-inset` is not declared: its base is
already 0px and only a floating rail moves it. `--width-rail-chrome` is never
overridden per style: a style moves the control and the rail follows.
`--focus-ring-color` is not declared, because it is a colour token and a style
block may hold none; the focus layer reads it at the point of use.

```css
[data-style='high-contrast-accessible'] {
  --radius-xs: 2px;
  --radius-sm: 2px;
  --radius-md: 4px;
  --radius-lg: 4px;
  --radius-xl: 6px;
  --radius-btn: 4px;
  --radius-input: 4px;
  --radius-control: 4px;
  --radius-kbd: 4px;
  --radius-card: 6px;
  --radius-modal: 8px;
  --radius-badge: 4px;
  --shadow-flat: none;
  --shadow-subtle: none;
  --shadow-card: none;
  --shadow-elevated: none;
  --shadow-modal: none;
  --shadow-hero-mockup: none;
  --height-control: 44px;
  --height-btn-sm: 44px;
  --height-btn-md: 48px;
  --height-btn-lg: 56px;
  --height-input: 48px;
  --spacing-btn-x: 20px;
  --spacing-btn-y: 12px;
  --spacing-input-x: 16px;
  --spacing-input-y: 14px;
  --spacing-control-x: 12px;
  --spacing-control-y: 10px;
  --spacing-card-padding: 24px;
  --transition-duration: 0ms;
  --transition-fast: 0ms;
  --transition-slow: 0ms;
  --hover-scale: 1;
  --active-scale: 1;
  --focus-ring-width: 3px;
  --focus-ring-offset: 2px;
}
```

### Derived density steps

No derived step is declared: the shared `:root, [data-style]` rule derives each
from its base (`round(nearest, base × n / reference px, 1px)`). Under this
style's bases they resolve as below — **all positive whole pixels**, none on a
half pixel.

| base token               | ref px | base here | step → resolved                               |
| ------------------------ | ------ | --------- | --------------------------------------------- |
| `--spacing-card-padding` | 24     | 24px      | 16 → 16, 12 → 12, 8 → 8, 4 → 4                |
| `--spacing-control-x`    | 10     | 12px      | 16 → 19, 12 → 14, 8 → 10, 6 → 7, 4 → 5, 2 → 2 |
| `--spacing-control-y`    | 6      | 10px      | 8 → 13, 4 → 7, 2 → 3                          |
| `--spacing-chip-x`       | 10     | 10px      | 8 → 8, 6 → 6, 4 → 4, 2 → 2                    |
| `--height-control`       | 36     | 44px      | 28 → 34, 32 → 39, 40 → 49, 48 → 59            |

`--height-control-28` and `--height-control-32` resolve under 44px. That is why
the target floor below is a `min-height` rule and not the token alone: a used
height is the larger of its minimum and its height, so the floor holds at every
step.

## The layers beyond the token block

Four scoped layers and the hero treatment, each anchored to this one id, all in
`packages/design-system/theme.css`, one rule per `@scope` block (the shape the
registry suite reads) — the structure layer, the focus ring, the target floor
(two rules) and the still set:

```css
@scope ([data-style='high-contrast-accessible']) to ([data-style]) {
  .border {
    border-width: 2px;
  }
}
@scope ([data-style='high-contrast-accessible']) to ([data-style]) {
  :focus-visible:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring-color);
    outline-offset: var(--focus-ring-offset);
  }
}
@scope ([data-style='high-contrast-accessible']) to ([data-style]) {
  button,
  [role='button'],
  select,
  summary,
  textarea,
  input:not([type='checkbox']):not([type='radio']) {
    min-height: 44px;
    min-width: 44px;
  }
}
@scope ([data-style='high-contrast-accessible']) to ([data-style]) {
  input[type='checkbox'],
  input[type='radio'] {
    min-width: 24px;
    min-height: 24px;
  }
}
@scope ([data-style='high-contrast-accessible']) to ([data-style]) {
  .plan-with-ai-shimmer,
  .plan-with-ai-fab-pulse {
    animation: none;
  }
}
```

Four things in that block are decisions, not details.

- **The structure layer sets a width and no colour.** A scoped rule that also
  declared a colour would out-rank the utility a component uses for its own
  semantic edge, so an invalid field's danger border and a disabled field's
  softer border would be repainted by a style that promises to keep state
  legible. The 2px width is the style's contribution; the colour stays where
  each surface chose it, which also keeps a palette swap a re-tint. (The rule is
  unlayered, so it wins over Tailwind's `border` utility in `@layer utilities`.)
- **The focus indicator is an `outline`, not a box-shadow.** Both shipped focus
  treatments are fixed 2px ring utilities that cannot read this style's ring
  width — the button's
  `'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:ring-offset-background',`
  and the picker row's
  `'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',`
  — and the ring lives in the shadow layer this style empties. An outline is
  independent of both, so the focus indicator does not depend on a shadow
  either.
- **Specificity, not `!important`, is how it wins.** The scope root matches with
  zero specificity, so a bare `:focus-visible` would lose to a utility that pairs
  a class with the pseudo-class. Repeating the pseudo-class lifts it above
  `outline-none` without `!important`, so a later override stays possible. A
  primitive that cannot be out-ranked is a conflict the build records, not one it
  silences.
- **`min-height` is what grants the inline exception.** WCAG 2.5.5 exempts links
  inside running text, and CSS gives that exemption for free: `min-height` and
  `min-width` do not apply to non-replaced inline boxes, so prose links are
  untouched while buttons, fields and block controls are lifted. Checkbox and
  radio boxes get a 24px visual minimum instead; their label carries the target.
  The token heights produce 44px or more for button-like controls on their own
  (`--height-btn-sm` 44px, `--height-btn-md` 48px, `--height-btn-lg` 56px,
  `--height-input` 48px, `--height-control` 44px).

**The still set lives outside the hero rule.** The motion tokens remove
transitions and the press scale, but the hero's shimmer and pulse
(`.plan-with-ai-shimmer`, `.plan-with-ai-fab-pulse`, keyframed in
`app/globals.css`) run behind the OS reduced-motion preference only, so a person
without that preference would still see them. They are stilled by a rule on
their own class names, never inside the hero rule, which carries the four seam
properties and nothing else.

**No surface material ships beyond the hero treatment.** Depth is a drawn 2px
edge against an opaque palette surface; there is nothing translucent to re-tint
on a palette swap. The style names no surface hook except `ai-cta`, which the
app already emits.

### The hero treatment

Both controls declare their fill and shadow inline and read them back through
custom properties — the pill through `var(--plan-hero-fill, …)` and
`var(--plan-hero-shadow, …)`, the orb through `var(--plan-orb-fill, …)` and
`var(--plan-orb-shadow, …)`. A rule writing `background-image` or `box-shadow`
literally would land, review cleanly and change nothing on screen. Under this
style both controls take a flat fill of the palette's accent, lose their halos
and draw a 2px `--el-border-strong` rim, so they read as solid, edged,
motionless targets. The label and the mark
stay `--el-accent-text` on `--el-accent`, the palette's own CTA pair.

```css
@scope ([data-style='high-contrast-accessible']) to ([data-style]) {
  [data-surface='ai-cta'] {
    border: 2px solid var(--el-border-strong);
    --plan-hero-shadow: none;
    --plan-orb-shadow: none;
  }
}
@scope ([data-style='high-contrast-accessible']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    --plan-hero-fill: none;
    background-color: var(--el-accent);
  }
}
@scope ([data-style='high-contrast-accessible']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='orb'] {
    --plan-orb-fill: none;
    background-color: var(--el-accent);
  }
}
```

The flat fill turns the seam off (`none`) and paints `background-color`, the
same composition Bento uses, so the controls carry no gradient at all. The rim
is the edge the contract below owes every control: a boundary that does not
depend on a shadow. No raw hue, no literal `background-image` or `box-shadow`,
no animation.

## The rail

`--spacing-rail-inset` stays at its 0px base and `--width-rail-chrome` is not
overridden, so the rail stays flush and the collapsed column is
44 + 20 + 2 × 0 = **64px**. Its content box subtracts the rail's own 8 + 8 + 1
of gutters and border: **47px of content box for a 44px row**, the same 3px
slack the shipped styles have, which is why the larger targets still fit the
track (`tests/theme/railTracksControlHeight.test.ts`).

## The accessibility contract

Each number with the condition it is measured under.

1. **Text.** Body and UI text on every surface this style paints — canvas, card,
   popover, modal, input, sidebar and the hero AI control — clears 4.5:1 under
   every registered palette, light and dark, with style, palette and mode
   recorded for each ratio by the story's contrast gate. The style paints no
   colour, so it cannot lower a palette's ratio.
2. **Focus.** Every focused control shows an indicator at least 2px thick that
   differs clearly from its unfocused state (WCAG 2.4.13). This style ships 3px
   at a 2px offset as the margin, drawn as an outline and never suppressed.
3. **Targets.** Every interactive control that is not an inline link in running
   text measures at least 44×44 CSS pixels (WCAG 2.5.5), carried twice: by the
   token heights for button-like controls and by the scoped minimum-size rule
   for icon-only and bare controls.
4. **Edges.** No control's boundary depends on a shadow: framed surfaces draw a
   2px border and all six shadow roles are `none`.
5. **Motion.** Transitions are 0ms, hover growth and press scale are removed,
   and the ambient hero animations are stilled inside the style.
6. **Colour authority.** Every colour a scoped rule paints is a palette token or
   a mix over one, with no hex literal.
7. **Scope.** Every scoped layer is anchored to this one id, so no other style's
   rendering changes.

**Edge contrast is not promised here.** Whether a 2px border reaches 3:1 against
its surface is a colour value the palette axis owns, and this story touches no
palette. The bars this style holds itself to are 4.5:1 text on the palette's
own surfaces, a drawn 2px edge, a 3px focus ring and 44px targets.

**Deviation, recorded.** A stricter high-contrast treatment aims at 7:1 for body
text. Reaching it under every palette needs palette values, which the colour
axis owns. The structural half — drawn edges, big targets, an unmissable ring,
no motion — is adopted whole; the colour half is palette work.

## States

- **The option** in the Appearance pane and the onboarding DesignStep picker:
  resting, hovered (a border or fill change, nothing lifts or scales),
  keyboard-focused (the same 3px outline), selected (a palette-driven fill or
  edge, never the ring alone).
- **Every control** — at rest a drawn 2px edge or an unambiguous fill; focused,
  the 3px outline; hovered and pressed, a fill or edge change and no movement;
  disabled, the edge stays drawn so opacity is never the only cue.
- **Data states** — empty, loading (spinner and skeletons), error banner and
  destructive action keep the style's drawn edges on opaque surfaces at the same
  text bar.
- **Reduced motion** — nothing changes: the style is already still.
- **Forced colours or a stronger contrast preference** — nothing here rests on
  a shadow for the system mode to remove, and the style adds no arm that would
  repaint a palette colour.
- **Unknown style id** — resolves to `warm-editorial` through the registry's
  own fallback, unchanged.

## The reference

- **WCAG 2.2 SC 2.4.13 Focus Appearance** —
  <https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html> — settles
  the focus number: an indicator at least as large as a 2 CSS px perimeter,
  with a clear contrast step from the unfocused state. Shipped with margin at
  3px by 2px offset.
- **WCAG 2.2 SC 2.5.5 Target Size (Enhanced)** —
  <https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html> —
  settles the target number: 44 × 44 CSS px, with the inline and
  equivalent-target exceptions, both honoured explicitly.
- **GitHub Primer, colour usage for high-contrast themes** —
  <https://primer.style/product/getting-started/foundations/color-usage/> — a
  shipped product's settled edge strategy: where a softer background is used,
  borders carry the contrast, not a shadow. That is the structure layer and the
  all-`none` shadow family.

**Not taken:** Primer's 7:1 text target (above), because it needs palette
values. No shipped product's token-level "high contrast style" was available at
the depth this record needs; the standards state the numbers, which is what a
style promising measurable accessibility needs.
