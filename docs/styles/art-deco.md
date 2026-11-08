# Style — Art Deco (`data-style="art-deco"`)

> Framed and geometric. Its token block is the `[data-style='art-deco']` block in
> `packages/design-system/theme.css`, with its palette-derived frame material and
> hero rules beside it in `@scope ([data-style='art-deco']) to ([data-style])`
> blocks, and it is registered in `packages/design-system/src/theme/styles.ts` in
> the gallery slot after `retrofuturism`. The block, the scalars and the rules are
> created by the build that transcribes this record; this record fixes them.

## Copy

| field         | value                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id            | `art-deco`                                                                                                                                                                                                   |
| name          | `Art Deco`                                                                                                                                                                                                   |
| tagline       | `Framed and geometric — double rules, stepped corners, and a metal edge drawn from your palette.`                                                                                                            |
| inspiration   | `The Art Deco movement — the 1925 Paris Exposition's geometric ornament, ziggurat and stepped massing (the Chrysler Building's crown, 1930), and the double-rule frames of period posters and book jackets.` |
| defaultTypeId | `grotesk` — already registered in `packages/design-system/src/theme/typography.ts`, so this style adds no font and waits on none                                                                             |
| designDoc     | `docs/styles/art-deco.md`                                                                                                                                                                                    |

## Reference

The reference is **the Art Deco movement**: the 1925 Paris Exposition's geometric
ornament and the ziggurat / stepped massing of the period. **No shipped
product's token-level Art Deco implementation was reachable** — what turned up
were design-prompt collections and CSS snippets, not products with a token model
— so the formal rules come from the movement and from this project's own shipped
style contract. Four things were taken, and each set a rule below:

