# Style — 3D / Immersive (`data-style="3d-immersive"`)

> **DEFERRED follow-up (post-v1), EXPERIMENTAL.** A complete design **direction**
> (shape/feel axis), authored in the Motir `DESIGN.md` shape so the onboarding
> **design wizard** can emit it for a user's product: pick "3D / Immersive" and
> this is the design language the build agent reads. Shipped in `motir-core` as
> the `[data-style='3d-immersive']` block in
> [`app/globals.css`](../../app/globals.css), the registry entry in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts), and the pointer-parallax
> engine [`components/theme/ImmersiveTilt.tsx`](../../components/theme/ImmersiveTilt.tsx)
> — so the spec below is a real, running reference, not an aspiration.

**Tagline:** Spatial depth — surfaces are physical objects on layered planes that
tip toward you and parallax under the light.
**Inspiration:** Spatial / depth UI — visionOS layers, Stripe-era layered cards,
the standard "3D card" tilt (vanilla-tilt.js / react-parallax-tilt / Atropos).
**Wrong moods:** flat, austere, gridded, papery, hard-edged, static.

This is the STYLE (shape/feel) axis only — **colour is the independent
`data-palette` axis**. Every depth effect here is colour-free or palette-derived,
so a palette swap re-tints the atmosphere and leaves the geometry alone, and a
style swap leaves hues alone. See [`../DESIGN.md`](../DESIGN.md) for the two-axis
contract.

---

## 1. Visual theme & atmosphere

The whole UI reads as a **shallow 3D scene**: an immersive depth field behind the
content, with every panel a physical object floating above it and tipping toward
the cursor. Nothing is flat-on-the-page. The mood is tactile, spatial, alive —
the opposite of a flat document. Calm depth, not a gimmick: motion is gated,
hierarchy comes from _Z-distance_ (how far a surface floats) as much as from size
or colour.

The single most important rule of this direction, and the one a half-hearted
implementation gets wrong: **3D is layered parallax, not a tilting flat plane.**
A card whose contents are glued to its face and rotates as one rigid rectangle
reads as "flat-with-a-tilt." A _real_ 3D surface puts its contents on **separate
depth planes** that move relative to each other as it tips. That separation —
`perspective` + `transform-style: preserve-3d` + per-layer `translateZ` — is §6.

## 2. Colour

3D / Immersive sets **no hue** — it inherits whatever `data-palette` is active and
preserves its AA contrast by construction. The two places this direction paints
pixels are both **palette-derived**, never a raw hue:

- the **immersive background** (a `color-mix()` depth field over `--el-accent` /
  `--el-link` / `--el-text` — §6), and
- the **glare** specular sweep (a `color-mix()` over `--el-page-bg` — §6/§7).

A palette swap re-tints both; a style swap touches neither. (Shadows use a fixed
near-ink `rgba`, the same the base shadows do — a shadow is not a palette colour.)

## 3. Typography

Inherits the base editorial pairing (`defaultTypeId: 'motir'`) — the personality
is depth and light, not type. (Type is the independent `data-type` axis; this
direction sets no `--font-*`.) One caveat the depth imposes: text on a tilted /
`translateZ`-lifted plane sub-pixel-softens slightly — keep body copy **on the
card face** (Z 0), and lift only short, large headers/labels onto a forward plane
where the softening is invisible.

## 4. Component depth treatment (the plane ladder)

Every surface is assigned a **depth plane**. The ladder (nearest the viewer →
farthest) and the elevation each surface carries:

