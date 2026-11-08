# Style — Tonal / Elevated (`data-style="tonal-elevated"`)

> Depth as an ordered ladder of surface tones. Its token block is the
> `[data-style='tonal-elevated']` block in
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css),
> with palette-derived material rules beside it, and it is registered in
> [`packages/design-system/src/theme/styles.ts`](../../packages/design-system/src/theme/styles.ts)
> among the eight styles that follow `retrofuturism`. This document is the
> style's design record; the mock is
> [`design/styles/tonal-elevated.mock.html`](../../design/styles/tonal-elevated.mock.html).

| field         | value                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id            | `tonal-elevated`                                                                                                                                                              |
| name          | `Tonal / Elevated`                                                                                                                                                            |
| tagline       | `Depth by tone — surfaces step up a quiet ladder, seated by soft shadows.`                                                                                                    |
| inspiration   | `Material Design 3's tonal elevation — each containment level a tone of the palette's own surface, a soft shadow seating it, so depth reads by tone first and shadow second.` |
| defaultTypeId | `motir`                                                                                                                                                                       |
| designDoc     | `docs/styles/tonal-elevated.md`                                                                                                                                               |

**Wrong moods:** flat, glassy, neon, brutal, hand-drawn, chromatic.

This is the STYLE (shape/feel) axis only. **Colour is the independent
`data-palette` axis**: every rung is the palette's own ink mixed into the
palette's own surface, so a palette swap re-tints the whole ladder and a style
swap changes no hue.

## Reference

Material Design 3's tone-based surfaces, on two pages:

