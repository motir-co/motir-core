# Style — Editorial Print / Newspaper (`data-style="editorial-print"`)

> A broadsheet front page, not a website wearing a serif. Its token block is the
> `[data-style='editorial-print']` block in
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css),
> with one `.border` override and the hero rules beside it, and it is registered
> in [`packages/design-system/src/theme/styles.ts`](../../packages/design-system/src/theme/styles.ts)
> in the gallery slot after `retrofuturism`. The mock is
> [`design/styles/editorial-print.mock.html`](../../design/styles/editorial-print.mock.html).

**This record is the source; the shipped style is its transcription.** The
registry entry, the token block, the `.border` override and the hero rules are
copied from it verbatim. A value that cannot ship as written is changed here
first, and the record re-read, so the two never disagree.

## Registry copy

| field         | value                                                                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id            | `editorial-print`                                                                                                                                                                                  |
| name          | `Editorial Print / Newspaper`                                                                                                                                                                      |
| tagline       | `Square corners, ink rules and no shadow — the calm authority of a printed column.`                                                                                                                |
| inspiration   | `Editorial print / broadsheet layout — the Financial Times redesign lineage (a slab-serif family drawn for a six-column grid) and newspaper column rules, heavy section rules and square corners.` |
| defaultTypeId | `slab`                                                                                                                                                                                             |
| designDoc     | `docs/styles/editorial-print.md`                                                                                                                                                                   |

## Feel-bearing dimensions

| key        | line                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| silhouette | Square, zero radius on every surface, pill left round for genuinely circular affordances.                           |
| stroke     | Structure drawn by a 2px ink section rule plus a 1px column rule, both in the palette's ink.                        |
| elevation  | None at any level, separation carried by rule weight and whitespace.                                                |
| surface    | Opaque palette paper, no texture, no wash, no translucency.                                                         |
| density    | Tight print rhythm, buttons 16×8, controls 32px, inputs 40px, card padding 24px.                                    |
| motion     | Near-instant 90ms transitions with no press-scale, the page is set, not animated.                                   |
| typography | The `slab` pairing (Roboto Slab headlines over Inter body), overridable by a pinned type.                           |
| components | Square buttons, inputs, cards, modals and rectangular status chips, 2px ink-framed surfaces, hairline column rules. |

## Reference — what was checked, and what was not

The anchor is the **Financial Times' 2014 print-and-web redesign lineage** — a
serif family with slab terminals commissioned for a six-column grid, with strong
masthead and section rules — together with the general **broadsheet
convention**: column rules between measures, a heavy rule under a masthead or
section head, square corners, flat unshadowed panels, tight leading, dense type.
The reference is the movement and the convention, not a competitor's token file.

**Taken:** the two rule weights — a 2px section rule over a 1px hairline — which
are the convention's own hierarchy; the zero-radius square page; and the dense
print cadence (buttons 16×8 and a 32px control against Warm Editorial's 18×10
and 36px).

**Deliberately not taken:**

- **The pink paper ground** — a palette concern. This style works under every
  registered palette and re-inks with whatever the palette provides.
- **The specific typeface** — the record names the shipped `slab` pairing, which
  the story assigned, and re-types headlines only (a display serif is unreadable
  as UI body text).

**Not claimed:** no contrast ratio. The base column below is Motir's own (the
`[data-style='warm-editorial']` block), and a ratio about this style is measured
by the style × palette × mode pass.

## The elements

### 1 · Square sketch — silhouette

Every generic radius step (`xs` through `xl`) and every semantic radius role —
button, input, card, modal, badge, control, keyboard hint — is `0px`.
**`--radius-pill` is NOT overridden** and keeps `9999px`, so genuinely circular
affordances (avatars, status dots, the spinner) stay round while status chips,
which read the badge role, become rectangles.

### 2 · Rule ink — stroke

Every rule and border colour is the active palette's ink: `var(--el-border)` or
a `color-mix()` over a palette element role. The token block sets no colour and
no font token; switching palette re-inks the rules, switching style changes no
hue.

### 3 · Flat page — elevation

