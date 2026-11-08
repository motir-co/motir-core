# Style — Memphis (`data-style="memphis"`)

> Loud post-modern collage. Its token block is the `[data-style='memphis']` block
> in [`packages/design-system/theme.css`](../../packages/design-system/theme.css)
> — the live token layer, which `app/globals.css` imports — with its component
> rules, canvas and hero rules beside it, and it is registered in
> [`packages/design-system/src/theme/styles.ts`](../../packages/design-system/src/theme/styles.ts)
> (whose header prose still names `globals.css` from before the move; the
> package file is the live one), in the gallery slot after `retrofuturism`. The
> mock is [`design/styles/memphis.mock.html`](../../design/styles/memphis.mock.html).

| field         | value                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id            | `memphis`                                                                                                                                                 |
| name          | `Memphis`                                                                                                                                                 |
| tagline       | `Playful, loud post-modern collage: mismatched corners, thick outlines and hard two-block shadows over a dot-and-hatch canvas.`                           |
| inspiration   | `The Memphis Group (Memphis Milano, Milan, 1980, Ettore Sottsass) — Sottsass's Bacterio squiggle-and-dot pattern, clashing geometry and laminate colour.` |
| defaultTypeId | `rounded`                                                                                                                                                 |
| designDoc     | `docs/styles/memphis.md`                                                                                                                                  |

**Wrong moods:** flat, calm, structural, hairline, monochrome, corporate.

**Reference.** The Memphis Group, founded in Milan in 1980 around Ettore
Sottsass: clashing geometry, laminate colour, and Sottsass's _Bacterio_
squiggle-and-dot laminate pattern. Taken: the mismatched geometry, the thick
outline, the pasted-on hard shadow and the dot rhythm as a texture. Not taken:
the laminate colours themselves — colour is the palette axis's, so every hue
here is the active palette's accent, highlight, link or ink.

## Registry copy — the eight dimension lines

| key        | line                                                                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| silhouette | Deliberately mismatched radii: 10px buttons against 2px inputs, and cards and modals carrying one round corner pair and one near-square pair, so every panel reads as a collage rather than a machine-cut rectangle. |
| stroke     | Loud 2px solid outlines on every panel and input, drawn in the palette's own ink at strength; the edge, not the shadow, is what tells you where a surface stops.                                                     |
| elevation  | Hard-offset shadows with zero blur, in two blocks: a solid ink block nudged down-right plus a second block in the palette's accent, so a panel looks physically pasted onto the page.                                |
| surface    | Opaque palette panels over a palette-derived canvas of staggered dots and a diagonal hatch — the Bacterio rhythm held at low alpha, so it stays a texture and never a background.                                    |
| density    | Comfortable-loud: 20x11 buttons, 26px card padding, 40px controls — roomy enough for the outline and the offset block to breathe.                                                                                    |
| motion     | Fast and physical: 140ms transitions, a 1.01 hover swell and a 0.97 press, with the canvas pattern static so the loudness never moves on its own.                                                                    |
| typography | Ships the `rounded` pairing (Nunito throughout) — a soft, friendly sans that lets the loud geometry do the shouting; a pinned type overrides it.                                                                     |
| components | Collage-cornered cards, popovers and modals, 2px-radii inputs, pill status chips, every panel outlined at 2px with the doubled hard shadow.                                                                          |

In the registry the _Bacterio_ name is written plain (no emphasis), exactly as in
the inspiration string above.

## Token overrides

Shape/feel only. Shadow ink is an rgba literal, as the shipped blocks carry it;
no `--color-*`, `--el-*` or `--font-*` declaration belongs here.
`--spacing-rail-inset` and `--width-rail-chrome` are deliberately absent.

