/**
 * The Motir PALETTE LIBRARY — the named-colour registry (Subtask 7.3.48).
 *
 * A "palette" is a named COLOUR scheme the whole UI can swap to at runtime —
 * the second half of the two-axis contract the style schema (7.3.32) wrote but
 * did not implement. It is the COLOUR/hue axis, and it is deliberately
 * INDEPENDENT of the SHAPE axis (`data-style` — see ./styles.ts): a palette
 * decides what colours the product WEARS (surfaces, ink, accent, tints,
 * semantic hues); a style decides how it FEELS (silhouette, elevation,
 * density, motion). Picking a palette never changes a radius, and picking a
 * style never changes a hue.
 *
 * ── The two-axis runtime contract ───────────────────────────────────────
 *   data-palette="<palette-id>" — THIS axis. Layers per-palette colour
 *                                 overrides over the base in
 *                                 packages/design-system/theme.css (which
 *                                 app/globals.css imports).
 *   data-style="<style-id>"     — the INDEPENDENT shape/feel axis.
 *   data-theme="light|dark"     — the light/dark base WITHIN a palette
 *                                 (`--color-*`); orthogonal to the palette.
 *
 * A `[data-palette='…']` block in packages/design-system/theme.css MUST
 * override ONLY colour tokens — the Tier-0 `--color-*` sources the `--el-*`
 * element layer reads, plus the odd `--el-*` — NEVER a shape/feel token (radius / spacing / shadow
 * / sizing / motion / type). That is the style axis's job, and keeping the two
 * disjoint is what makes "style × palette" a true product of two independent
 * choices rather than N×M hand-tuned combinations.
 *
 * ── Motir's own palette, and the one that used to be ──────────────────────
 * **Motir** is the palette Motir wears when a person has chosen none: the stark
 * monochrome scheme (cool greyscale surfaces + ink, an ink CTA, a single
 * restrained cool-blue accent). It shipped as "Graphite" (7.3.51) and took the
 * product's name in MOTIR-6471, so its colours arrive through its
 * `[data-palette='motir']` block.
 *
 * **Amethyst** is the warm scheme the product wore until then (cream surfaces,
 * charcoal ink, purple primary, pastel feature tints), which carried the name
 * "Motir" from v1 (Per Yue, 2026-06-17) until that rename. It is still the
 * Tier-0/Tier-3 BASE in theme.css, so — exactly like the `warm-editorial` base
 * style — the base `--el-*` tokens already are it; its `[data-palette='amethyst']`
 * blocks only re-assert that base inside a scoped subtree. `<html>` always
 * carries a `data-palette`, so the base is a fallback, never what a person sees
 * by default. Each later "Palette: …" subtask ADDS its entry here, ships a
 * `[data-palette='<id>']` block in packages/design-system/theme.css overriding
 * the Tier-0 `--color-*` sources (plus the odd `--el-*`), and authors its
 * `docs/palettes/<id>.md` doc — exactly the shape the per-style subtasks
 * (7.3.33+) follow on the other axis.
 *
 * ⚠️ A STORED palette id written before the rename means the OTHER palette:
 * `motir` meant today's `amethyst`, and `graphite` meant today's `motir`. Every
 * store is migrated once (`PALETTE_ID_MIGRATION` in ./types.ts, and the
 * `user_appearance_preference` migration) — never alias the old spellings.
 */

/** A registered, runtime-selectable colour palette. */
export interface PaletteDefinition {
  /** The `data-palette` attribute value. Stable; used as the localStorage value. */
  id: string;
  /** Display name shown in the gallery / `/tokens` toggle. */
  name: string;
  /** One-line characterization of the colour mood. */
  tagline: string;
  /** Where the colours are drawn from (credit / mood anchor). */
  inspiration: string;
  /**
   * Repo-relative path to this palette's doc — the colour-role reference a
   * later getdesign-style swap or the `/tokens` composer reads. Every
   * registered palette maps to exactly one.
   */
  designDoc: string;
}

/**
 * The registry. Insertion order is the gallery order. Each `id` matches a
 * `[data-palette='<id>']` block in theme.css (Amethyst is the Tier-3 base, so its
 * blocks only re-assert the defaults inside a scoped subtree).
 */
