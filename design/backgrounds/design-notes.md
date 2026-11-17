# Backgrounds — design notes

**Design system.** Files read: `package.json` (depends on `@motir/design-system`
`workspace:*`) and `app/globals.css` (`@import '@motir/design-system/theme.css'`).
Verdict: **on Motir Design**, installed version **0.23.0** (the workspace package).
The app's axes are the signed-in user's (`app/layout.tsx` writes `data-style` /
`data-palette` / `data-type` from the applied appearance); this area shows every
style, so the board wears the defaults (Warm Editorial · Motir · Motir type) and each
tile carries its own `data-appearance-scope` with its style, `data-palette="motir"`
and the style's default type. The mock is built with `renderMock` from
`@motir/design-system/mock` (`boardWidth: 'full'`) from the package's own `Card`
and `Button`.

Area index:

| Surface                                                                                               | Mock                                             | Card        |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------- |
| The background catalogue: Wave and Topography under every style, and the five style-fixed backgrounds | [`backgrounds.mock.html`](backgrounds.mock.html) | MOTIR-11602 |

## The background catalogue (MOTIR-11602)

The story (MOTIR-11600) puts seven backgrounds in `@motir/design-system`, chosen per
page area (landing, login, hero). Two follow the style — the **Wave** and
**Topography** — and are designed here for every registered style. Five follow only
palette and mode — **Aurora, Cyclic CA, Brian's Brain, Day & Night, Rule 110** — and
are already drawn by the package (MOTIR-11604, MOTIR-11616); the mock runs those
shipped drawers.

**The mock shows still frames, and that is deliberate.** Motir's design card frames a mock with
`sandbox=""`, which runs no script, so a background drawn on a `<canvas>` by JavaScript shows nothing
there. Every background in this mock is therefore a still frame of the shipped drawer, baked into an
image when the mock is generated (`bake.cjs`, reduced motion, 2x). The motion each background has is
described in words beside it; the build cards draw it live.

**There are 19 registered styles, not 22.** The card counts 22; `STYLE_REGISTRY` in
`packages/design-system/src/theme/styles.ts` holds 19 on `main` today, and the mock
covers every one of them. A style added later gets its row when it is registered.

### What every tile is made of

- **The page area** — a `div` with `bg-(--el-page-bg)`,
  `rounded-(--radius-card)` and `border border-(--el-border)`, carrying the tile's
  appearance scope. The canvas sits inside it exactly as the shipped
  `<Background>` does: `pointer-events-none absolute inset-0 -z-10`,
  `aria-hidden`.
- **The main content** — the package's `Card` (`--radius-card`,
  `--spacing-card-padding`, `bg-(--el-card)`, `border-(--el-border)`) holding
  "Sign in" (`--el-text`), "Your work, planned." (`--el-text-secondary`) and a
  `Button size="sm"` "Continue". It stands in for the sign-in card or the hero's
  idea box: the Wave gathers its lines around it; every other background fades to the
  page colour behind it.
- **Board chrome** — style names in `--el-text`; ids, rubric lines and tile
  captions in `--el-text-secondary` (AA on every surface).

### Inks — every colour is a token

A background reads its inks from the live theme through the package's
`readBackgroundColours` (`packages/design-system/src/backgrounds/tokens.ts`):

| Ink          | Token                     | Used for                                                              |
| ------------ | ------------------------- | --------------------------------------------------------------------- |
| page         | `--el-page-bg`            | the fill, the clear area, every "mixed into the page" tint            |
| surface      | `--el-surface`            | glass edges, highlights, chrome tops, Bento tiles                     |
| ink          | `--el-text`               | rules, pencil lines, scanline comets                                  |
| line         | `--el-border`             | hairlines (Tonal, Bento)                                              |
| band hue 1–3 | `--el-showcase-wave-1..3` | the colour band every Wave and Topography carries                     |
| **accent**   | `--el-showcase-decision`  | the decision squares and every line or mark the rubric calls "accent" |
| ground       | `--el-showcase-ground`    | hard offsets and drop shadows                                         |