```css
[data-style='memphis'] {
  --radius-xs: 0px;
  --radius-sm: 2px;
  --radius-md: 6px;
  --radius-lg: 14px;
  --radius-xl: 22px;
  --radius-btn: 10px;
  --radius-input: 2px;
  --radius-card: 6px;
  --radius-modal: 22px;
  --radius-badge: 9999px;
  --radius-control: 8px;
  --radius-kbd: 3px;
  --shadow-subtle: 2px 2px 0 0 rgba(15, 15, 15, 0.92);
  --shadow-card: 5px 5px 0 0 rgba(15, 15, 15, 1);
  --shadow-elevated: 7px 7px 0 0 rgba(15, 15, 15, 1);
  --spacing-shadow-elevated-drop: 7px; /* the Y offset of --shadow-elevated above */
  --shadow-modal: 9px 9px 0 0 rgba(15, 15, 15, 1);
  --shadow-hero-mockup: 7px 7px 0 0 rgba(15, 15, 15, 1);
  --spacing-btn-x: 20px;
  --spacing-btn-y: 11px;
  --spacing-btn-x-sm: 14px;
  --spacing-btn-y-sm: 8px;
  --spacing-input-x: 16px;
  --spacing-input-y: 12px;
  --spacing-card-padding: 26px;
  --spacing-control-x: 12px;
  --spacing-control-y: 7px;
  --spacing-icon-btn: 6px;
  --spacing-chip-x: 12px;
  --spacing-chip-y: 2px;
  --spacing-kbd-x: 6px;
  --spacing-kbd-y: 2px;
  --spacing-tooltip-x: 8px;
  --spacing-tooltip-y: 4px;
  --height-btn-sm: 34px;
  --height-btn-md: 42px;
  --height-btn-lg: 50px;
  --height-input: 46px;
  --height-control: 40px;
  --transition-duration: 140ms;
  --transition-fast: 90ms;
  --transition-slow: 200ms;
  --hover-scale: 1.01;
  --active-scale: 0.97;
  --focus-ring-width: 3px;
  --focus-ring-offset: 2px;
}
```

**Derived density steps** — round(nearest, base × step ÷ reference px, 1px), the
shared rule in `packages/design-system/theme.css`:

| base                     | value | step → resolved                               |
| ------------------------ | ----- | --------------------------------------------- |
| `--spacing-card-padding` | 26px  | 16 → 17, 12 → 13, 8 → 9, 4 → 4                |
| `--spacing-control-x`    | 12px  | 16 → 19, 12 → 14, 8 → 10, 6 → 7, 4 → 5, 2 → 2 |
| `--spacing-control-y`    | 7px   | 8 → 9, 4 → 5, 2 → 2                           |
| `--spacing-chip-x`       | 12px  | 8 → 10, 6 → 7, 4 → 5, 2 → 2                   |
| `--height-control`       | 40px  | 28 → 31, 32 → 36, 40 → 44, 48 → 53            |

Every step is a positive whole pixel. **The rail:** 40 + 20 = 60px collapsed
column, a 43px content box for the 40px row, the inset at its 0px base.

## Component-variant rules — outlines, collage corners, the accent block

No border-width token exists, so the 2px outline cannot ride the token block
(the Neo-Brutalism block carries its 2px rule as a scoped override for the same
reason). It rides style-scoped rules on the hooks the primitives already emit.
Corners alternate so no two adjacent corners round the same amount. Each
`@scope` block holds one rule.

```css
@scope ([data-style='memphis']) to ([data-style]) {
  [data-surface='card'],
  [data-surface='popover'] {
    border-width: 2px;
    border-style: solid;
    border-color: color-mix(in srgb, var(--el-text) 86%, transparent);
    border-radius: var(--radius-card) var(--radius-xl) var(--radius-card) var(--radius-xl);
    box-shadow:
      var(--shadow-card),
      3px 3px 0 0 color-mix(in srgb, var(--el-accent) 70%, transparent);
  }
}
@scope ([data-style='memphis']) to ([data-style]) {
  [data-surface='modal'] {
    border-width: 2px;
    border-style: solid;
    border-color: color-mix(in srgb, var(--el-text) 86%, transparent);
    border-radius: var(--radius-xl) var(--radius-card) var(--radius-xl) var(--radius-card);
    box-shadow:
      var(--shadow-modal),
      4px 4px 0 0 color-mix(in srgb, var(--el-accent) 70%, transparent);
  }
}
@scope ([data-style='memphis']) to ([data-style]) {
  [data-surface='sidebar'] {
    border-right-width: 2px;
  }
}
@scope ([data-style='memphis']) to ([data-style]) {
  [data-surface='input'] {
    border-width: 2px;
    border-style: solid;
    border-color: color-mix(in srgb, var(--el-text) 70%, transparent);
    border-radius: var(--radius-input);
    box-shadow: var(--shadow-subtle);
  }
}
@scope ([data-style='memphis']) to ([data-style]) {
  [data-surface='input']:focus-visible {
    border-color: color-mix(in srgb, var(--el-text) 92%, transparent);
  }
}
@scope ([data-style='memphis']) to ([data-style]) {
  [data-surface='input']:disabled {
    border-color: color-mix(in srgb, var(--el-text) 32%, transparent);
    box-shadow: none;
  }
}
```

- The outline is the boundary and the hard shadow is decoration: no edge depends
  on a shadow.
- Disabled controls keep their outline at a muted alpha and lose the accent
  block.
- The invalid field keeps the palette's own danger edge, which the primitive
  already paints, at the style's 2px weight; the style pins no hue.