export const PALETTE_REGISTRY = {
  motir: {
    id: 'motir',
    name: 'Motir',
    tagline:
      'Stark and editorial — cool greyscale surfaces + ink, an ink CTA, a restrained cool-blue accent and a few warm touches.',
    inspiration:
      "Vercel's black-and-white precision + Linear's ultra-minimal, on Radix Slate/Blue scales.",
    designDoc: 'docs/palettes/motir.md',
  },
  amethyst: {
    id: 'amethyst',
    name: 'Amethyst',
    tagline: 'Warm and editorial — cream surfaces, charcoal ink, a purple primary, pastel tints.',
    inspiration:
      "Notion's warm marketing palette — Motir's house colours until the monochrome rename.",
    designDoc: 'docs/palettes/amethyst.md',
  },
  cobalt: {
    id: 'cobalt',
    name: 'Cobalt',
    tagline:
      'Cool and institutional — slate-cool surfaces, a confident cobalt primary, cooled tints.',
    inspiration:
      "Coinbase's clean institutional blue + IBM's structured blue, on Radix Blue/Indigo/Slate scales.",
    designDoc: 'docs/palettes/cobalt.md',
  },
  evergreen: {
    id: 'evergreen',
    name: 'Evergreen',
    tagline:
      'Fresh and technical — an emerald primary over cooled forest neutrals, a green-leaning UI.',
    inspiration:
      'getdesign.md — Supabase (dark emerald) / Spotify (vibrant green) / MongoDB (spring green), on Radix green/jade ramps.',
    designDoc: 'docs/palettes/evergreen.md',
  },
  spectrum: {
    id: 'spectrum',
    name: 'Spectrum',
    tagline:
      'Vibrant and playful — crisp cool surfaces, a bright violet primary, a candy-bright multi-hue accent & tint set.',
    inspiration:
      "Figma's vibrant multi-colour brand + Airtable's colourful, friendly palette, on Radix Violet/Iris/Pink/Blue scales.",
    designDoc: 'docs/palettes/spectrum.md',
  },
  amber: {
    id: 'amber',
    name: 'Amber',
    tagline:
      'Warm and electric — Binance trading-floor gold over the exchange’s graphite near-blacks; dark labels on the gold.',
    inspiration:
      'Binance — its whole documented palette: the bold gold #F0B90B/#FCD535 over cool graphite trading-floor blacks (#0B0E11/#1E2329) + greys, with the buy-green/sell-red semantics.',
    designDoc: 'docs/palettes/amber.md',
  },
  sienna: {
    id: 'sienna',
    name: 'Sienna',
    tagline:
      'Warm and vivid — Mistral flame-orange over the Mediterranean warm-cream surfaces; dark labels on the flame.',
    inspiration:
      'Mistral AI — its whole documented palette (getdesign.md/mistral.ai): the flame #fa520f + Block-gradient + Sunshine ambers over Warm-Ivory cream surfaces (#fffaeb) and Mistral-Black ink.',
    designDoc: 'docs/palettes/sienna.md',
  },
  garnet: {
    id: 'garnet',
    name: 'Garnet',
    tagline:
      'Rich and bold — Pinterest Pushpin red over the brand’s neutral greys; white labels on the red.',
    inspiration:
      'Pinterest — its whole documented palette: Pushpin red #E60023/#BD081C over Cod-Gray ink (#111111) and neutral greys (#767676/#EFEFEF), with Gestalt “Skycicle” blue links.',
    designDoc: 'docs/palettes/garnet.md',
  },
  citrine: {
    id: 'citrine',
    name: 'Citrine',
    tagline:
      'Bright and collaborative — Miro’s Sunglow yellow over the whiteboard greys, with the Miro action-blue accent.',
    inspiration:
      'Miro — its whole Mirotone palette (every value a documented Mirotone step): Sunglow yellow #FFD02F (primary) + the action-blue #3859FF over the gray ramp + Stratos ink #050038, with the green/red semantic ramps.',
    designDoc: 'docs/palettes/citrine.md',
  },
  candy: {
    id: 'candy',
    name: 'Candy',
    tagline:
      'Sweet and playful — a light bubblegum-pink primary over candy-paper pinks, with a full pastel-candy rainbow.',
    inspiration:
      'A candy concept grounded entirely in documented Radix Colors scales (every value a Radix step): Pink primary + Mauve neutrals + a Sky/Jade/Violet/Amber/Crimson candy rainbow; Glossier Pink #F5DADF as the pastel-pink mood reference.',
    designDoc: 'docs/palettes/candy.md',
  },
  lagoon: {
    id: 'lagoon',
    name: 'Lagoon',
    tagline:
      'Cool and fresh — a deep lagoon-cyan primary over shallow-water surfaces and slate ink, with a coral highlight.',
    inspiration:
      'A lagoon concept grounded entirely in documented Radix Colors scales (every value a Radix step): Cyan primary + Slate cool neutrals, a Tomato coral highlight, and Tomato/Crimson/Jade/Violet/Cyan/Amber tints.',
    designDoc: 'docs/palettes/lagoon.md',
  },
} satisfies Record<string, PaletteDefinition>;

/** The id of every registered palette — `data-palette` value space. */
export type PaletteId = keyof typeof PALETTE_REGISTRY;

/** All registered palette ids, in gallery order. */
export const PALETTE_IDS = Object.keys(PALETTE_REGISTRY) as PaletteId[];

/**
 * The palette Motir wears when a person has chosen none — a fresh install, a
 * signed-out visitor, an unset (null) server preference. Its VALUE has been
 * `'motir'` since v1; what it NAMES changed in MOTIR-6471, from the warm scheme
 * (now `amethyst`) to the monochrome one (formerly `graphite`).
 */
export const DEFAULT_PALETTE_ID: PaletteId = 'motir';

/**
 * The palette theme.css's Tier-0/Tier-3 BASE carries — the one with no root
 * `[data-palette]` override block, only a scoped re-assertion. It is the
 * reference every other palette's override is measured AGAINST. Until
 * MOTIR-6471 it was also {@link DEFAULT_PALETTE_ID}; since the rename the two
 * differ, so a reader asking "which palette is the base?" names this and never
 * the default.
 */
export const BASE_PALETTE_ID: PaletteId = 'amethyst';

/**
 * The default look the onboarding Design step offers for a user's OWN project —
 * a different question from the one {@link DEFAULT_PALETTE_ID} answers. It stays
 * on the warm scheme the step has always opened on (MOTIR-6470's scope boundary,
 * confirmed by the requester).
 */
export const DEFAULT_PROJECT_PALETTE_ID: PaletteId = 'amethyst';

/** Narrowing guard — is an arbitrary string a registered palette id? */
export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PALETTE_REGISTRY, value);
}

/** Resolve a (possibly stale / unknown) value to a valid palette definition. */
export function resolvePalette(value: unknown): PaletteDefinition {
  return PALETTE_REGISTRY[isPaletteId(value) ? value : DEFAULT_PALETTE_ID];
}
