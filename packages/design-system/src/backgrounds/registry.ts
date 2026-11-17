// The background registry — the catalogue of backgrounds a page area can draw.
//
// Pure data, RSC-safe (no DOM, no React): a server component reads it to know
// which ids exist, and `motir.design.json` stores one of these ids (or `none`)
// per page area. The drawing lives in `./drawers` and the client component in
// `../components/backgrounds/Background`.
//
// A background either FOLLOWS THE STYLE — its shape, stroke and motion come from
// the active `data-style`, its colour from palette and mode — or is the SAME IN
// EVERY STYLE and follows only palette and mode. Background is not a fourth
// `data-*` axis on `<html>`: one page can show different backgrounds in
// different areas, so the choice is passed to the component per area.

import { isStyleId, type StyleId } from '../theme/styles';

/** The page areas a project picks a background for. */
export const BACKGROUND_AREAS = ['landing', 'login', 'hero'] as const;
export type BackgroundArea = (typeof BACKGROUND_AREAS)[number];

/** A registered background. */
export interface BackgroundDefinition {
  /** The stored id (`motir.design.json`, the component's `id` prop). Stable. */
  id: string;
  /** Display name for a picker. */
  name: string;
  /** One-line description for a picker. */
  description: string;
  /** True when the active style redraws it; false when only palette and mode change it. */
  followsStyle: boolean;
  /**
   * True when the background gathers itself around the focus element instead of
   * being cleared behind it (the Wave's lines bunch there); every other
   * background gets the feathered clear area in the page colour.
   */
  gathersAroundFocus: boolean;
}

/** The registry. Insertion order is the picker order. */
export const BACKGROUND_REGISTRY = {
  wave: {
    id: 'wave',
    name: 'Wave',
    description:
      'The line from the Motir mark, repeated across the page. The lines gather around the main content.',
    followsStyle: true,
    gathersAroundFocus: true,
  },
  topography: {
    id: 'topography',
    name: 'Topography',
    description: 'Contour lines over a slowly shifting height map.',
    followsStyle: true,
    gathersAroundFocus: false,
  },
  aurora: {
    id: 'aurora',
    name: 'Aurora',
    description: 'Soft colour bands that drift and slowly change colour.',
    followsStyle: false,
    gathersAroundFocus: false,
  },
  cyclic: {
    id: 'cyclic',
    name: 'Cyclic CA',
    description: 'Sixteen colour states chase each other in rings and bands.',
    followsStyle: false,
    gathersAroundFocus: false,
  },
  brian: {
    id: 'brian',
    name: "Brian's Brain",
    description: 'Cells fire, fade and clear. It never settles.',
    followsStyle: false,
    gathersAroundFocus: false,
  },
  daynight: {
    id: 'daynight',
    name: 'Day & Night',
    description: 'Large solid regions with edges that keep moving.',
    followsStyle: false,
    gathersAroundFocus: false,
  },
  rule110: {
    id: 'rule110',
    name: 'Rule 110',
    description: 'A one-dimensional rule drawn a row at a time, scrolling up.',
    followsStyle: false,
    gathersAroundFocus: false,
  },
} as const satisfies Record<string, BackgroundDefinition>;

/** The id of every registered background. */
export type BackgroundId = keyof typeof BACKGROUND_REGISTRY;

/** All registered background ids, in picker order. */
export const BACKGROUND_IDS = Object.keys(BACKGROUND_REGISTRY) as BackgroundId[];

/** The stored value that means "draw nothing in this area". */
export const BACKGROUND_NONE = 'none';

/** A per-area choice as stored: a background id, or `none`. */
export type BackgroundChoice = BackgroundId | typeof BACKGROUND_NONE;

/** The background every style draws unless its entry below says otherwise. */
export const DEFAULT_BACKGROUND_ID: BackgroundId = 'wave';

/**
 * A style's own default background, where it is not {@link DEFAULT_BACKGROUND_ID}.
 * Empty today: every registered style defaults to the Wave.
 */
export const STYLE_DEFAULT_BACKGROUND: Partial<Record<StyleId, BackgroundId>> = {};

/** Narrowing guard — is an arbitrary value a registered background id? */
export function isBackgroundId(value: unknown): value is BackgroundId {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(BACKGROUND_REGISTRY, value)
  );
}

/** The default background for a (possibly unknown) style value. */
export function defaultBackgroundForStyle(styleValue?: unknown): BackgroundId {
  return (isStyleId(styleValue) && STYLE_DEFAULT_BACKGROUND[styleValue]) || DEFAULT_BACKGROUND_ID;
}

/**
 * Resolve a (possibly stale, unknown or missing) id to a registered background —
 * the style's default when it is not one, the way `resolveStyle` treats an
 * unknown style id. Never throws.
 */
export function resolveBackground(value: unknown, styleValue?: unknown): BackgroundDefinition {
  return BACKGROUND_REGISTRY[isBackgroundId(value) ? value : defaultBackgroundForStyle(styleValue)];
}

/**
 * Resolve a stored per-area choice: `none` stays `none` (draw nothing), a
 * registered id stays itself, and anything else falls back to the style's
 * default background.
 */
export function resolveBackgroundChoice(value: unknown, styleValue?: unknown): BackgroundChoice {
  if (value === BACKGROUND_NONE) return BACKGROUND_NONE;
  return resolveBackground(value, styleValue).id as BackgroundId;
}