- **The ladder ordering** — _Tone-based surface color in M3_
  (<https://m3.material.io/blog/tone-based-surface-color-m3>): surface
  containers run "from 'surface container lowest' with the lowest emphasis
  against the 'surface' role, to 'surface container highest' with the highest
  emphasis against the 'surface' role".
- **Tone carries elevation** — _Material Design 3 in Compose_
  (<https://developer.android.com/develop/ui/compose/designsystems/material3>):
  "Material 3 represents elevation mainly using tonal color overlays … in
  addition to shadows".

**Taken:** an ordered rung ladder, one rung per containment level; tone as the
primary depth cue with a soft shadow seating it; a nested surface never sharing
its container's rung.

**Deliberately not taken:** M3's own tone numbers, and its surface-tint hue.
This product's palette axis already tunes `--el-surface` for text contrast and
owns every hue, so a rung here is the palette's ink mixed into the palette's
surface — never a colour of the style's own, and never a large area tinted with
brand chroma.

**The nearest shipped precedent** is Neumorphism: its material layer derives its
shade by mixing over the palette, keeps every surface opaque at the palette's
`--el-surface`, keeps a hairline so structure never rests on the shadow alone,
and ships `prefers-contrast: more` / `forced-colors: active` fallbacks. Tonal /
Elevated takes that mechanism and swaps the paired soft shadow for a ladder of
tones.

## Feel-bearing dimensions

| key        | line                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| silhouette | Softened, machined geometry — 10px buttons and inputs, 14px cards, 20px modals, 8px rows and menu items, 6px keyboard hints; status chips stay pills.                                                                                           |
| stroke     | Quiet — the palette's 1px hairline stays on every surface so structure never rests on tone or shadow alone, and turns solid under a stronger contrast preference.                                                                               |
| elevation  | Depth as a ladder of tones: the page, then the palette's surface, then raised, overlay and hero rungs each 4% further toward the theme's ink, each seated by a soft neutral shadow that grows with the rung.                                    |
| surface    | Opaque tonal steps of the palette's own surface — a mix of the palette's ink into its surface, never a tint of brand chroma — so a palette swap re-tints every rung.                                                                            |
| density    | Comfortable, one notch calmer than the base: 38px controls, 12x7 row padding, 18x10 button padding and 24px card padding restated as the rhythm.                                                                                                |
| motion     | Calm, never springy — 180ms transitions, a 1% hover lift and a 0.98 press; tone never changes on hover, because tone is containment, not feedback.                                                                                              |
| typography | The motir pairing — Source Serif headlines over Inter body and JetBrains Mono meta, the product's own editorial voice on a quieter, layered stage.                                                                                              |
| components | Tonal cards, sidebar and top bar on the palette's surface, a popover one rung up, a modal two up, a recessed input on the page ground with an inset seat; the hero AI pill and orb sit on the top rung with an accent-led fill and a tonal rim. |

## Default type

`defaultTypeId: 'motir'` — a registered pairing in `TYPE_REGISTRY`. With no
type pinned the app renders it under this style; **a pinned type always
overrides it**. The block carries no font token.

## The ladder

Five rungs. Rung 0 is the page and is not painted — the shell's own page fill is
rung 0 — so this style owes no canvas rule. Rung 1 is the palette's own
surface. Rungs 2–4 move from that surface toward the theme's ink by a fixed
step.

| rung        | surface expression                                                          | surfaces                                                                        | shadow                 |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------- |
| 0 — base    | the palette's page ground, `var(--el-page-bg)`                              | the page; the recessed input                                                    | an inset seat, no drop |
| 1 — surface | `var(--el-surface)`                                                         | card, sidebar, top bar (`header`), **and every surface this map does not name** | `--shadow-card`        |
| 2 — raised  | `color-mix(in srgb, var(--el-text) var(--tonal-step-2), var(--el-surface))` | popover                                                                         | `--shadow-elevated`    |
| 3 — overlay | `color-mix(in srgb, var(--el-text) var(--tonal-step-3), var(--el-surface))` | modal                                                                           | `--shadow-modal`       |
| 4 — hero    | the top rung — see _The hero AI control_                                    | the plan-with-AI pill and the orb                                               | the hero shadow        |

**Why this direction.** `--el-text` is the theme's extreme ink — dark in light,
light in dark — so one formula darkens a surface in light and lightens it in
dark. The ladder reads the same in both themes without a per-theme rung list.
Rung 1 starts from the colour the palette tuned its inks against, and each
further rung spends a little of that margin to buy separation.

**Nested containment.** A popover over a card, or a card inside a modal, sits at
least one rung above its container.

**Totality by rule, not by list.** The surface population grows, so the map
names the members it assigns and every other emitted `data-surface` member
resolves to rung 1. The default rule is written with `:where()` so it carries no
specificity and every named rung overrides it; it excludes the page specimen
(`page`), the modal scrim (`overlay`) — painting a scrim opaque would hide the
page behind every dialog — and the hero controls (`[data-ai-cta]`), whose fill
travels on the seam.

## Token values

Shape and feel only. The base column is the Tier-0 `@theme` block of
`packages/design-system/theme.css` (mirrored by its
`[data-style='warm-editorial']` block).

| token                                                  | base                  | Tonal / Elevated                                                                                       |
| ------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------ |
| `--radius-xs` / `-sm` / `-md` / `-lg` / `-xl`          | 4 / 6 / 8 / 12 / 16px | 4 / 6 / 10 / 14 / 18px                                                                                 |
| `--radius-btn` / `--radius-input`                      | 8px / 8px             | 10px / 10px                                                                                            |
| `--radius-card` / `--radius-modal`                     | 12px / 12px           | 14px / 20px                                                                                            |
| `--radius-control` / `--radius-kbd`                    | 6px / 4px             | 8px / 6px                                                                                              |
| `--radius-badge`                                       | 9999px                | 9999px — the pill base, restated (the shape-swap lint requires every block to declare all seven roles) |
| `--spacing-btn-x` / `--spacing-btn-y`                  | 18px / 10px           | 18px / 10px (restated)                                                                                 |
| `--spacing-card-padding`                               | 24px                  | 24px (restated)                                                                                        |
| `--spacing-control-x` / `--spacing-control-y`          | 10px / 6px            | 12px / 7px                                                                                             |
| `--height-control`                                     | 36px                  | 38px                                                                                                   |
| `--transition-duration` / `--transition-slow`          | 150ms / 250ms         | 180ms / 260ms                                                                                          |
| `--hover-scale` / `--active-scale`                     | 1 / 0.98              | 1.01 / 0.98                                                                                            |
| `--shadow-*` (five roles)                              | the base shadows      | the light recipes below                                                                                |
| `--tonal-step-2` / `--tonal-step-3` / `--tonal-step-4` | —                     | 4% / 6% / 12%                                                                                          |

The three restated base values are deliberate no-ops: they write the rhythm down
where a reader of the block looks for it. The three step scalars are the only
new names, palette-agnostic percentages consumed by the material rules.

**The shadow recipes.** Soft, neutral and growing with the rung, carried as
neutral shadow ink in the token block as every shipped block carries its own —
a shadow's ink is not a palette hue. In dark, tone carries the separation and
the shadow only seats the edge, so the dark block raises the ink's alpha and
shrinks the spread. The dark block names both axes — the compound
`[data-style][data-theme]` arm Neumorphism uses, plus a descendant arm so a
scoped preview (the Appearance pane's vignette) under a dark ancestor gets it
too — and it is not a bare token block, so the colour-free block check does not
read it; it sets neutral rgba only.

```css
[data-style='tonal-elevated'] {
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 18px;
  --radius-btn: 10px;
  --radius-input: 10px;
  --radius-card: 14px;
  --radius-modal: 20px;
  --radius-badge: 9999px;
  --radius-control: 8px;
  --radius-kbd: 6px;
  --spacing-btn-x: 18px;
  --spacing-btn-y: 10px;
  --spacing-card-padding: 24px;
  --spacing-control-x: 12px;
  --spacing-control-y: 7px;
  --height-control: 38px;
  --transition-duration: 180ms;
  --transition-slow: 260ms;
  --hover-scale: 1.01;
  --active-scale: 0.98;
  --shadow-subtle: 0 1px 2px rgba(20, 20, 30, 0.04);
  --shadow-card: 0 1px 2px rgba(20, 20, 30, 0.05), 0 2px 6px -2px rgba(20, 20, 30, 0.07);
  --shadow-elevated: 0 2px 4px rgba(20, 20, 30, 0.06), 0 10px 24px -12px rgba(20, 20, 30, 0.12);
  --shadow-modal: 0 4px 10px rgba(20, 20, 30, 0.08), 0 20px 48px -16px rgba(20, 20, 30, 0.2);
  --shadow-hero-mockup: 0 6px 14px rgba(20, 20, 30, 0.1), 0 26px 60px -18px rgba(20, 20, 30, 0.24);
  --tonal-step-2: 4%;
  --tonal-step-3: 6%;
  --tonal-step-4: 12%;
}
[data-theme='dark'] [data-style='tonal-elevated'],
[data-style='tonal-elevated'][data-theme='dark'] {
  --shadow-subtle: 0 1px 1px rgba(0, 0, 0, 0.3);
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.36), 0 1px 4px -1px rgba(0, 0, 0, 0.3);
  --shadow-elevated: 0 2px 4px rgba(0, 0, 0, 0.4), 0 6px 14px -8px rgba(0, 0, 0, 0.44);
  --shadow-modal: 0 3px 8px rgba(0, 0, 0, 0.44), 0 12px 28px -12px rgba(0, 0, 0, 0.5);
  --shadow-hero-mockup: 0 4px 10px rgba(0, 0, 0, 0.46), 0 16px 36px -14px rgba(0, 0, 0, 0.56);
}
```

**What the block must not set, and why.** No colour token and no font token —
the axis contract the registry suite enforces inside every bare `[data-style]`
block. Not `--width-rail-chrome` — one value across every style, or the
collapsed rail's width stops being derived from one number. Not any of the 21
derived density steps — declared once, in the shared rule. Not
`--spacing-rail-inset` — already 0px at the base, and only a floating rail
moves it, so the rail stays flush (`tests/theme/immersiveShellChrome.test.ts`).

### Derived density steps

Every base is a whole pixel of at least 2px, and against
`tests/theme/densityIntegration.test.ts`'s reference px and step lists every
step resolves to a positive whole pixel:

| base token               | ref px | base here | step → resolved                               |
| ------------------------ | ------ | --------- | --------------------------------------------- |
| `--spacing-card-padding` | 24     | 24px      | 16 → 16, 12 → 12, 8 → 8, 4 → 4                |
| `--spacing-control-x`    | 10     | 12px      | 16 → 19, 12 → 14, 8 → 10, 6 → 7, 4 → 5, 2 → 2 |
| `--spacing-control-y`    | 6      | 7px       | 8 → 9, 4 → 5, 2 → 2                           |
| `--spacing-chip-x`       | 10     | 10px      | 8 → 8, 6 → 6, 4 → 4, 2 → 2                    |
| `--height-control`       | 36     | 38px      | 28 → 30, 32 → 34, 40 → 42, 48 → 51            |

**The rail.** 38 + 20 = 58px collapsed column, a 41px content box (58 − 8 − 8 −

1. for a 38px control: the same 3px slack the shipped styles have
   (`tests/theme/railTracksControlHeight.test.ts`).

## The material rules

**The contract.** One rule per `@scope ([data-style='tonal-elevated']) to
([data-style])` block — the shape the registry suite reads. Every painted colour
is a palette token, a single two-operand `color-mix()` over two of them, or
`currentColor`; no hex literal anywhere; every mix written as
`color-mix(in srgb, <token> <p>, <token>)`, the form `flattenColorMix`
(`tests/theme/colorMetrics.ts`) folds once its tokens resolve.

```css
@scope ([data-style='tonal-elevated']) to ([data-style]) {
  :where([data-surface]:not([data-surface='page'], [data-surface='overlay'], [data-ai-cta])) {
    background-color: var(--el-surface);
    box-shadow: var(--shadow-card);
  }
}
@scope ([data-style='tonal-elevated']) to ([data-style]) {
  [data-surface='popover'] {
    background-color: color-mix(in srgb, var(--el-text) var(--tonal-step-2), var(--el-surface));
    box-shadow: var(--shadow-elevated);
  }
}
@scope ([data-style='tonal-elevated']) to ([data-style]) {
  [data-surface='modal'] {
    background-color: color-mix(in srgb, var(--el-text) var(--tonal-step-3), var(--el-surface));
    box-shadow: var(--shadow-modal);
  }
}
@scope ([data-style='tonal-elevated']) to ([data-style]) {
  [data-surface='input'] {
    background-color: var(--el-page-bg);
    box-shadow: inset 0 1px 2px color-mix(in srgb, var(--el-text) 10%, transparent);
  }
}
@scope ([data-style='tonal-elevated']) to ([data-style]) {
  [data-surface='ai-cta'] {
    border: 1px solid color-mix(in srgb, var(--el-text) var(--tonal-step-4), var(--el-accent));
    --plan-hero-shadow:
      0 6px 14px -4px color-mix(in srgb, var(--el-accent) 30%, transparent),
      0 22px 44px -18px color-mix(in srgb, var(--el-accent) 40%, transparent);
    --plan-orb-shadow:
      0 6px 14px -4px color-mix(in srgb, var(--el-accent) 30%, transparent),
      0 22px 44px -18px color-mix(in srgb, var(--el-accent) 40%, transparent);
  }
}
@scope ([data-style='tonal-elevated']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='pill'] {
    --plan-hero-fill: linear-gradient(
      180deg,
      color-mix(in srgb, var(--el-accent) 92%, var(--el-surface)),
      var(--el-accent)
    );
  }
}
@scope ([data-style='tonal-elevated']) to ([data-style]) {
  [data-surface='ai-cta'][data-ai-cta='orb'] {
    --plan-orb-fill: radial-gradient(
      circle at 33% 27%,
      color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent)),
      var(--el-accent) 60%
    );
  }
}
@media (prefers-contrast: more) {
  @scope ([data-style='tonal-elevated']) to ([data-style]) {
    [data-surface='card'],
    [data-surface='sidebar'],
    [data-surface='header'],
    [data-surface='popover'],
    [data-surface='modal'],
    [data-surface='input'] {
      background-color: var(--el-surface);
      border-color: var(--el-border-strong);
    }
  }
}
@media (forced-colors: active) {
  @scope ([data-style='tonal-elevated']) to ([data-style]) {
    [data-surface='card'],
    [data-surface='sidebar'],
    [data-surface='header'],
    [data-surface='popover'],
    [data-surface='modal'],
    [data-surface='input'] {
      background-color: var(--el-surface);
      border-color: var(--el-border-strong);
      box-shadow: none;
    }
  }
}
```

**The recessed input** is rung 0: the page ground, seated by a 1px inset shade
mixed from the theme's ink, so it reads pressed into its container rather than
lifted.

**The contrast fallback.** Under `prefers-contrast: more` and
`forced-colors: active` every painted rung collapses to `--el-surface` and the
hairline turns solid (`--el-border-strong`); under forced colours the shadow is
removed too — the fallback shape Neumorphism's material layer carries. Each
fallback lists the named surfaces it collapses in one rule, inside one `@scope`.

## The hero AI control

`tests/theme/aiCtaStyleSeam.test.ts` derives the styles owing a treatment from
`STYLE_IDS`, so this style owes the pill and the orb a rule, written through the
seam variables (the components declare `background-image` and `box-shadow`
inline). Rung 4 is the top of the ladder, and the hero wears it as **its rim and
its shadow, not as its fill**: the label and the mark are `--el-accent-text`,
which the palette tunes against `--el-accent`, so a tonal grey fill under them
would trade the product's headline control's legibility for a literal reading of
the ladder.

- **Rim** — `1px solid color-mix(in srgb, var(--el-text) var(--tonal-step-4), var(--el-accent))`:
  the rung-4 step taken over the accent.
- **Pill fill** — a vertical tonal step on the accent:
  `color-mix(in srgb, var(--el-accent) 92%, var(--el-surface))` to
  `var(--el-accent)`. Every stop stays at or above 92% accent, shallower than
  the component's own fallback (far stop 86% accent, where the label measured
  5.97:1 light and 4.64:1 dark).
- **Orb fill** — the shipped lit-sphere crown
  (`color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent))`
  at 33% / 27%) settling to the accent by 60%, with no highlight-tinted rim.
  `--orb-lit-mix` is read, never re-declared.
- **Shadow** — the top rung's seat, tinted by the accent so it stays visible in
  dark: `0 6px 14px -4px` at 30% accent plus `0 22px 44px -18px` at 40% accent.
  The seam guard requires a hero shadow to be palette-derived, which is why it
  is written over `--el-accent` here rather than as `var(--shadow-hero-mockup)`.
- **No animation** is added.

## The ink rule per rung

Rung 0 may carry any ink, the captions role included. Rungs 1–4 carry `--el-text`
and never the captions role: `--el-text-muted` is the muted / captions ink each
palette tunes against the page and the card, which is no evidence it survives on
a repainted rung (CLAUDE.md measures it at 4.12–4.34:1 on `--el-surface`,
`--el-muted` and `--el-surface-soft` in light). The AA floor is measured across
every palette in both themes by the story's contrast gate, not asserted here; a
rung that fails moves down one step.

**Observed in the mock, for the build to settle:** a `Pill` whose fill is
`--el-surface` loses its fill on a rung-1 card, because the card now wears the
same tone (the vignette's status chips). The chip's text stays `--el-text`
and legible. The record adds no chip hook to fix it — no new surface hook is
introduced — and the build card decides, with the render in hand, whether the
chip's existing tokens already separate it enough.

## No canvas

This style paints no page canvas and the shell keeps its own page fill, so no
`body` / `[data-app-shell]` pairing is owed. Consequence for the build: the
exact flat-canvas array in `tests/theme/styleShellCanvas.test.ts` is derived
from the stylesheet's style ids minus those with a canvas rule, so the id
`tonal-elevated` joins that array, in sorted position, in the same pull request
that adds the token block.

## States

- **Rungs 0–4** as mapped above, in light and dark, under every registered
  palette: the mix inverts with the ink, so no rung list is authored per theme;
  only the shadow ink is rebalanced.
- **Palette swap** — every rung re-tints; no radius, spacing or shadow moves.
- **Hover and press** — 180ms transitions, 1.01 hover, 0.98 press; no rung
  changes on hover.
- **Focus-visible** — the base ring, 2px at a 2px offset, unchanged.
- **Reduced motion** — nothing new to gate: the style animates nothing of its
  own.
- **`prefers-contrast: more` / `forced-colors: active`** — the fallback above.
- **Empty, loading and error** — the style paints none of them and adds no
  per-state rung; a fourth tone for an empty state would make the ladder
  unlearnable.
- **A surface member added later** — resolves to rung 1 by the default rule.
- **Unknown style id** — `resolveStyle` still resolves to `warm-editorial`; this
  style adds no resolver branch.
