/**
 * The Motir TYPOGRAPHY LIBRARY — the named-pairing registry (Subtask 7.3.53).
 *
 * A "type pairing" is a named TYPOGRAPHY scheme the whole UI can swap to at
 * runtime — the THIRD design axis, completing the token decomposition
 * (Colour `data-palette` · Type `data-type` · Shape/feel `data-style`). It is
 * deliberately INDEPENDENT of the other two: a pairing decides which TYPEFACES
 * the product wears (the headline / body / mono role mapping); it never touches
 * a hue (palette axis) or a radius (style axis).
 *
 * ── The three-axis runtime contract ─────────────────────────────────────
 *   data-type="<type-id>"       — THIS axis. A `[data-type='<id>']` block in
 *                                 app/globals.css re-points the `--font-*`
 *                                 role tokens (sans / serif / mono) — and ONLY
 *                                 font tokens, never colour or shape.
 *   data-palette="<palette-id>" — the INDEPENDENT colour axis (`--el-*`).
 *   data-style="<style-id>"     — the INDEPENDENT shape/feel axis.
 *
 * The shared `--font-size-*` SCALE stays common across pairings — sizes are
 * layout, not brand; a pairing remaps the FACES, not the type scale.
 *
 * ── A style declares a DEFAULT pairing (overridable) ────────────────────
 * Typography used to be BUNDLED into the style axis: `swiss-minimal-flat`,
 * `neo-brutalism` and `cybercore-y2k` each re-pointed `--font-serif` inside
 * their own `[data-style]` block. That is now a disjointness violation (two
 * axes setting `--font-*`). The fix: each style declares a `defaultTypeId`
 * (see ./styles.ts) — the pairing applied when the user has NOT pinned an
 * explicit type — and the per-style font overrides move here, as pairings.
 * So out-of-the-box looks are UNCHANGED; the new freedom is that type is now
 * independently overridable (e.g. Swiss shape + a serif pairing).
 *
 * ── v1 — the base faces only (no new payload) ───────────────────────────
 * v1 registered three pairings built from the THREE already-loaded next/font
 * faces (Inter · Source Serif 4 · JetBrains Mono) — so they add ZERO font
 * payload and carry NO new-typeface design decision:
 *   - `motir`      — the base: editorial serif headlines over a sans body.
 *   - `motir-sans` — all-sans (Inter headlines); reproduces the Swiss look.
 *   - `motir-mono` — mono THROUGHOUT (headlines + body/UI); a code-native UI.
 * `motir` is the base — like the `motir` palette / `warm-editorial` style it
 * needs NO `[data-type]` override block; the base `--font-*` tokens already are
 * it.
 *
 * ── New-typeface pairings (Grotesk / Editorial / Mono-Technical, 7.3.54–56) ──
 * Each adds a real type-design decision and loads its own next/font face(s),
 * re-pointing a role in its own `[data-type]` block:
 *   - `grotesk` (7.3.54)        — Space Grotesk THROUGHOUT (headlines + body/UI).
 *   - `editorial` (7.3.55)      — Fraunces display-serif headlines over the Inter
 *     body; a magazine, considered pairing (one new face — Inter + JetBrains reused).
 *     Body STAYS Inter — a display serif is unreadable as UI, so this pairing
 *     re-types headlines only (the legibility exception to whole-UI re-typing).
 *   - `mono-technical` (7.3.56) — IBM Plex Mono THROUGHOUT (headlines + body/UI +
 *     meta); a precise, developer-grade UI (one new face — Inter reused for nothing
 *     now, kept as the ultimate fallback).
 *
 * ── New-typeface pairings (Story MOTIR-10548) ─────────────────────────────
 *   - `marker` (MOTIR-10553)    — Caveat hand-lettered marker headlines over the
 *     Inter body; Hand-Drawn / Indie's default. Display-only, like `editorial`: a
 *     marker hand is unreadable as UI text, so only the headline role is re-typed.
 *   - `rounded` (MOTIR-10554)   — Nunito THROUGHOUT (headlines + body/UI); a
 *     soft, friendly rounded sans that reads cleanly as UI text, so it re-types
 *     the whole UI like `grotesk`.
 *   - `slab` (MOTIR-10555)      — Roboto Slab headlines over the Inter body;
 *     sturdy and print-like. Display-only, like `editorial`: heavy slab serifs
 *     crowd UI text, so only the headline role is re-typed.
 *   - `humanist` (MOTIR-10556)  — Fira Sans THROUGHOUT (headlines + body/UI); a
 *     warm humanist sans drawn as a screen UI face, so it re-types the whole UI
 *     like `grotesk`.
 *
 * ── Whole-UI re-typing (Yue, 2026-06-19) ────────────────────────────────
 * A type pairing re-types the WHOLE app, chrome included (nav, header, buttons),
 * not just headlines: a pairing whose signature face reads as a UI sans/mono
 * (`grotesk`, `motir-mono`, `mono-technical`, `rounded`, `humanist`) ALSO
 * re-points the body/UI role (`--font-sans`) in its `[data-type]` block. The
 * display-serif `editorial` and `slab`, the display-only `marker` and the
 * all-Inter `motir` / `motir-sans` keep the Inter body for legibility.
 * Each later "Type: …" subtask ADDS its entry here + a `[data-type]` block (its
 * face loaded in `app/layout.tsx`) + its `docs/typography/<id>.md`.
 */