| Surface                                                      | Plane / treatment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Modal / dialog**                                           | Highest float — `--shadow-modal`; the page behind dims and recedes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Popover / dropdown / menu**                                | Floats on `--shadow-elevated` and **UNFOLDS in 3D on open** — the standard 3D-dropdown swing: `transform-origin: top` + `perspective` + `rotateX` (folded → flat). Hooked via the `Popover` `data-surface` + a `data-menu-surface` on the Combobox / MultiSelect / custom menus; reduced-motion-gated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Card — the reference 3D object**                           | Floats on `--shadow-card`. On tilt: the **header/title** rides a **front** plane (`translateZ ~42px`), the **footer** a nearer **back** plane (`~14px`), the **body stays on the face** (Z 0). A cursor-tracked **glare** sweeps the face.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Board card (kanban tile)**                                 | A small card — tips toward the cursor, lifts on hover.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Page panels** (work-item table, backlog, dashboard widget) | **Float, but do not tilt** — they're large; a full table tipping is disorienting and clips sticky headers. They carry the deep resting shadow only (see size-gating, §7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Shell chrome — the top bar and the rail**                  | **Two objects, two planes, and the ladder says which** (MOTIR-4252). The **rail** is a floating PANEL: inset from the frame on all four sides by `--spacing-rail-inset` so the immersive background reads around it, on `--radius-card` + `--shadow-card`, its shared right edge gone transparent. The **top bar** is the **LID** — no fill (the atmosphere runs under it), no border, and `--shadow-subtle` cast down onto the region below; it keeps full-bleed edges and square corners, because a bar with a radius and a margin is a second floating slab. `box-shadow` only, NEVER `position`: the host is already `sticky`, which is both the containing block an override would break and the stacking context that makes the lid's shadow paint. Design of record: `design/shell/3d-immersive-shell.mock.html`. |
| **Board column**                                             | A tall panel in an `overflow-x-auto` row (which clips its drop shadow + occludes between neighbours). Gets a **tighter, clip/occlusion-safe** float shadow (small horizontal bleed) + extra row gap + bottom room, so **each column floats as its own distinct card** — never one backing slab. Its cards tilt individually.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Button — a PHYSICAL key**                                  | NOT flat. A filled button (primary / danger) has visible **thickness** — a solid base edge in a darker shade of its own fill (`--el-accent-pressed` / a darkened `--el-danger`, palette-derived) — and on click **presses DOWN onto its base** (`translateY(3px)`, the base compresses). Secondary gets a subtle neutral base edge; ghost stays flat (the quiet button). A **square icon button** (the 3-dots trigger, a close ×, a toolbar toggle) is a key too, at the neutral base edge.                                                                                                                                                                                                                                                                                                                              |
| **Quiet control / row**                                      | **Flat at rest, but never inert** — a menu row, list row, sidebar nav link, inline text affordance and the ghost button carry no thickness (the surface they sit in is what floats), and **press 1px on click**. One pixel of travel is the whole treatment; it is what separates _quiet_ from _dead_.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Text field — RECESSED**                                    | The inverse of a key: pressed **INTO** the surface on a soft inset shadow, because you type into a well. Never raised — a text field that sticks up reads as a button. Generous rounded dimensional silhouette; `input` / `textarea` / `select` and the `Input` primitive's `[data-surface='input']` shell. Checkbox / radio / range / colour are chips, not wells, and are excluded.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Status pill / badge**                                      | Stays a flat pill on its parent's plane (a chip doesn't float). **An interactive pill that is an ACTION rather than a status — a hero CTA, a link to a manage surface — is a key and says so with `data-depth="key"`;** the radius alone cannot tell the two apart (§4a).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

The plane a surface sits on is the hierarchy: a modal is "closer" than a card,
which is "closer" than the table it sits in, which floats over the canvas.

### 4a. The ROLE decides the plane — a radius utility does not carry it

**This is the rule the first implementation of this direction got wrong**
(MOTIR-3522), and it is the one thing to hold on to when adding a surface. The
ladder above names **roles** — button, row, field, chip. The stylesheet can only
see **classes**. Those two do not line up, because a radius token is a _shape_
decision and every one of them is shared by families that want opposite planes:

| radius token       | worn by                                                                                             | wants            |
| ------------------ | --------------------------------------------------------------------------------------------------- | ---------------- |
| `--radius-badge`   | 3 hero action buttons **and** 9 filter / tag chips and segmented tabs                               | key **and** flat |
| `--radius-control` | ~63 square icon buttons **and** ~51 menu / option / full-width rows **and** inline text affordances | key **and** flat |
| `rounded-full`     | the Plan-with-AI orb **and** two Switch tracks, a colour swatch, an avatar, a tag remove-×          | key **and** flat |

So depth is **declared, not inferred**, through one attribute:

- **`data-depth="key"`** — this control is a physical key, whatever radius it wears.
- **`data-depth="flat"`** — this control takes no depth, whatever radius it wears.
- **absent** — a radius DEFAULT applies, chosen so the default is SAFE: the two
  button radii and the square icon-button shape (`.justify-center` on the control
  radius) are keys, and every other interactive class is quiet. A control that
  should be raised and is not looks understated; one raised that should not be
  looks broken, so the default errs quiet.

`role` overrides everything: `switch`, `radio`, `checkbox`, `menuitem` and
`option` are never keys.

**The default is a class-name binding, so something has to break when a new
control class appears.** `tests/theme/immersive-control-depth.test.ts` enumerates
the radius utilities the codebase actually emits on interactive tags and fails
when one is not classified here.

### 4b. The CLOSURE RULE — the ladder must classify EVERY surface class

**Every surface class the app renders is either assigned a plane above, or
listed below as deliberately flat with a named reason. A surface class absent
from this ladder is a spec defect, not a default.**

§4a is this rule one level down: it says a CONTROL's plane is declared rather
than inferred, and `tests/theme/immersive-control-depth.test.ts` fails when a new
radius utility appears unclassified. This is the same rule for SURFACES, and it
exists because the ladder without it had already failed three times in one shape
— a promise bound to an enumeration, with silence where the enumeration ends:

1. **MOTIR-3522** — the physical-key rule enumerated two compiled radius
   utilities, so 199 of 280 interactive controls stayed flat. Fixed for controls;
   §4a is that fix.
2. **MOTIR-4230** — the immersive background was painted on `body` alone, so the
   signed-in shell root — a surface outside that enumeration — covered it.
3. **MOTIR-4253** — the shell chrome was never enumerated at all, so the top bar
   and the rail rendered byte-identically to the default style's.

Each was patched where it was found. The mechanism survived all three, one level
up, over SURFACES — which is why the fourth instance was the largest continuous
region on every signed-in screen.

**The surfaces this app renders, and where each is classified.** The nine
`data-surface` values the codebase emits, plus the shell canvas and the
class-keyed panel surface. (The count is a reading of the table below, never the
rule — `tests/theme/immersive-surface-ladder.test.ts` derives the emitted
population and fails on any member with no row, so a stale number here is a typo
rather than a gap.)

| Surface class          | Hook                                                  | Where                                          |
| ---------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| Shell canvas           | `body`, `[data-app-shell]`                            | §6a — the immersive background                 |
| Top bar                | `[data-surface='header']`                             | §4 — shell chrome (the LID)                    |
| Rail                   | `[data-surface='sidebar']`                            | §4 — shell chrome (a floating PANEL)           |
| Modal / dialog         | `[data-surface='modal']`, `.rounded-(--radius-modal)` | §4 — highest float                             |
| Popover / menu         | `[data-surface='popover']`, `[data-menu-surface]`     | §4 — elevated float + the 3D unfold            |
| Card                   | `[data-surface='card']`, `[data-tilt]`                | §4 — the reference 3D object                   |
| Page panel             | `.rounded-\(--radius-card\)`                          | §4 — float, do not tilt (the global rule, §6a) |
| Board column           | the column in the `overflow-x-auto` row               | §4 — the clip-safe float                       |
| Text field             | `[data-surface='input']`                              | §4 — RECESSED                                  |
| Buttons / rows / pills | `data-depth`, the radius default                      | §4 + §4a                                       |
| Hero AI control        | `[data-surface='ai-cta']`, `data-depth="key"`         | §4 + §4a — a physical KEY (MOTIR-4743)         |

> **The hero AI control's row is a KEY whose depth this style already owns, and
> its `data-surface` hook is for MATERIAL rather than for a plane.** The "Plan
> with AI" pill and the floating M orb both carry `data-depth="key"` (MOTIR-3522),
> and this style gives them their thickness through `--plan-hero-shadow` /
> `--plan-orb-shadow` — a `var()` seam the components read, because an inline
> `box-shadow` beats every stylesheet rule. The material hook was added by
> MOTIR-4743 so the ten OTHER styles can give the control their own fill, border,
> glow and type (`design/ai-chat/design-notes.md` § _The STYLE MATRIX_); this
> style deliberately writes no rule against it. One would either lose to the same
> inline declaration or replace the key's base edge with a decorative fill,
> taking a control OFF the plane ladder while leaving it declared on it — a
> contradiction, not a restyle.

**Deliberately FLAT, with the reason — the half of the rule that makes it a rule
and not a longer list:**

| Surface class     | Hook                       | Why it takes no plane                                                                                                                                                                                                    |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Modal scrim**   | `[data-surface='overlay']` | A scrim is the absence of a surface, not one. Its job is to REMOVE the plane behind the modal (§4's modal row: _the page behind dims and recedes_); a plane of its own would put a floating sheet between the two.       |
| **Specimen page** | `[data-surface='page']`    | The `/tokens` specimen frame (`packages/design-system/src/specimen/TokensSpecimen.tsx`). It is a page ABOUT surfaces rather than one of them; floating the host would put a plane between the reader and what they read. |

**When you add a surface class**, add its row here in the same change — with a
plane, or with a reason. That is the whole rule: the ladder is not allowed to be
silent about a surface the app renders.

## 5. Layout & density

Roomy and immersive — depth wants air around each floating object so its shadow
can read. Generous control padding (`--spacing-btn 22/12`, `--spacing-card-padding
28px`, `--height-control 40px`) and generous dimensional radii (cards 20px,
modals 28px, buttons/inputs 14px) — soft, tactile tiles, never sharp.

## 6. Depth & Elevation — the core of this direction

Two halves: **static depth** (always on, even under reduced motion) and the
**3D interaction** (gated).

### 6a. Static depth — the float

- **The shadow ladder is deep and multi-layer.** Every elevation token is a
  specular top highlight + a tight contact shadow + a mid ambient + a wide, soft
  key light far below — so a surface reads as a physical object lifted off the
  canvas, not a card with a faint drop shadow. Scales `--shadow-subtle` →
  `--shadow-card` → `--shadow-elevated` → `--shadow-modal` → `--shadow-hero-mockup`.
- **Every floating surface carries a resting shadow.** Default cards have none in
  the base style; here every `[data-tilt]` tile gets `--shadow-card` at rest so it
  lifts off the canvas. Static — applies under reduced motion too.
- **The immersive background.** `body` wears a palette-derived depth field —
  soft `color-mix()` washes from `--el-accent` (top) and `--el-link` (corner) plus
  a centre vignette from `--el-text`, `background-attachment: fixed`. It gives
  _every_ page (even flat tables) atmosphere and a sense of space the floating
  panels sit within.

### 6b. The 3D interaction — layered parallax (the proper technique)

This is what separates real 3D from a flat-plane tilt, and it is the standard
vanilla-tilt / Atropos technique:

1. **Perspective + `preserve-3d`.** While a tile is active the engine applies
   `transform: perspective(900px) rotateX(var(--tilt-rx)) rotateY(var(--tilt-ry))`
   AND `transform-style: preserve-3d` — establishing a real 3D coordinate space so
   the tile's children render _in depth_, not flattened onto its face.
2. **Per-layer `translateZ` (the parallax).** The card's slots ride different
   planes — header on a **front** plane (`translateZ(42px)`), footer on a **back**
   plane (`translateZ(14px)`), body on the **face** (Z 0). As the card tips, the
   planes shift relative to each other: the title visibly floats _above_ the body.
   That inter-layer motion is the 3D read; without it you get the "halfway" look.
3. **Cursor-tracked glare.** A `radial-gradient` specular sweep (palette-derived,
   `color-mix` over `--el-page-bg`) follows the pointer across the face
   (`--tilt-glare-x/y`), fading in only while active — the light catching a
   tilted surface.
4. **The tip itself.** Rotation maxes at ~7° at the edges, flat at the centre, on
   a tight `perspective(900px)` for a tangible (not extreme) tip; a gentle scale /
   deeper shadow as it lifts; eases flat on leave.

## 7. Motion & accessibility

- **The engine.** [`ImmersiveTilt`](../../components/theme/ImmersiveTilt.tsx),
  mounted once in the shell: one delegated, rAF-coalesced `pointermove` listener
  maps the cursor over a `[data-tilt]` tile to a rotation + glare position
  (`lib/theme/tilt.ts`, pure + unit-tested) and writes per-tile CSS vars. No
  per-tile listeners.
- **Size-gating.** Only tile-sized surfaces (≤ `MAX_TILE_PX` 560 in either
  dimension) _tilt_; larger panels (tables, columns, backlog) **float without
  tilting** — tipping a full table would be disorienting and could clip sticky
  headers / portaled menus.
- **Reduced motion (the "gate carefully" caveat).** The tilt + parallax + glare
  are disabled in **both** the engine (it checks `prefers-reduced-motion`) and the
  CSS (the whole interaction block is inside `@media (prefers-reduced-motion:
no-preference)`). A reduced-motion user keeps the full _static_ depth (deep
  shadows, immersive background, floating panels) with zero movement.
- **Performance.** Depth is `box-shadow` (compositor-friendly); the interaction
  animates only `transform` (GPU). Idle for every other style.
- **Contrast.** No colour token changes, so the palette's AA holds. Body copy
  stays on the face (Z 0) to avoid tilt sub-pixel softening; only short headers
  lift.

## 8. Do's & Don'ts

**Do**

- Put content on **depth planes** — lift short headers/labels onto a forward
  plane; keep body copy on the face.
- Express hierarchy with **Z-distance** (how far a surface floats) + the shadow
  ladder, not just size.
- Keep the immersive background and glare **palette-derived** (`color-mix` over
  `--el-*`), never a raw hue.
- **Declare a control's plane with `data-depth` when the radius default gets it
  wrong** — a hero pill, an orb, a link that is really an action (§4a).

**Don't**

- ❌ Tilt a card as a **rigid flat plane** (no `preserve-3d`, no per-layer
  `translateZ`) — that is the "flat-design + 3D mix" failure this direction
  exists to avoid.
- ❌ Tilt **large panels** (tables, columns) — float them instead.
- ❌ Leave **buttons flat** — a 3D button has thickness and presses down; a flat
  button beside floating 3D cards is the inconsistency that reads as "half-3D".
- ❌ Leave the **shell CHROME** flat — a top bar and a rail byte-identical to
  the default style's, framing floating 3D cards, is the same half-3D failure as
  a flat button and it is the largest continuous region on the screen. The frame
  is roughly a quarter of every signed-in view; a style that spends none of it is
  a style you cannot tell apart from the default one (§4, §4b).
- ❌ Give a **tall panel in a clipped scroll row** the wide card shadow — it
  clips at the bottom and occludes between neighbours, reading as one backing
  slab. Use a tighter shadow + gap (the board-column treatment, §4).
- ❌ Lift **body text / dense content** onto a Z-plane — it softens; only short
  headers/labels.
- ❌ Pin a hue in the background or glare — keep the colour axis disjoint.
- ❌ Infer a control's plane from its **radius utility**. Every radius token in
  this app is shared by families that want opposite planes, so a rule keyed on
  one raises switches, avatars and filter chips (§4a).
- ❌ **RAISE a text field.** A well is the inverse of a key — inset, not lifted.
- ❌ Raise a **row inside an open menu**. The popover is the thing that floats;
  a raised row inside it reads as debris.

---

## Implementation map (the running reference)

| Piece                                                                                                               | Where                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Token block (radius / shadow ladder / density / motion)                                                             | `[data-style='3d-immersive']` in [`app/globals.css`](../../app/globals.css)                                                                                                                                                                                                                                                                  |
| Immersive background + resting float + tilt/parallax/glare CSS                                                      | same file, the `[data-style='3d-immersive'] body` + `[data-tilt]` rules                                                                                                                                                                                                                                                                      |
| **Every panel floats** (systematic, all ~85 panel surfaces app-wide)                                                | a GLOBAL rule on the card-radius utility — `[data-style='3d-immersive'] .rounded-\(--radius-card\)` (and `…-modal`) gets the deep float shadow, so EVERY hand-rolled `rounded-(--radius-card)` panel floats, not just the `<Card>` primitive (the neo-brutalism-`.border` approach). No screen is left flat; new panels float automatically. |
| Pointer-parallax engine (cursor → rotation + glare vars, gated)                                                     | [`components/theme/ImmersiveTilt.tsx`](../../components/theme/ImmersiveTilt.tsx) + [`lib/theme/tilt.ts`](../../lib/theme/tilt.ts)                                                                                                                                                                                                            |
| Depth-plane hooks                                                                                                   | `data-tilt` (the floating tile) + `data-tilt-layer="front                                                                                                                                                                                                                                                                                    | back"`(the parallax slots) — emitted by`Card`, `BoardCard`, and the page panels |
| Control depth — the key / quiet / flat / recessed sets + the `data-depth` hook                                      | the `3D / Immersive — CONTROL DEPTH` block in [`packages/design-system/theme.css`](../../packages/design-system/theme.css), guarded by `tests/theme/immersive-control-depth.test.ts`                                                                                                                                                         |
| Shell chrome — the rail's inset float + the top bar's lid, and their `prefers-contrast` / `forced-colors` fallbacks | the `[data-surface='sidebar']` / `[data-surface='header']` rules in [`packages/design-system/theme.css`](../../packages/design-system/theme.css); drawn in `design/shell/3d-immersive-shell.mock.html`                                                                                                                                       |
| Registry entry (the rubric dimensions)                                                                              | `STYLE_REGISTRY['3d-immersive']` in [`lib/theme/styles.ts`](../../lib/theme/styles.ts)                                                                                                                                                                                                                                                       |

**How the wizard uses this.** The onboarding design step lets a user pick a design
direction; "3D / Immersive" maps to **this document** as the design language, and
to the `[data-style='3d-immersive']` implementation as the reference build. The
emitted product `DESIGN.md` carries §1–§8 above (atmosphere, colour approach,
type, component plane ladder, layout, depth & elevation, motion, do/don't) — the
same shape as Motir's own [`DESIGN.md`](../DESIGN.md), grounded in
[getdesign.md](https://getdesign.md) references for the palette/type axes it
composes with.

## Background: the Wave

The Wave (`@motir/design-system`, `wave` in the background registry) redraws per
style. Every style keeps the mark — the deep dip first and the crest later, the
lines gathering around the main content, the sliding band of the palette's wave
hues and the decision squares riding the lines — and changes only shape, stroke,
glow and motion. Under this style:

Shape: the lines split into three depth planes: far, middle, near. Stroke: 0.8px faint ink far, 1.4px band middle, 2.6px band near. Glow: the near plane seated on a deep 8px drop shadow; decision squares are small extruded cubes. Motion: the planes parallax at different speeds.

Every ink is a token read off the live theme; "accent" is
`--el-showcase-decision`. Under reduced motion it holds one still frame. The
drawing is `packages/design-system/src/backgrounds/wave.ts` (MOTIR-11606), built
to the approved design in `design/backgrounds/` (MOTIR-11602).

## Background: Topography

Topography (`topography` in the background registry) is contour lines over a
slowly moving height map, redrawn per style. Every style keeps one seeded height
field drifting slowly, contoured by marching squares, and the feathered clear area
behind the main content. Under this style:

Shape: 7 levels lifted one step higher each, so the map reads as raised relief. Stroke: levels thicken as they rise, alternating band and ink. Glow: a drop shadow under every level. Motion: drift.

Every ink is a token read off the live theme; "accent" is
`--el-showcase-decision`. Under reduced motion it holds one still frame. The
drawing is `packages/design-system/src/backgrounds/topography.ts` (MOTIR-11617),
built to the approved design in `design/backgrounds/` (MOTIR-11602).
