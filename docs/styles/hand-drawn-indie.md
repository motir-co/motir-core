# Style — Hand-Drawn / Indie (`data-style="hand-drawn-indie"`)

> The sketchy, friendly, zine-like alternate (a DEFERRED post-v1 follow-up,
> Subtask 7.3.41). Shipped as the `[data-style='hand-drawn-indie']` block in
> [`app/globals.css`](../../app/globals.css) (Tier 2) plus a style-scoped
> rough-border rule, the `#hd-rough` SVG filter def
> ([`components/theme/HandDrawnFilter.tsx`](../../components/theme/HandDrawnFilter.tsx),
> mounted once in the root layout), registered in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts).

**Tagline:** Sketchy and friendly — rough hand-inked edges, wonky corners, soft
offset shadows, a playful bounce.
**Inspiration:** Indie / zine + hand-drawn web design — Excalidraw's rough
hand-sketched strokes and doodled notebook UIs: warm, imperfect, human.
**Wrong moods:** machined, precise, corporate, glassy, harsh, cold.

This is the STYLE (shape/feel) axis only. Colour is the independent
`data-palette` axis — Hand-Drawn / Indie inherits whatever palette is active and
changes no hue. See [`DESIGN.md`](../DESIGN.md) for the colour system and the
two-axis contract.

**How it differs from the Soft / Playful style:** both are friendly and rounded,
but Soft / Playful is **smooth and machined** — clean, symmetric radii and
perfectly straight edges — whereas Hand-Drawn / Indie is **rough and human**:
each corner of a surface is a _different_ curve (the wonky "drawn box"), and the
outline itself is **warped into a wavy ink line** by a displacement filter, so it
reads as drawn by hand rather than rendered. Soft / Playful is the polished end
of the rounded family; Hand-Drawn / Indie is the hand-sketched end.

## Feel-bearing dimensions

| Dimension             | Hand-Drawn / Indie                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Shape / silhouette    | Wonky hand-drawn corners — a strongly asymmetric radius per surface; drawn boxes.           |
| Border / stroke       | Genuinely rough, wavy ink edges — a turbulence filter warps each outline (Excalidraw look). |
| Elevation philosophy  | Soft, hand-placed offset shadows — a gentle blurred drop nudged down-right (a doodle).      |
| Surface / background  | Opaque, warm, paper-like panels; the rough wavy outline + soft shadow carry the feel.       |
| Density rhythm        | Roomy and relaxed (20×12 buttons, 26px card pad, 38px controls) — margins round the sketch. |
| Motion                | Springy + playful — 200ms transitions, a bouncy hover lift (1.02) + press squish (0.97).    |
| Typography            | Marker pairing (Caveat hand-lettered headlines + Inter body), via `defaultTypeId`.          |
| Component silhouettes | Wonky-cornered buttons/inputs/cards/modals, irregular chips, rough wavy-ink-bordered.       |

## The two moves that make it read as hand-drawn

A common failure mode here is "softly rounded" — bumping the radius and calling it
hand-drawn. That is indistinguishable from Soft / Playful. Two distinct moves are
what sell the sketch:

1. **Wonky corners (token-only).** Every semantic surface radius is a strongly
   _asymmetric_ multi-value value — the slash splits the four horizontal corner
   radii from the four vertical, and they differ widely, so one corner is
   near-sharp while the opposite is generously round. A box stops looking machined
   and starts looking _drawn_. (Subtle ±2px asymmetry does NOT achieve this — the
   spread has to be large, e.g. `--radius-card: 18px 58px 22px 48px / 48px 20px
54px 24px`.)
2. **Rough edges (the SVG filter).** Asymmetric radius only bends the _corners_;
   the lines between them stay machine-straight. To make the _line_ wavy, a
   `feTurbulence` + `feDisplacementMap` filter (`#hd-rough`) displaces the outline
   into an ink-like wobble — the Excalidraw / rough.js quality. This is the move
   that actually makes it look hand-drawn.

## Token overrides (`[data-style='hand-drawn-indie']`)