**Why the sidebar row is width only.** The shell-chrome guard takes the property
set of the 3D / Immersive rail rule — `margin`, `height`, `border-radius`,
`border-right-color`, `box-shadow` — and refuses any of those names in another
style's chrome rule, so a style cannot silently re-shape a shell. The rail root
already paints a 1px right border in the palette's rail colour and carries no
radius; widening it to 2px is the whole visible change, and the rail's width
arithmetic is untouched.

## The canvas pattern

One rule, two members: the shell root paints an opaque page fill over the
viewport, so a body-only canvas would be invisible on every signed-in route.
`background-attachment: fixed`, set once, makes the two members resolve
pixel-identically. The style-preview vignette is a nested wrapper that the
`body` rule cannot reach, so it carries the same three layers on its `.sv-canvas`
layer, the shipped mechanism every canvas style uses (without `fixed`, because a
gallery shows many vignettes at once).

```css
@scope ([data-style='memphis']) to ([data-style]) {
  body,
  [data-app-shell] {
    background-image:
      radial-gradient(
        circle at 9px 9px,
        color-mix(in srgb, var(--el-accent) 16%, transparent) 3px,
        transparent 3.5px
      ),
      radial-gradient(
        circle at 29px 29px,
        color-mix(in srgb, var(--el-highlight) 12%, transparent) 2px,
        transparent 2.5px
      ),
      repeating-linear-gradient(
        45deg,
        color-mix(in srgb, var(--el-link) 8%, transparent) 0 2px,
        transparent 2px 18px
      );
    background-size:
      40px 40px,
      40px 40px,
      auto;
    background-position:
      0 0,
      0 0,
      0 0;
    background-attachment: fixed;
  }
}
.style-vignette[data-style='memphis'] > .sv-canvas {
  background-color: var(--el-page-bg);
  background-image:
    radial-gradient(
      circle at 9px 9px,
      color-mix(in srgb, var(--el-accent) 16%, transparent) 3px,
      transparent 3.5px
    ),
    radial-gradient(
      circle at 29px 29px,
      color-mix(in srgb, var(--el-highlight) 12%, transparent) 2px,
      transparent 2.5px
    ),
    repeating-linear-gradient(
      45deg,
      color-mix(in srgb, var(--el-link) 8%, transparent) 0 2px,
      transparent 2px 18px
    );
  background-size:
    40px 40px,
    40px 40px,
    auto;
}
```

**Tile geometry.** A 40px square tile with one 3px dot at (9, 9) in the accent
and one 2px dot at (29, 29) in the highlight — a staggered lattice, the
_Bacterio_ dot rhythm — over an 18px diagonal hatch at 45° in the link hue.
**Peak alphas 16% / 12% / 8%**, mixed toward `transparent`; nothing is layered
above that. Nothing animates.

## The hero AI control

The pill and the orb paint their fill and shadow inline and read the seam
variables, so a rule writing `background-image` or `box-shadow` literally is
inert; and the two controls get a rule each, or the pill's gradient would
overwrite the orb's recipe.

```css
@scope ([data-style='memphis']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    --plan-hero-fill: linear-gradient(
      135deg,
      var(--el-accent) 0%,
      var(--el-accent) 86%,
      color-mix(in srgb, var(--el-accent) 88%, var(--el-highlight)) 100%
    );
    --plan-hero-shadow: 5px 5px 0 0 color-mix(in srgb, var(--el-text) 92%, transparent);
  }
}
@scope ([data-style='memphis']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='orb'] {
    --plan-orb-fill: radial-gradient(
      circle at 33% 27%,
      color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent)) 0%,
      var(--el-accent) 60%,
      color-mix(in srgb, var(--el-accent) 88%, var(--el-highlight)) 100%
    );
    --plan-orb-shadow: 4px 4px 0 0 color-mix(in srgb, var(--el-text) 92%, transparent);
  }
}
```

- **The pill's far stop stays accent-dominant (86%)**, because the label spans
  the whole pill and its far end sits on that stop — the shipped base fill is
  accent-dominant so the `--el-accent-text` label keeps its measured ratio.
- **The orb keeps the guarded first stop** — the glyph-colour mix through
  `--orb-lit-mix` — and takes the style's highlight only at its rim. The first
  stop is the lightest point and sits inside the glyph box, and
  `tests/theme/orb-glyph-contrast.test.ts` holds every palette × theme to that
  one declaration, so the style reads `--orb-lit-mix` and never redeclares it.
- **No `animation`.** The pill's shimmer stays the reduced-motion-gated class it
  is; a style-level animation would survive that gate.

## States