**"Accent" is the decision colour, never `--el-accent`.** `--el-accent` is the CTA
fill, which the Motir palette (and others) set to the ink, so a Wave's decision
squares and Brian's Brain's firing cells drew black or grey against the real tokens.
The approved direction drew them in the hero's decision hue, which is
`--el-showcase-decision`. MOTIR-11616's shipped Brian's Brain and Day & Night were
corrected to it on the same branch.

### What every Wave keeps

The mark's shape (the deep dip first, the crest later), the lines **gathering around
the main content** (bunched toward its vertical centre), the **colour band** (the three
band hues flowing along the lines, or two band lines across the content), and the
**decision squares** (seven, seeded, sitting on the lines). Only shape, stroke, glow
and motion change per style. The Wave draws **no clear area**.

### What every Topography keeps

One seeded height field (value noise, four octaves) drifting slowly, contoured by
marching squares, and the shipped **clear area** behind the main content.

### The rubric — per style

Read as: **shape · stroke · glow · motion**. "Accent" is `--el-showcase-decision`.
Each line is what MOTIR-11606 (Wave) and MOTIR-11617 (Topography) turn into code and
into each style's DESIGN.md text. Warm Editorial, Neo-Brutalism, Swiss, Hand-Drawn and
Cybercore are the five the story's mock settled; they are carried over unchanged
beyond fitting the house mock format.