1. The ziggurat (the Chrysler Building's crown, 1930) → the three-step corner.
2. The double rule of period posters and book jackets → the frame band, not a
   single border.
3. "The gradient angle IS the light direction" → one declared light-angle scalar
   every metal edge obeys.
4. The period's prohibitions — no pill or rounded corners, no bevels or shadows on
   the metal → a flat two-tone edge, which also keeps this style apart from
   Retrofuturism's glossy chrome.

**Not this style:** Memphis (owns a canvas pattern; Art Deco adds no canvas),
High-Contrast / Accessible (whose heaviness carries meaning; here it is ornament
and never carries information), Neo-Brutalism (depth by a hard offset block; here
depth is the frame).

## Feel-bearing dimensions

| key        | line                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| silhouette | Squared plates — 2px buttons and cards, 4px modals, with a three-step corner cut into every panel. Geometric, symmetrical, machined.                                                                                      |
| stroke     | DOUBLE rules everywhere — a 2px metal edge, a 2px gap, then a 1px inner rule. The frame is the structure: a plate is drawn, never lifted.                                                                                 |
| elevation  | Flat-near-flat — plates sit on a tight neutral shadow and nothing glows or blocks; depth is the frame, not the lift.                                                                                                      |
| surface    | Opaque, matte, untextured palette plates — no wash, no glass, no pattern. The identity is the two-rule frame and the stepped corners cut into it.                                                                         |
| density    | Measured and symmetrical — 20x10 buttons, 24px card padding, 38px controls: generous enough that the frame never crowds its content.                                                                                      |
| motion     | Unhurried and mechanical — 140ms transitions and NO scale on hover or press; feedback is the edge stepping one tonal value.                                                                                               |
| typography | Ships the grotesk pairing — wide geometric grotesque headlines over a sans body, the geometric display read of the period.                                                                                                |
| components | Squared buttons, inputs, cards and modals; rectangular status chips; double-ruled plates with stepped corners; a ruled modal entablature; a double-rule lid on the header and a double vertical rule on the sidebar edge. |

## Token block

The block may set no `--color-*`, `--el-*` or `--font-*` token.

| group          | token                                         | value                                                       |
| -------------- | --------------------------------------------- | ----------------------------------------------------------- |
| radius (roles) | `--radius-btn` / `-input` / `-card`           | 2px / 2px / 2px                                             |
|                | `--radius-modal`                              | 4px                                                         |
|                | `--radius-control` / `-kbd`                   | 2px / 2px                                                   |
|                | `--radius-badge`                              | 0px (rectangular chips)                                     |
| radius (scale) | `--radius-xs` / `-sm` / `-md` / `-lg` / `-xl` | 2 / 2 / 3 / 4 / 6px                                         |
|                | `--radius-pill`                               | untouched — avatars, status dots and the spinner stay round |
| elevation      | `--shadow-subtle`                             | `0 1px 1px rgba(15, 15, 15, 0.04)`                          |
|                | `--shadow-card`                               | `0 1px 2px rgba(15, 15, 15, 0.06)`                          |
|                | `--shadow-elevated`                           | `0 3px 8px -2px rgba(15, 15, 15, 0.10)`                     |
|                | `--shadow-modal`                              | `0 20px 44px -20px rgba(15, 15, 15, 0.24)`                  |
|                | `--shadow-flat` / `--shadow-hero-mockup`      | base values, not set                                        |
| density        | `--spacing-btn-x` / `-y`                      | 20px / 10px                                                 |
|                | `--spacing-card-padding`                      | 24px                                                        |
|                | `--spacing-control-x` / `-y`                  | 12px / 7px                                                  |
|                | `--height-control`                            | 38px                                                        |
| motion         | `--transition-duration` / `--transition-slow` | 140ms / 260ms                                               |
|                | `--hover-scale` / `--active-scale`            | 1 / 1                                                       |
| focus          | `--focus-ring-width` / `--focus-ring-offset`  | 2px / 2px (the base, stated so it stays)                    |
| not set        | `--spacing-rail-inset`                        | stays 0px; only a floating rail moves it                    |
|                | `--width-rail-chrome`                         | never overridden per style                                  |

Every base above is one the twenty-one derived density steps scale from through
the single `:root, [data-style]` rule, so no step is written per style:

| base                     | ref px | here        | step → resolved                               |
| ------------------------ | ------ | ----------- | --------------------------------------------- |
| `--spacing-card-padding` | 24     | 24px        | 16 → 16, 12 → 12, 8 → 8, 4 → 4                |
| `--spacing-control-x`    | 10     | 12px        | 16 → 19, 12 → 14, 8 → 10, 6 → 7, 4 → 5, 2 → 2 |
| `--spacing-control-y`    | 6      | 7px         | 8 → 9, 4 → 5, 2 → 2                           |
| `--spacing-chip-x`       | 10     | 10px (base) | 8 → 8, 6 → 6, 4 → 4, 2 → 2                    |
| `--height-control`       | 36     | 38px        | 28 → 30, 32 → 34, 40 → 42, 48 → 51            |

**The rail.** 38 + 20 = 58px collapsed column, a 41px content box for a 38px row.

### The eleven `--deco-*` scalars

Palette-agnostic — lengths, an angle and percentages, never a colour.

| scalar                    | value  | what it is                                     |
| ------------------------- | ------ | ---------------------------------------------- |
| `--deco-rule-outer`       | 2px    | the outer (metal) rule                         |
| `--deco-rule-inner`       | 1px    | the inner rule                                 |
| `--deco-rule-gap`         | 2px    | the gap between them                           |
| `--deco-rule-entablature` | 1px    | the modal's third rule                         |
| `--deco-entablature-gap`  | 6px    | its gap below the inner rule                   |
| `--deco-step`             | 8px    | one step of a plate's stepped corner           |
| `--deco-step-modal`       | 12px   | one step of the modal's stepped corner         |
| `--deco-light-angle`      | 115deg | the one light direction every metal edge obeys |
| `--deco-metal-light`      | 62%    | lightness of the metal's lit line              |
| `--deco-metal-shade`      | 34%    | darkness of the metal's shaded line            |
| `--deco-edge-tint`        | 42%    | how much accent tints the border-strong edge   |

```css
[data-style='art-deco'] {
  --radius-xs: 2px;
  --radius-sm: 2px;
  --radius-md: 3px;
  --radius-lg: 4px;
  --radius-xl: 6px;
  --radius-btn: 2px;
  --radius-input: 2px;
  --radius-card: 2px;
  --radius-modal: 4px;
  --radius-control: 2px;
  --radius-badge: 0px;
  --radius-kbd: 2px;
  --shadow-subtle: 0 1px 1px rgba(15, 15, 15, 0.04);
  --shadow-card: 0 1px 2px rgba(15, 15, 15, 0.06);
  --shadow-elevated: 0 3px 8px -2px rgba(15, 15, 15, 0.1);
  --shadow-modal: 0 20px 44px -20px rgba(15, 15, 15, 0.24);
  --spacing-btn-x: 20px;
  --spacing-btn-y: 10px;
  --spacing-card-padding: 24px;
  --spacing-control-x: 12px;
  --spacing-control-y: 7px;
  --height-control: 38px;
  --transition-duration: 140ms;
  --transition-slow: 260ms;
  --hover-scale: 1;
  --active-scale: 1;
  --focus-ring-width: 2px;
  --focus-ring-offset: 2px;
  --deco-rule-outer: 2px;
  --deco-rule-inner: 1px;
  --deco-rule-gap: 2px;
  --deco-rule-entablature: 1px;
  --deco-entablature-gap: 6px;
  --deco-step: 8px;
  --deco-step-modal: 12px;
  --deco-light-angle: 115deg;
  --deco-metal-light: 62%;
  --deco-metal-shade: 34%;
  --deco-edge-tint: 42%;
}
```

## Frame geometry

- **The band is 5px** — 2px outer rule, 2px gap, 1px inner rule — drawn
  **inside** the plate's own box as inset box-shadow rings. The plate's existing
  1px border, recoloured to the edge, is the first pixel of the outer rule, so
  no border width changes and no layout moves. Inset rather than outside,
  because an outer ring would sit under the 2px focus ring at its 2px offset and
  shift the plate's edge wherever two surfaces abut.
- **A stepped corner is 3 steps of 8px**, at all four corners of a card,
  painted as `background-image` corner marks just inside the band: three
  rectangles per corner (24 × 8, 16 × 16, 8 × 24) forming a ziggurat. It owns no
  pseudo-element and paints under content.
- **The modal steps at 12px** (on its two bottom corners, under the footer, so
  the title row stays clear) and carries the **entablature**: a third 1px rule
  6px below the inner rule, on the top edge only.
- **One light direction.** `--deco-light-angle` sets the metal's split on the
  hero pill; on plates the lit line sits on the top-left edge and the shaded
  line bottom-right, the same 115° light.
- **The metal is flat** — two tonal halves, no bevel, no specular streak, no
  glow.

**Ruled out, with the reason:**

- **A clip-path on a plate** — it clips the plate's own children, its focus ring
  and any popover that escapes it.
- **A pseudo-element frame on a plate** — a plate has no reserved pseudo-element,
  and the hero controls need theirs.
- **A focus-ring colour in the token block** — it is a colour token, which the
  block may not hold, and each palette already tunes its own focus colour.
- **Any new markup hook.**

## The elements

| element           | hook (emitter)                                                                               | what the rule paints                                                                                                                                                                                                                                                                                                                                         | palette roles                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| card (the plate)  | `data-surface='card'` (`packages/design-system/src/components/ui/Card.tsx`)                  | the 5px band with the lit / shaded metal lines, the gap filled with the card's own fill, the four stepped corners, `--shadow-card`                                                                                                                                                                                                                           | edge `--el-accent` 42% into `--el-border-strong`; gap `--el-card`; marks `--el-accent` 12% into `--el-card` |
| popover           | `data-surface='popover'` (`packages/design-system/src/components/ui/Popover.tsx`)            | 1px outer (its border) / 2px gap / 1px inner, no steps — a menu is a strip, not a monument                                                                                                                                                                                                                                                                   | edge as above; gap `--el-page-bg`                                                                           |
| modal             | `data-surface='modal'` (`packages/design-system/src/components/ui/Modal.tsx`)                | the band, the entablature rule, 12px stepped corners, `--shadow-modal`                                                                                                                                                                                                                                                                                       | edge as above; gap `--el-page-bg`                                                                           |
| sidebar           | `data-surface='sidebar'` (`components/ui/Sidebar.tsx`)                                       | the shared edge as an inset vertical double rule (2px, 2px gap, 1px), painted as `background-image`. The rail root already paints `border-r border-(--el-sidebar-border)`; the design widens that edge in its own colour rather than recolouring it, and leaves the element's border width alone, so the collapsed rail's content box is unchanged. No steps | `--el-sidebar-border`                                                                                       |
| input             | `data-surface='input'` (`packages/design-system/src/components/ui/Input.tsx`)                | one 2px rule at rest; on focus the gap and the inner 1px rule appear and the band closes                                                                                                                                                                                                                                                                     | edge as above; gap `--el-page-bg`; invalid `--el-danger`                                                    |
| header            | `data-surface='header'` (`app/(authed)/_components/TopNav.tsx`)                              | a 2px rule under the lid and a 1px rule 3px below it, as `background-image`                                                                                                                                                                                                                                                                                  | edge as above                                                                                               |
| overlay           | `data-surface='overlay'` (`packages/design-system/src/components/ui/Modal.tsx`)              | a heavier neutral scrim, so a modal reads as a plate on a page                                                                                                                                                                                                                                                                                               | `--el-border-strong` mixed into `--el-page-bg`, at 72% opacity                                              |
| hero pill         | `data-surface='ai-cta'`, `data-ai-cta='pill'` (`components/planning/PlanWithAILauncher.tsx`) | squared to the button radius; a flat two-tone metal fill split at the light angle in `--plan-hero-fill`; the band and a hard 2px ink line in `--plan-hero-shadow`                                                                                                                                                                                            | `--el-accent`, 10% `--el-accent-text`; edge as above; line `--el-text` 60%                                  |
| hero orb          | `data-surface='ai-cta'`, `data-ai-cta='orb'` (`components/planning/PlanWithAIFab.tsx`)       | keeps its circle; radial two-tone metal in `--plan-orb-fill` with the guarded first stop; outer ring in `--plan-orb-shadow`; inner concentric ring on `::after`                                                                                                                                                                                              | `--el-accent`, `--el-accent-text` through `--orb-lit-mix` (read, never redeclared), `--el-text`             |
| buttons and chips | none                                                                                         | tokens only: 2px button and control radius, 0px badge radius. No stepped corner on a control — a ziggurat on a 32px button is noise                                                                                                                                                                                                                          | —                                                                                                           |

The pill's band rides its shadow seam as inset rings, so only the orb's inner
ring needs a pseudo-element. No rule writes `background-image` or `box-shadow`
on the hero controls themselves (both components declare those inline, and a
stylesheet rule loses), and no rule animates anything.

**The colour contract.** Every colour is `var(--el-*)`, a `color-mix()` over
them, or the element's inherited ink. The achromatic `white` and `black` keywords
appear only as the metal's lightness, mixed over the palette edge, never as a
colour source. No hex literal appears in the layer.

```css
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='card'] {
    --deco-edge: color-mix(
      in srgb,
      var(--el-accent) var(--deco-edge-tint),
      var(--el-border-strong)
    );
    --deco-mark: color-mix(in srgb, var(--el-accent) 12%, var(--el-card));
    --deco-band: calc(var(--deco-rule-outer) + var(--deco-rule-gap) + var(--deco-rule-inner));
    border-color: var(--deco-edge);
    box-shadow:
      inset 1px 1px 0 0 color-mix(in srgb, white var(--deco-metal-light), var(--deco-edge)),
      inset -1px -1px 0 0 color-mix(in srgb, black var(--deco-metal-shade), var(--deco-edge)),
      inset 0 0 0 calc(var(--deco-rule-outer) - 1px) var(--deco-edge),
      inset 0 0 0 calc(var(--deco-rule-outer) + var(--deco-rule-gap) - 1px) var(--el-card),
      inset 0 0 0 calc(var(--deco-band) - 1px) var(--deco-edge),
      var(--shadow-card);
    background-image:
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark));
    background-repeat: no-repeat;
    background-size:
      calc(var(--deco-step) * 3) var(--deco-step),
      calc(var(--deco-step) * 2) calc(var(--deco-step) * 2),
      var(--deco-step) calc(var(--deco-step) * 3),
      calc(var(--deco-step) * 3) var(--deco-step),
      calc(var(--deco-step) * 2) calc(var(--deco-step) * 2),
      var(--deco-step) calc(var(--deco-step) * 3),
      calc(var(--deco-step) * 3) var(--deco-step),
      calc(var(--deco-step) * 2) calc(var(--deco-step) * 2),
      var(--deco-step) calc(var(--deco-step) * 3),
      calc(var(--deco-step) * 3) var(--deco-step),
      calc(var(--deco-step) * 2) calc(var(--deco-step) * 2),
      var(--deco-step) calc(var(--deco-step) * 3);
    background-position:
      left var(--deco-band) top var(--deco-band),
      left var(--deco-band) top var(--deco-band),
      left var(--deco-band) top var(--deco-band),
      right var(--deco-band) top var(--deco-band),
      right var(--deco-band) top var(--deco-band),
      right var(--deco-band) top var(--deco-band),
      left var(--deco-band) bottom var(--deco-band),
      left var(--deco-band) bottom var(--deco-band),
      left var(--deco-band) bottom var(--deco-band),
      right var(--deco-band) bottom var(--deco-band),
      right var(--deco-band) bottom var(--deco-band),
      right var(--deco-band) bottom var(--deco-band);
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='popover'] {
    --deco-edge: color-mix(
      in srgb,
      var(--el-accent) var(--deco-edge-tint),
      var(--el-border-strong)
    );
    border-color: var(--deco-edge);
    box-shadow:
      inset 0 0 0 var(--deco-rule-gap) var(--el-page-bg),
      inset 0 0 0 calc(var(--deco-rule-gap) + var(--deco-rule-inner)) var(--deco-edge),
      var(--shadow-elevated);
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='modal'] {
    --deco-edge: color-mix(
      in srgb,
      var(--el-accent) var(--deco-edge-tint),
      var(--el-border-strong)
    );
    --deco-mark: color-mix(in srgb, var(--el-accent) 12%, var(--el-page-bg));
    --deco-band: calc(var(--deco-rule-outer) + var(--deco-rule-gap) + var(--deco-rule-inner));
    border-color: var(--deco-edge);
    box-shadow:
      inset 1px 1px 0 0 color-mix(in srgb, white var(--deco-metal-light), var(--deco-edge)),
      inset -1px -1px 0 0 color-mix(in srgb, black var(--deco-metal-shade), var(--deco-edge)),
      inset 0 0 0 calc(var(--deco-rule-outer) - 1px) var(--deco-edge),
      inset 0 0 0 calc(var(--deco-rule-outer) + var(--deco-rule-gap) - 1px) var(--el-page-bg),
      inset 0 0 0 calc(var(--deco-band) - 1px) var(--deco-edge),
      inset 0 calc(var(--deco-band) + var(--deco-entablature-gap) - 1px) 0 0 var(--el-page-bg),
      inset 0
        calc(var(--deco-band) + var(--deco-entablature-gap) + var(--deco-rule-entablature) - 1px) 0
        0 var(--deco-edge),
      var(--shadow-modal);
    background-image:
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark)),
      linear-gradient(var(--deco-mark), var(--deco-mark));
    background-repeat: no-repeat;
    background-size:
      calc(var(--deco-step-modal) * 3) var(--deco-step-modal),
      calc(var(--deco-step-modal) * 2) calc(var(--deco-step-modal) * 2),
      var(--deco-step-modal) calc(var(--deco-step-modal) * 3),
      calc(var(--deco-step-modal) * 3) var(--deco-step-modal),
      calc(var(--deco-step-modal) * 2) calc(var(--deco-step-modal) * 2),
      var(--deco-step-modal) calc(var(--deco-step-modal) * 3);
    background-position:
      left var(--deco-band) bottom var(--deco-band),
      left var(--deco-band) bottom var(--deco-band),
      left var(--deco-band) bottom var(--deco-band),
      right var(--deco-band) bottom var(--deco-band),
      right var(--deco-band) bottom var(--deco-band),
      right var(--deco-band) bottom var(--deco-band);
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='sidebar'] {
    background-image: linear-gradient(
      to left,
      var(--el-sidebar-border) 0 var(--deco-rule-outer),
      transparent var(--deco-rule-outer) calc(var(--deco-rule-outer) + var(--deco-rule-gap)),
      var(--el-sidebar-border) calc(var(--deco-rule-outer) + var(--deco-rule-gap))
        calc(var(--deco-rule-outer) + var(--deco-rule-gap) + var(--deco-rule-inner)),
      transparent calc(var(--deco-rule-outer) + var(--deco-rule-gap) + var(--deco-rule-inner))
    );
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='header'] {
    --deco-edge: color-mix(
      in srgb,
      var(--el-accent) var(--deco-edge-tint),
      var(--el-border-strong)
    );
    background-image: linear-gradient(
      to top,
      var(--deco-edge) 0 var(--deco-rule-outer),
      transparent var(--deco-rule-outer) calc(var(--deco-rule-outer) + 3px),
      var(--deco-edge) calc(var(--deco-rule-outer) + 3px)
        calc(var(--deco-rule-outer) + 3px + var(--deco-rule-inner)),
      transparent calc(var(--deco-rule-outer) + 3px + var(--deco-rule-inner))
    );
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='input'] {
    --deco-edge: color-mix(
      in srgb,
      var(--el-accent) var(--deco-edge-tint),
      var(--el-border-strong)
    );
    border-color: var(--deco-edge);
    box-shadow: inset 0 0 0 calc(var(--deco-rule-outer) - 1px) var(--deco-edge);
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='input']:focus {
    box-shadow:
      inset 0 0 0 calc(var(--deco-rule-outer) - 1px) var(--deco-edge),
      inset 0 0 0 calc(var(--deco-rule-outer) + var(--deco-rule-gap) - 1px) var(--el-page-bg),
      inset 0 0 0 calc(var(--deco-rule-outer) + var(--deco-rule-gap) + var(--deco-rule-inner) - 1px)
        var(--deco-edge);
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='input'][aria-invalid='true'] {
    --deco-edge: var(--el-danger);
    box-shadow:
      inset 0 0 0 calc(var(--deco-rule-outer) - 1px) var(--deco-edge),
      inset 0 0 0 calc(var(--deco-rule-outer) + var(--deco-rule-gap) - 1px) var(--el-page-bg),
      inset 0 0 0 calc(var(--deco-rule-outer) + var(--deco-rule-gap) + var(--deco-rule-inner) - 1px)
        var(--deco-edge);
  }
}
@media (hover: hover) {
  @scope ([data-style='art-deco']) to ([data-style]) {
    :is([data-surface='card'], [data-surface='input']):hover {
      --deco-edge: color-mix(in srgb, var(--el-accent) 58%, var(--el-border-strong));
    }
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='card']:is(a, button, [role='button']):active {
    --deco-edge: color-mix(in srgb, var(--el-accent) 74%, var(--el-border-strong));
    --deco-rule-inner: 2px;
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  :is([aria-selected='true'], [aria-current='page']):not([data-surface]) {
    background-color: color-mix(in srgb, var(--el-accent) 8%, var(--el-page-bg));
    box-shadow: inset 2px 0 0 0 var(--el-accent);
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  :is([data-surface='card'], [data-surface='modal'], [data-surface='popover'])
    [data-surface='card'] {
    background-image: none;
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='overlay'] {
    background-color: color-mix(
      in srgb,
      color-mix(in srgb, var(--el-border-strong) 60%, var(--el-page-bg)) 72%,
      transparent
    );
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='ai-cta'] {
    --deco-edge: color-mix(
      in srgb,
      var(--el-accent) var(--deco-edge-tint),
      var(--el-border-strong)
    );
    --plan-hero-shadow:
      inset 0 0 0 var(--deco-rule-outer) var(--deco-edge),
      inset 0 0 0 calc(var(--deco-rule-outer) + var(--deco-rule-gap)) var(--el-accent),
      inset 0 0 0 calc(var(--deco-rule-outer) + var(--deco-rule-gap) + var(--deco-rule-inner))
        var(--deco-edge),
      0 2px 0 0 color-mix(in srgb, var(--el-text) 60%, transparent);
    --plan-orb-shadow:
      inset 0 0 0 var(--deco-rule-outer) var(--deco-edge),
      0 2px 0 0 color-mix(in srgb, var(--el-text) 60%, transparent);
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    border-radius: var(--radius-btn);
    --plan-hero-fill: linear-gradient(
      var(--deco-light-angle),
      color-mix(in srgb, var(--el-accent) 96%, var(--el-accent-text)) 0 50%,
      var(--el-accent) 50% 100%
    );
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='orb'] {
    --plan-orb-fill: radial-gradient(
      circle at 33% 27%,
      color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent)) 0%,
      var(--el-accent) 55%,
      color-mix(in srgb, var(--el-accent) 88%, var(--el-text)) 55% 100%
    );
  }
}
@scope ([data-style='art-deco']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='orb']::after {
    content: '';
    position: absolute;
    inset: calc(var(--deco-rule-outer) + var(--deco-rule-gap));
    border-radius: 9999px;
    border: var(--deco-rule-inner) solid var(--deco-edge);
    pointer-events: none;
  }
}
```

## States

- **Rest, every palette, both modes** — the plate's surface fill, the band, the
  stepped corners. Light and dark change nothing about the geometry; every colour
  is an `--el-*` role that flips with the mode.
- **Hover (pointer only, `@media (hover: hover)`)** — the edge steps one tonal
  value toward the accent (42% → 58%). Geometry unchanged, nothing scales.
- **Focus-visible** — the palette's 2px ring at a 2px offset, outside the inset
  band. The frame does not change, so focus is never mistaken for selection.
- **Pressed** — the edge steps one further value (74%) and the inner rule
  thickens by one pixel for the press. No translate, no scale.
- **Disabled** — the frame and the corner stay; the primitives drop the text to
  the palette's muted roles. Nothing is removed: here the frame is structure.
- **Selected** (a row, a tab, a nav item carrying `aria-selected='true'` or
  `aria-current='page'`) — a 2px accent rule on the leading edge, and the fill
  stepped 8% toward the accent. The plate's double rule is unchanged.
- **Invalid** (`aria-invalid='true'` on an input) — the rule takes the palette's
  danger role and the inner 1px rule appears. The focus ring is a different
  signal and is unaffected.
- **Empty / loading / error on a framed surface** — the frame persists in all
  three; a loading plate does not shimmer.
- **Nested plates** — a card inside a modal, a popover or another card keeps its
  band and drops its stepped corners, so nesting does not double the ceremony.
- **Minimum-size surfaces** — an input, an icon button, a chip — carry the outer
  rule alone at rest, with no inner rule and no stepped corner.
- **The collapsed rail** — the inset vertical double rule leaves the border width
  untouched, so the rail's content box stays 41px for its 38px row;
  `--spacing-rail-inset` stays 0 and the rail stays flush.
- **Reduced motion** — nothing to suppress: no animation, and hover and press are
  colour steps.

**Observed in the mock:** a card drawn with a tighter padding step than the
default 24px (the vignette's cards) brings the stepped corner up to the edge of
its content's first glyph. At the default 24px padding the corner marks (which
reach 29px from the edge along an 8px strip) stay clear of content. The marks are
a 12% accent tint, so a glyph over them keeps its palette contrast, but the
build should check compact cards in the render.

## Accessibility

- **The band never carries text.** It is at most 5px of rule inside the plate's
  own padding.
- **No state is carried by the metal alone.** Press thickens the inner rule;
  selected adds a rule; focus adds the ring; invalid repaints the rule in the
  danger role. Someone who cannot resolve the accent tint still sees a structural
  change. Hover is the one tone-only step, and it is pointer-only feedback that
  carries no information.
- **Text keeps the palette's pairings.** The only fill the style mixes is the
  selected tint, capped at 8% so the palette's AA pairing survives; the style ×
  palette × mode gate measures it.
- **Focus is visible and never collides.** The ring is the base 2px at 2px
  offset, and the band is inset, so the ring lands outside the frame.
- **Targets do not shrink.** `--height-control` is 38px, above the base 36px.
- **Nothing animates.**