| state                                                     | treatment                                                                                                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas, light, any palette                                | three layers from `color-mix()` over the palette's `--el-accent`, `--el-highlight` and `--el-link` at 16 / 12 / 8%: a 40px staggered dot lattice and an 18px hatch, at texture strength |
| Canvas, dark                                              | the same layers over the dark theme's element values; nothing re-declared, the pattern inverts with the palette                                                                         |
| Palette swapped                                           | the pattern re-tints; no geometry moves                                                                                                                                                 |
| Signed-in routes                                          | `[data-app-shell]` is in the same canvas rule as `body`                                                                                                                                 |
| Anonymous routes (auth, the public site, the tokens page) | `body` carries the pattern from that one rule                                                                                                                                           |
| No type pinned / a pinned type                            | `rounded` re-types the UI / the pinned pairing wins; geometry unchanged either way                                                                                                      |
| Card and popover, rest                                    | 2px ink outline, a 5px ink offset block plus a 3px accent block, corners alternating 6px / 22px                                                                                         |
| Card and popover, hover                                   | swells to 1.01; the offset blocks do not move                                                                                                                                           |
| Focus-visible                                             | a 3px ring at a 2px offset in the palette's focus colour, outside the 2px outline                                                                                                       |
| Pressed                                                   | 0.97 scale, shadows unchanged (buttons have no surface hook)                                                                                                                            |
| Disabled                                                  | outline and offset at a muted alpha; accent block dropped                                                                                                                               |
| Input, empty / filled                                     | 2px outline at the 2px radius, sharper than the 10px button beside it; fill stays the palette's surface                                                                                 |
| Input, focused                                            | the 3px ring, clear of the outline                                                                                                                                                      |
| Input, invalid                                            | the palette's danger edge at 2px, the field's message carrying the error                                                                                                                |
| Input, disabled                                           | muted outline, no accent block, no ring                                                                                                                                                 |
| Modal open                                                | 2px outline, the 22px / 6px alternation, the 9px ink block plus a 4px accent block; the overlay as the primitives draw it                                                               |
| Sidebar rail                                              | flush at 0px inset, its right edge widened to 2px in the rail colour, a 40px control in a 60px track                                                                                    |
| Empty state                                               | an ordinary card: outline plus both blocks                                                                                                                                              |
| Loading skeleton                                          | skeleton shapes on the palette surface inside an outlined card; no shimmer added                                                                                                        |
| Error surface                                             | the palette's danger hue on the outline, both blocks kept                                                                                                                               |
| Hero pill                                                 | its accent-dominant fill and a 5px ink block; the shared focus ring; no added animation                                                                                                 |
| Floating orb                                              | its lit-sphere fill and a 4px ink block, separate from the pill's rule                                                                                                                  |
| Reduced motion                                            | nothing to gate: the canvas is static and the style declares no animation                                                                                                               |
| Unregistered style id                                     | resolves to `warm-editorial` through `resolveStyle`                                                                                                                                     |

**Observed in the mock:** the ink offset block is near-black neutral ink, as the
card's token values fix it, so on a dark page it nearly disappears and the accent
block carries the pasted-on read alone. The outline still marks every edge, so
no boundary is lost; whether the dark block wants a lighter ink is for the build
to judge against the render.

## Accessibility contract

- **Pattern alphas** — 16% accent, 12% highlight, 8% link over the page
  background. These are ceilings, and the contrast matrix measures against them.
- **Text never sits on the pattern.** Every text-bearing surface is an opaque
  palette panel; the style declares no fill and no text colour, so the palette's
  AA pairings are inherited.
- **Edges never depend on shadow.** Every panel and input carries a 2px outline
  at 70–86% of the palette's ink.
- **Focus** — 3px at a 2px offset in the palette's own focus colour. The style
  sets width and offset only: the colour token's Tier-0 value is
  `var(--color-primary)`, and a `--color-*` reference in a `[data-style]` block
  would break the style/palette disjointness.
- **Motion** — transitions only (hover 1.01, press 0.97, 90 / 140 / 200ms). No
  `animation`, and the canvas is static.
- **Colour is never the only cue.** Invalid inputs keep their outline and
  message; errors keep both blocks; status chips keep their labels.

## Why this is more than a token swap

Neo-Brutalism is the nearest shipped neighbour (outlines and hard shadows). Four
deltas, each a design decision:

1. **Two shadow blocks, not one** — an ink block plus an accent block, so a panel
   reads as pasted collage rather than as a printed slab.
2. **Mismatched corners** — alternating round and near-square corner pairs, and
   10px buttons beside 2px inputs, where Neo-Brutalism squares everything alike.
3. **A palette-derived canvas** — the dot-and-hatch texture; Neo-Brutalism paints
   no canvas.
4. **A soft type** — the `rounded` pairing lets the geometry shout, where
   Neo-Brutalism's type is as heavy as its frames.