Only shape/feel tokens — no colour token appears in the bare block (the
disjoint-axis acceptance criterion; enforced by
`tests/theme/styleRegistry.test.ts`):

- **Radius (silhouette):** the generic scale stays soft + single-valued
  (`--radius-xs … -xl: 6 → 24px`), but every **semantic surface** token takes a
  strongly asymmetric **multi-value** radius (`a b c d / e f g h`) so no two
  corners share a curve — `--radius-btn / -input / -card / -modal / -badge /
-control / -kbd`. **`--radius-badge`** is intentionally wonky (not a clean pill)
  so status chips read as hand-inked, and `--radius-pill` is **left untouched** so
  genuinely-circular affordances (avatars, status dots, the spinner) stay round.
- **Elevation:** `--shadow-{subtle,card,elevated,modal,hero-mockup}` become
  **soft, blurred, down-right-offset** shadows — `1px 2px 4px -1px` through
  `6px 12px 40px -10px`, all a warm `rgba(38, 30, 22, …)` ink at low opacity. A
  gentle, hand-placed drop, never a hard block nor a flat removal. The warm `rgba`
  literal is decorative shadow ink (NOT a `--color-*` token, so the colour axis
  stays disjoint — the same way the base shadows hard-code their `rgba`).
- **Density:** roomy, relaxed controls — `--spacing-btn-x/y: 20/12`,
  `--spacing-input-x/y: 16/12`, `--spacing-control-x/y: 12/8`,
  `--height-control: 38px`, `--height-input: 44px` — against a generous
  `--spacing-card-padding: 26px`. The sketch wants air around it.
- **Motion:** `--transition-duration: 200ms` (`--transition-fast: 130ms`,
  `--transition-slow: 320ms`) with **`--hover-scale: 1.02` / `--active-scale:
0.97`** — a bouncy hover lift and a deeper press squish, for a friendly wobble.

## The rough edge — the `#hd-rough` filter + a content-safe pseudo-border

The defining hand-drawn axis has no token: a wavy, hand-inked OUTLINE. It is built
from two pieces:

- **The filter def** — `<HandDrawnFilter/>` renders a hidden `<svg>` once in the
  root layout (next to `<ImmersiveTilt/>`, the same per-style-mechanism pattern),
  so `url(#hd-rough)` resolves on every route. A CSS-only data-URI filter is
  unreliable cross-browser (notably Safari), so the def is an in-document `<svg>`
  — hidden, zero layout cost, and **unreferenced (free) until this style is
  active**. The filter is `feTurbulence` (fractal noise) → `feDisplacementMap`,
  which warps whatever it is applied to.

- **The pseudo-line rules** in `app/globals.css` (see the section there). The
  wavy ink line is drawn on a `::after` **overlay**, never on the surface itself,
  so the displacement warps only the OUTLINE — **the surface's text and content
  stay perfectly crisp** (filtering the whole element smears the text, which is
  why this style does NOT filter surfaces). The real border is KEPT (2px) as a
  structural fallback. The overlay ink is **palette-derived**
  (`var(--el-border-strong)`), so the colour axis stays disjoint and the line
  adapts to dark mode; as a descendant rule (not a bare `[data-style] { … }` token
  block) it doesn't trip the disjoint-token guard.

  **Two line kinds are roughened, so the frame and the inner grid match.** A first
  pass roughened only the full-box `.border` — which left a _straight_ grid inside
  a _wavy_ card (a visible mismatch: rough table frame, ruler-straight row
  dividers). So the single-side dividers (`.border-b` / `.border-t` — table rows,
  section rules) get the same wavy `::after`, scoped **inside `[data-surface]`
  panels** to bound the count to real surfaces (whose rows are virtualised, so
  only ~viewport-many overlays ever render). `:not(.border)` avoids
  double-handling, and the overlay is suppressed only on the genuinely
  border-removed last row via its real `last:border-b-0` class — NOT via
  `:not(:last-child)`, because a STICKY table header sits alone in its own
  `role="rowgroup"` and is therefore itself a `:last-child`, so that heuristic
  wrongly skipped the work-item table header's divider.