`--shadow-flat`, `--shadow-subtle`, `--shadow-card`, `--shadow-elevated`,
`--shadow-modal` and `--shadow-hero-mockup` are all `none`. Separation is the
two rule weights plus whitespace. This is where the style lands beside Swiss /
Minimal-Flat, which also removes every shadow; the difference is that a 2px
section rule and a 1px column rule carry the structure, where Swiss draws one
hairline everywhere.

### 4 · Heavy section rule — the one component-variant override

Every framed surface — outline buttons, Card, Input, Modal, Pill, Popover, table
frames, dropdown panels — takes a **2px** border instead of 1px, through one
style-scoped rule:

```css
@scope ([data-style='editorial-print']) to ([data-style]) {
  .border {
    border-width: 2px;
  }
}
```

It cannot ride the token block: every primitive draws its edge with Tailwind's
1px `.border` utility, so border width has no base token. The shipped precedent
is [`docs/styles/neo-brutalism.md`](./neo-brutalism.md), which ships the same
mechanism for the same reason ("every primitive draws a 1px Tailwind `.border`
coloured by `--el-border*`, so a token swap alone cannot reach border WIDTH"). It
sets no colour and applies only while this style is active.

### 5 · Column rule — the hairline weight

A **1px** vertical rule in the palette's border ink separates adjacent columns
and the sidebar from its content. It is delivered by what already ships: the
primitives' directional dividers (`border-r`, `border-l`, `divide-x`) are
different utilities from `.border`, so the override in element 4 does not reach
them and they stay 1px. Drawn on every column but the first; not drawn in a
single-column layout; never a shadow. No new hook is added.

### 6 · Dense rhythm — density

| token                             | warm-editorial base | Editorial Print                                                          |
| --------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `--spacing-btn-x` / `-y`          | 18px / 10px         | 16px / 8px                                                               |
| `--spacing-btn-x-sm` / `-y-sm`    | 12px / 8px          | 10px / 6px                                                               |
| `--spacing-input-x` / `-y`        | 16px / 12px         | 14px / 10px                                                              |
| `--spacing-card-padding`          | 24px                | 24px (kept: a column keeps a readable measure)                           |
| `--spacing-control-x` / `-y`      | 10px / 6px          | 8px / 4px                                                                |
| `--spacing-chip-x` / `-y`         | 10px / 2px          | 8px / 2px                                                                |
| `--spacing-icon-btn`              | 4px                 | 2px                                                                      |
| `--spacing-kbd-x` / `-y`          | 6px / 2px           | 6px / 2px                                                                |
| `--spacing-tooltip-x` / `-y`      | 8px / 4px           | 8px / 4px                                                                |
| `--spacing-rail-inset`            | 0px                 | 0px — not declared; the rail stays flush, only 3D / Immersive floats one |
| `--height-btn-sm` / `-md` / `-lg` | 32 / 40 / 48px      | 28 / 36 / 44px                                                           |
| `--height-input`                  | 44px                | 40px                                                                     |
| `--height-control`                | 36px                | 32px                                                                     |

The generic spacing scale (`--spacing-xxs` … `--spacing-hero`) is not moved.
Tighter than Warm Editorial where the rhythm is read: buttons 16×8 against
18×10, control height 32px against 36px, input height 40px against 44px.

**Derived steps**, as round(base × step ÷ reference px) with the reference px of
`tests/theme/densityIntegration.test.ts`:

| base                     | ref px | here | step → resolved                              |
| ------------------------ | ------ | ---- | -------------------------------------------- |
| `--spacing-card-padding` | 24     | 24px | 16 → 16, 12 → 12, 8 → 8, 4 → 4               |
| `--spacing-control-x`    | 10     | 8px  | 16 → 13, 12 → 10, 8 → 6, 6 → 5, 4 → 3, 2 → 2 |
| `--spacing-control-y`    | 6      | 4px  | 8 → 5, 4 → 3, 2 → 1                          |
| `--spacing-chip-x`       | 10     | 8px  | 8 → 6, 6 → 5, 4 → 3, 2 → 2                   |
| `--height-control`       | 36     | 32px | 28 → 25, 32 → 28, 40 → 36, 48 → 43           |

Every step is a positive whole pixel; the smallest is `--spacing-control-y-2` at
4 × 2 ÷ 6 = 1.33 → 1px.

**The rail.** 32 + 20 = 52px collapsed column, a 35px content box (52 − 8 − 8 −

1. for a 32px control: the same 3px slack the shipped styles keep.

### 7 · Slab pairing — typography

`defaultTypeId: 'slab'` — a registered `TypeId` (Roboto Slab headlines over an
Inter body). The type is the independent `data-type` axis: the block sets no font
token, a pinned type wins, and nothing is loaded for this style.

### 8 · Print hero AI control

Inside `@scope ([data-style='editorial-print']) to ([data-style])`, written only
through the seam the components read:

- **Pill** — `--plan-hero-fill: none`, `background-color: var(--el-text)` and
  `color: var(--el-page-bg)`: a solid ink block with a reversed-out
  paper-coloured label, the way a masthead block prints.
- **Orb** — keeps its circle and takes a flat print gradient that **keeps the
  guarded first stop**: the glyph-colour mix through `--orb-lit-mix` at 33% / 27%,
  the accent body to 56%, the palette ink at the rim. The mark is the palette's
  accent ink, and `tests/theme/orb-glyph-contrast.test.ts` holds every palette ×
  theme to that first stop, so the print ink comes in only at the outer stop.
  **`--orb-lit-mix` must not be redeclared** in the style's rules.
- **Both** — `--plan-hero-shadow: none`, `--plan-orb-shadow: none`, and a 2px
  frame in `var(--el-border)`.

```css
@scope ([data-style='editorial-print']) to ([data-style]) {
  [data-surface='ai-cta'] {
    --plan-hero-shadow: none;
    --plan-orb-shadow: none;
    border: 2px solid var(--el-border);
  }
}
@scope ([data-style='editorial-print']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    --plan-hero-fill: none;
    background-color: var(--el-text);
    color: var(--el-page-bg);
  }
}
@scope ([data-style='editorial-print']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='orb'] {
    --plan-orb-fill: radial-gradient(
      circle at 33% 27%,
      color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent)),
      var(--el-accent) 56%,
      var(--el-text)
    );
  }
}
```

A fill is written only as its custom property and a shadow only as its custom
property — never a literal `background-image` or `box-shadow` — because both
components declare those two properties inline and an inline declaration beats
every stylesheet rule. No `animation` appears.

### 9 · Focus ring

`--focus-ring-width: 3px`, `--focus-ring-offset: 2px` (base 2px / 2px). A 2px ring
is exactly the weight of every section rule, so it would sit in the ruling; 3px
is the smallest width that reads as focus. Shown only on `:focus-visible`, never
suppressed — with no shadow anywhere, the ring is the only focus affordance.

## The token block

```css
[data-style='editorial-print'] {
  --radius-xs: 0px;
  --radius-sm: 0px;
  --radius-md: 0px;
  --radius-lg: 0px;
  --radius-xl: 0px;
  --radius-btn: 0px;
  --radius-input: 0px;
  --radius-card: 0px;
  --radius-modal: 0px;
  --radius-badge: 0px;
  --radius-control: 0px;
  --radius-kbd: 0px;
  --shadow-flat: none;
  --shadow-subtle: none;
  --shadow-card: none;
  --shadow-elevated: none;
  --shadow-modal: none;
  --shadow-hero-mockup: none;
  --spacing-btn-x: 16px;
  --spacing-btn-y: 8px;
  --spacing-btn-x-sm: 10px;
  --spacing-btn-y-sm: 6px;
  --spacing-input-x: 14px;
  --spacing-input-y: 10px;
  --spacing-card-padding: 24px;
  --spacing-control-x: 8px;
  --spacing-control-y: 4px;
  --spacing-icon-btn: 2px;
  --spacing-chip-x: 8px;
  --spacing-chip-y: 2px;
  --spacing-kbd-x: 6px;
  --spacing-kbd-y: 2px;
  --spacing-tooltip-x: 8px;
  --spacing-tooltip-y: 4px;
  --height-btn-sm: 28px;
  --height-btn-md: 36px;
  --height-btn-lg: 44px;
  --height-input: 40px;
  --height-control: 32px;
  --transition-duration: 90ms;
  --transition-fast: 70ms;
  --transition-slow: 140ms;
  --hover-scale: 1;
  --active-scale: 1;
  --focus-ring-width: 3px;
  --focus-ring-offset: 2px;
}
```

## Per-surface treatment

| surface         | ground (ink on it)                                                     | rule                                                | elevation | structure carried by              |
| --------------- | ---------------------------------------------------------------------- | --------------------------------------------------- | --------- | --------------------------------- |
| canvas          | the palette's page ground (`--el-text`)                                | —                                                   | none      | whitespace; no texture, no wash   |
| card            | `--el-surface` (`--el-text`)                                           | 2px `--el-border`                                   | none      | the section rule                  |
| popover         | `--el-surface` (`--el-text`)                                           | 2px `--el-border`                                   | none      | its rule, not lift                |
| modal           | `--el-surface` (`--el-text`)                                           | 2px `--el-border`                                   | none      | the heavy rule (no scrim shadow)  |
| input           | the primitive's ground (`--el-text`)                                   | 2px `--el-border`, 40px tall                        | none      | the rule; focus is element 9      |
| sidebar         | the palette's chrome ground                                            | 1px column rule to the content                      | none      | the column rule, flush at inset 0 |
| hero AI control | pill `--el-text` (`--el-page-bg`); orb the accent (`--el-accent-text`) | 2px `--el-border`                                   | none      | element 8                         |
| table / list    | the palette's surface                                                  | 2px section rule above the header, 1px column rules | none      | the two rule weights              |

Every ground and ink is an opaque palette element role, so text sits on what the
palette already tuned. The claim is closed by the style × palette × mode contrast
pass, and **a failing pair is fixed in the style, never in the palette**.

## States

- **Default / populated** — square, ruled and flat, headlines in `slab`; the
  style re-shapes chrome, cards, controls and the hero control and changes no hue.
- **Focus-visible** — the 3px ring at a 2px offset on every focusable control,
  visible against its surface under every palette and mode.
- **Hover and active** — no geometry changes: `--hover-scale: 1`,
  `--active-scale: 1`, transitions 90ms (fast 70ms, slow 140ms). A print page does
  not squish.
- **Disabled** — the primitives' own dimming on square, ruled geometry; the style
  adds no lift, shadow or border change, and the contrast pass records the
  disabled ground rather than this record assuming it.
- **Loading** — skeletons and spinners on the flat page; no style-specific
  shimmer.
- **Empty** — a flat ruled panel: the palette's surface, the 2px rule, zero
  radius, no illustration or tint.
- **Error** — the palette's error roles; the style contributes geometry only.
- **Style switch, both directions** — no cross-fade, no re-tint; leaving restores
  the other style's values, because this style overrides values and adds no
  member to the scale.
- **Unknown stored or URL style id** — falls back to `warm-editorial` through
  `resolveStyle`, the existing behaviour.
- **Style × palette × mode** — with no type pinned the style applies `slab`;
  a pinned type wins. Every palette re-inks the rules in both modes with no shape
  change, and the AA measurement of the surfaces above is taken per triple.

**No `@scope` material layer** ships beyond the hero control: the structure is
the token block plus the one `.border` override, and a material for paper would
contradict the flat page.

## Accessibility

- The focus ring (3px / 2px) must be visible against its surface on every palette
  and mode; it is the only focus affordance.
- Hit targets: the 28px small button and the 40px input are the values to check
  against the primitives' own hit area; neither is assumed safe here. Both stay
  above the 24px minimum target size.
- No ratio is claimed: colour is untouched, so the palette's pairs hold, and the
  reversed-out pill (`--el-page-bg` on `--el-text`) is measured by the contrast
  pass.