| Style                      | Wave                                                                                                                                                                                                                                                                                                                    | Topography                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warm-editorial`           | Shape: 46 fine lines bunched tight around the content. Stroke: 1px hairlines in the palette band, fading out away from the content, two band lines brighter across it. Glow: one faint blurred under-pass. Motion: slow drift.                                                                                          | Shape: 14 interpolated contour levels at a fine 7px grid. Stroke: 1px ink hairlines, every third level in the palette band. Glow: none. Motion: slow drift.                                                       |
| `soft-playful`             | Shape: 16 rounded lines with round caps and joins. Stroke: 2.6px in the palette band. Glow: a soft diffused blur under every line; decision squares are rounded 16px chips on a soft shadow. Motion: a gentle springy bob on top of the drift.                                                                          | Shape: 8 levels with every other terrace washed in a faint palette tint. Stroke: 2.6px round-capped lines cycling the three palette hues. Glow: none. Motion: drift with a slow bob.                              |
| `swiss-minimal-flat`       | Shape: 12 evenly spaced lines, no bunching. Stroke: 1px ink rules, one line in the accent at 1.5px with three 8px accent squares on it. Glow: none. Motion: slow drift.                                                                                                                                                 | Shape: 7 levels on an 8px grid. Stroke: 1px ink rules, one 1.5px accent level. Glow: none. Motion: slow drift.                                                                                                    |
| `neo-brutalism`            | Shape: 11 polylines with hard miter corners at a coarse knot spacing, three bands filled solid in the palette hues. Stroke: 3px ink with a 4px hard-offset shadow, every fourth line in the accent; 18px squares with hard offset blocks. Glow: none. Motion: steps twice a second.                                     | Shape: 5 un-interpolated levels on a coarse 22px grid, with solid hue blocks in the peaks, valleys and the mid band. Stroke: 3px square-capped ink on a 4px hard offset. Glow: none. Motion: steps once a second. |
| `glassmorphism`            | Shape: 13 lines; every third pair encloses a frosted ribbon of a palette hue. Stroke: 1px light glass edges over a faint ink underline, one accent line. Glow: the ribbons are blurred 8px; decision squares are frosted 18px tiles with a hairline edge. Motion: slow glide.                                           | Shape: 7 levels as stacked translucent terraces, each a step further into the palette hues, blurred 3px. Stroke: 1.2px light glass edge with a faint ink underline. Glow: the terrace blur. Motion: slow drift.   |
| `cybercore-y2k`            | Shape: the lines quantised to a 6px pixel grid, near lines with an RGB split (teal left, accent right). Stroke: filled pixels in the first hue, far lines fainter. Glow: a hue bloom in dark mode, scanlines over everything. Motion: pixel comets run along five lines.                                                | Shape: 9 levels as pixel cells on a 6px grid. Stroke: cells cycling the three hues, every third level solid. Glow: bloom on the solid levels in dark mode, scanlines. Motion: drift.                              |
| `aurora`                   | Shape: 24 lines bunched around the content, two band lines at 3px. Stroke: 1.4px in the palette band. Glow: every line lit from within (16px glow in dark mode with additive light, 10px in light); glowing rounded squares. Motion: very slow ambient drift.                                                           | Shape: 10 levels, alternate levels brighter. Stroke: 1.8px and 1px in the palette band. Glow: a 14px glow with additive light in dark mode, 8px in light. Motion: half-speed drift.                               |
| `3d-immersive`             | Shape: the lines split into three depth planes: far, middle, near. Stroke: 0.8px faint ink far, 1.4px band middle, 2.6px band near. Glow: the near plane seated on a deep 8px drop shadow; decision squares are small extruded cubes. Motion: the planes parallax at different speeds.                                  | Shape: 7 levels lifted one step higher each, so the map reads as raised relief. Stroke: levels thicken as they rise, alternating band and ink. Glow: a drop shadow under every level. Motion: drift.              |
| `neumorphism`              | Shape: 9 soft grooves moulded into the page. Stroke: 4px in the page colour with a light highlight top-left and a soft shade bottom-right, one band line through the middle. Glow: none; decision squares are raised pebbles with a dual soft shadow. Motion: slow drift.                                               | Shape: 6 levels as moulded grooves. Stroke: 4px page colour with highlight and shade pairs, one band level. Glow: none. Motion: drift.                                                                            |
| `hand-drawn-indie`         | Shape: 20 jittered pencil lines, each drawn twice. Stroke: 1.3px and 0.8px in ink, two lines in the accent; decision squares as sketched outlines. Glow: none. Motion: the line boils (re-jitters) eight times a second.                                                                                                | Shape: 10 levels drawn twice with jitter. Stroke: ink pencil, one accent level. Glow: none. Motion: boils eight times a second.                                                                                   |
| `retrofuturism`            | Shape: 14 lines held above a horizon, with a static receding accent grid floor and a horizon glow band below the content. Stroke: 1.4px in the palette band, two band lines at 2.6px. Glow: a neon glow in dark mode; chrome capsule decision marks. Motion: the lines drift slowly; the grid and horizon never move.   | Shape: 8 levels above the same static horizon and grid floor. Stroke: alternating 1.6px and 1px in the palette band. Glow: neon glow in dark mode. Motion: slow drift; the floor is static.                       |
| `dense-pro`                | Shape: 64 hairlines packed close around the content. Stroke: 0.6px ink, two band lines at 1px; 6px decision squares. Glow: none. Motion: drift.                                                                                                                                                                         | Shape: 22 levels on a fine 6px grid. Stroke: 0.6px ink, every fifth index level at 1px in the band. Glow: none. Motion: drift.                                                                                    |
| `high-contrast-accessible` | Shape: 8 well-spaced lines. Stroke: 2px ink, the two band lines 3px solid in the accent and the second hue; 14px squares with a 2px ink edge. Glow: none. Motion: none, it is one still frame.                                                                                                                          | Shape: 5 levels on a 12px grid. Stroke: 2px ink, one 3px accent index level. Glow: none. Motion: none, one still frame.                                                                                           |
| `tonal-elevated`           | Shape: 10 lines with the bands between them filled as tonal rungs, a step closer to the ink the nearer they are to the content, one band in the first hue. Stroke: 1px hairline on every line. Glow: each rung seated by a soft neutral shadow; tonal tiles for squares. Motion: calm drift.                            | Shape: 6 levels as flat tonal terraces, 4% further toward the ink per level. Stroke: 1px hairline on a soft shadow, one level in the first hue. Glow: none. Motion: drift.                                        |
| `claymorphism`             | Shape: 7 fat clay tubes with round caps, two in the palette hues and the rest neutral clay. Stroke: a tube about 4.5% of the box high with a light band on its top and a shade band on its bottom. Glow: one soft outer drop; decision marks are clay blobs. Motion: drift with a slow squish (the amplitude breathes). | Shape: 5 levels as clay tubes, two in hues. Stroke: 9px tubes with a top highlight. Glow: a soft drop under each tube. Motion: drift.                                                                             |
| `bento`                    | Shape: the box cut into rounded tiles (4 × 3) with even gutters; the lines run through every tile, one hero tile tinted with the first hue and its lines stronger. Stroke: 1px in the palette band, 1.6px in the hero tile. Glow: none. Motion: the tiles stay still, only the lines inside them drift.                 | Shape: contours clipped into the same tile grid, one hero tile tinted with the second hue. Stroke: ink hairlines, every third level and the hero tile in the band. Glow: none. Motion: drift inside still tiles.  |
| `editorial-print`          | Shape: 26 lines over vertical column rules. Stroke: 1px ink, two 2px ink section rules, one 1.5px accent line; 8px ink and accent squares. Glow: none. Motion: advances once a second, set rather than animated.                                                                                                        | Shape: 12 levels over column rules. Stroke: 1px ink, every fourth level a 2px ink rule, one accent level. Glow: none. Motion: advances once a second.                                                             |
| `art-deco`                 | Shape: a static sunburst fanning up from under the content, and every other line drawn as a double rule. Stroke: a 2px metal rule plus a 1px rule 4px below, band lines in the hues; decision marks are stepped-corner plates with an inner rule. Glow: none. Motion: mechanical, four steps a second.                  | Shape: 6 un-interpolated, machined levels on a 14px grid. Stroke: 2px metal plus a 1px inner rule 4px below, one level in the first hue. Glow: none. Motion: four steps a second.                                 |
| `memphis`                  | Shape: zigzag and squiggle lines over a static Bacterio texture of staggered hue dots and a diagonal hatch strip. Stroke: 2.5px ink on a 3px hard-offset accent block, the band lines 4px in the hues; squares stacked as ink, accent and hue blocks. Glow: none. Motion: fast drift.                                   | Shape: 5 levels with alternate terraces filled solid in the hues, over staggered ink dots. Stroke: 2.5px ink on a 3px hard-offset accent. Glow: none. Motion: drift.                                              |

**Reduced motion.** Under `prefers-reduced-motion` every background draws one still
frame (the shipped runtime's rule). High-Contrast / Accessible draws its still frame
whatever the preference, as its rubric's motion is "Still".

### The five style-fixed backgrounds

Shown once each in light and dark under Warm Editorial, with the clear area behind the
card. These are the shipped drawers, not proposals:

- **Aurora** — seven soft bands of light rolling across the box, colour cycling slowly
  through the band hues; stronger in dark mode.
- **Cyclic CA** — sixteen states on a ramp across the band hues; opens formed.
- **Brian's Brain** — firing cells in the decision colour, dying cells a faint decision
  colour; reseeds below 0.5% activity.
- **Day & Night** — islands in a faint decision colour; random flips keep the edges
  moving.
- **Rule 110** — the screen filled before the first frame, scrolling up; cells coloured
  by a band-hue ramp across the width.

### Access path

None on this card: the catalogue is the design of the drawings themselves. The doors
are designed by their own cards — the onboarding design step's picker (MOTIR-11615) and
the design picker on the motir.co marketing site (MOTIR-11603).

### Parts

Everything is the package's: `Card`, `Button`, the backgrounds runtime pieces
(`readBackgroundColours`, `drawClearArea`, the shipped drawers). The Wave and
Topography drawers are the proposal under review; no part is missing from
`@motir/design-system` and no product-local component is proposed.