- **The ink is an `outline`, and the overlay box stays inside its host.** The
  line straddles the host's padding edge (1px out, 1px in), so it sits on the
  real border it roughens. It used to be a 2px `border` on an overlay at
  `inset: -1px`, which put the overlay's BOX a pixel past its host — and on a
  host that is also a scroll container (`.border overflow-x-auto`: framed
  tables, pickers, code blocks) the pseudo-element is part of the host's own
  scrollable overflow, so every such box drew BOTH scroll bars on content that
  fit (MOTIR-7693). An outline is ink, not layout, and never counts toward
  scrollable overflow: the frame overlay sits at `inset: 0` with a 2px outline
  at `outline-offset: -1px`, and a divider is a 0-height box on the edge with a
  1px outline (`left`/`right: 1px` cancel the outline's overrun at the ends).
  Same pixels, no overflow. `tests/e2e/hand-drawn-scroll-frame.spec.ts` measures
  `scrollWidth`/`scrollHeight` against the client box in Chromium — happy-dom
  cannot lay out, so only a rendered check can see this.

- **Why the overlay needs care with positioning.** The `::after` needs a
  positioned host, so static surfaces get `position: relative`. But a centred
  modal / command palette is `fixed .border` and a sticky header is `sticky` —
  each is ALREADY a containing block, and overriding its `position` would break
  it. (The first pass set `position: relative` on every `.border`, which beat the
  modal's `fixed` on specificity and knocked the create / command-search modals
  off-centre.) So the position override is excluded from
  `:not(.fixed):not(.absolute):not(.sticky)` — those keep their own positioning
  and still receive the rough overlay (they're already containing blocks).

## Typography — via the type axis, not this block

Type is the independent `data-type` axis now (Subtask 7.3.53): a style keeps its
out-of-the-box typographic feel through **`defaultTypeId`**, never by overriding
`--font-*` in its own block (which the disjoint-axis test forbids). Hand-Drawn /
Indie ships **`defaultTypeId: 'marker'`** — the Caveat marker pairing
([`docs/typography/marker.md`](../typography/marker.md)): hand-lettered marker
headlines over an Inter body. The headlines read as if written with the same pen
that inked the rough wavy strokes, while body and UI copy stay on Inter, so the
app stays fully legible. The user can still pin any other
type; this is only the curated default.

## Why this is more than a token swap

- **Silhouette becomes wonky, then the edge becomes rough.** A machined rounded
  box (Soft / Playful) and a hand-drawn one are both "round", but only the
  asymmetric-radius + displaced-outline combination reads as _drawn_.
- **Stroke** is the identity: a turbulence-warped wavy ink line, not a quiet
  hairline — the single most recognisable hand-drawn signal.
- **Elevation** is a soft, intentionally-offset doodle shadow, not an even float.
- **Motion** gains a springy hover lift + press squish, so the UI has a friendly
  bounce rather than a flat or mechanical response.

Because every `motir-core` primitive consumes the semantic shape tokens and the
full `.border` utility, this token block plus the one rough-border rule re-shapes
the entire UI — no per-component edits are needed (the token-driven approach of
`soft-playful` / `neo-brutalism`, extended with the per-style filter mechanism
that `3d-immersive` established for effects a token swap cannot express).

## Accessibility & performance

- **AA is preserved by construction.** The style changes no colour token, the
  rough-border ink is palette-derived, and the type pairing keeps the legible
  Inter body. The displacement is applied ONLY to the outline overlay, so text
  contrast/legibility is untouched. Verified by rendering the `/tokens` specimen +
  style vignette in light and dark themes.
- **Decorative outline.** The wavy line frames; it carries no text. Structure
  stays legible via the kept 2px border even where the filter is unavailable.
- **Performance.** An SVG turbulence filter is GPU-light but non-free; it is
  applied per framed surface only while THIS style is active (an opt-in gallery
  aesthetic, in the same ambition class as `3d-immersive`'s tilt engine). If a
  very dense surface ever shows scroll cost under this style, the natural
  optimisation is to scope the rough overlay to the `[data-surface]` panels rather
  than every `.border` — a follow-up, not a blocker for the gallery.