/** A registered, runtime-selectable type pairing. */
export interface TypographyDefinition {
  /** The `data-type` attribute value. Stable; used as the localStorage value. */
  id: string;
  /** Display name shown in the gallery / `/tokens` toggle. */
  name: string;
  /** One-line characterization of the typographic feel. */
  tagline: string;
  /** The headline / body / mono face mapping (credit / what it loads). */
  faces: string;
  /**
   * Repo-relative path to this pairing's doc — the type-role reference a later
   * getdesign-style swap or the `/tokens` composer reads. Every registered
   * pairing maps to exactly one.
   */
  designDoc: string;
}

/**
 * The registry. Insertion order is the gallery order. Each non-base `id`
 * matches a `[data-type='<id>']` block in app/globals.css (`motir` is the base,
 * so its block is the Tier-0 `--font-*` defaults — no override block needed).
 */
export const TYPE_REGISTRY = {
  motir: {
    id: 'motir',
    name: 'Motir',
    tagline: 'Editorial serif headlines over a clean sans body — the house pairing.',
    faces: 'Source Serif 4 headlines · Inter body · JetBrains Mono meta.',
    designDoc: 'docs/typography/motir.md',
  },
  'motir-sans': {
    id: 'motir-sans',
    name: 'Motir Sans',
    tagline: 'All-sans — Inter for headlines and body; structural, no serif.',
    faces: 'Inter headlines + body · JetBrains Mono meta.',
    designDoc: 'docs/typography/motir-sans.md',
  },
  'motir-mono': {
    id: 'motir-mono',
    name: 'Motir Mono',
    tagline: 'Monospace throughout — a code-native UI, headlines, body and all.',
    faces: 'JetBrains Mono headlines + body/UI + meta.',
    designDoc: 'docs/typography/motir-mono.md',
  },
  grotesk: {
    id: 'grotesk',
    name: 'Grotesk',
    tagline: 'Geometric neo-grotesque across the whole UI — tight, confident, product-y.',
    faces: 'Space Grotesk headlines + body/UI · JetBrains Mono meta.',
    designDoc: 'docs/typography/grotesk.md',
  },
  editorial: {
    id: 'editorial',
    name: 'Editorial',
    tagline: 'A characterful display serif over a humanist sans — magazine, considered.',
    faces: 'Fraunces display headlines · Inter body · JetBrains Mono meta.',
    designDoc: 'docs/typography/editorial.md',
  },
  'mono-technical': {
    id: 'mono-technical',
    name: 'Mono-Technical',
    tagline: 'IBM Plex Mono throughout — a precise, developer-grade UI.',
    faces: 'IBM Plex Mono headlines + body/UI + meta/code.',
    designDoc: 'docs/typography/mono-technical.md',
  },
  marker: {
    id: 'marker',
    name: 'Marker',
    tagline: 'Hand-lettered marker headlines over a clean sans body — sketchy, friendly, human.',
    faces: 'Caveat marker headlines · Inter body · JetBrains Mono meta.',
    designDoc: 'docs/typography/marker.md',
  },
  rounded: {
    id: 'rounded',
    name: 'Rounded',
    tagline: 'A soft rounded sans across the whole UI — friendly and approachable.',
    faces: 'Nunito headlines + body/UI · JetBrains Mono meta.',
    designDoc: 'docs/typography/rounded.md',
  },
  slab: {
    id: 'slab',
    name: 'Slab',
    tagline: 'Sturdy slab-serif headlines over a clean sans body — confident, print-like.',
    faces: 'Roboto Slab headlines · Inter body · JetBrains Mono meta.',
    designDoc: 'docs/typography/slab.md',
  },
  humanist: {
    id: 'humanist',
    name: 'Humanist',
    tagline: 'A warm humanist sans across the whole UI — open and readable.',
    faces: 'Fira Sans headlines + body/UI · JetBrains Mono meta.',
    designDoc: 'docs/typography/humanist.md',
  },
} satisfies Record<string, TypographyDefinition>;

/** The id of every registered pairing — `data-type` value space. */
export type TypeId = keyof typeof TYPE_REGISTRY;

/** All registered pairing ids, in gallery order. */
export const TYPE_IDS = Object.keys(TYPE_REGISTRY) as TypeId[];

/**
 * The default pairing a fresh install / unset preference resolves to when the
 * active style declares none. Motir is the house pairing and the Tier-0 base.
 */
export const DEFAULT_TYPE_ID: TypeId = 'motir';

/** Narrowing guard — is an arbitrary string a registered pairing id? */
export function isTypeId(value: unknown): value is TypeId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TYPE_REGISTRY, value);
}

/** Resolve a (possibly stale / unknown) value to a valid pairing definition. */
export function resolveType(value: unknown): TypographyDefinition {
  return TYPE_REGISTRY[isTypeId(value) ? value : DEFAULT_TYPE_ID];
}
