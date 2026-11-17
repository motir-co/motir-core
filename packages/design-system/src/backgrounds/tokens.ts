// Reading a background's inks off the live theme. Every colour is a
// design-system `--el-*` token, resolved by the browser for the element the
// background draws in (so a nested `[data-palette]` / `[data-theme]` scope is
// honoured), and re-read whenever the theme changes.

import { luminance, parseColour, type Rgb } from './colour';
import type { BackgroundColours } from './types';

/** The token each ink comes from. */
export const BACKGROUND_TOKENS = {
  bg: '--el-page-bg',
  surface: '--el-surface',
  ink: '--el-text',
  line: '--el-border',
  accent: '--el-accent',
  onAccent: '--el-accent-text',
  hue1: '--el-showcase-wave-1',
  hue2: '--el-showcase-wave-2',
  hue3: '--el-showcase-wave-3',
  decision: '--el-showcase-decision',
  highlight: '--el-showcase-highlight',
  ground: '--el-showcase-ground',
} as const;

type TokenKey = keyof typeof BACKGROUND_TOKENS;

/**
 * Build the colour set from a token reader — `read(name)` answers the token's
 * computed value. Returns `null` when any token does not resolve to a colour (a
 * design system that does not declare it reads as `''`): a background then
 * draws nothing rather than throwing over a missing ink.
 *
 * `normalise` turns a value the parser cannot read (an `oklch()`, a named
 * colour) into one it can — in the browser, a canvas context's `fillStyle`
 * round-trip.
 */
export function coloursFromTokens(
  read: (name: string) => string,
  normalise: (value: string) => string = (v) => v,
): BackgroundColours | null {
  const out = {} as Record<TokenKey, Rgb>;
  for (const key of Object.keys(BACKGROUND_TOKENS) as TokenKey[]) {
    const raw = read(BACKGROUND_TOKENS[key]).trim();
    const rgb = parseColour(raw) ?? (raw ? parseColour(normalise(raw)) : null);
    if (!rgb) return null;
    out[key] = rgb;
  }
  return {
    bg: out.bg,
    surface: out.surface,
    ink: out.ink,
    line: out.line,
    accent: out.accent,
    onAccent: out.onAccent,
    hues: [out.hue1, out.hue2, out.hue3],
    decision: out.decision,
    highlight: out.highlight,
    ground: out.ground,
    dark: luminance(out.bg) < 0.4,
  };
}

/**
 * Read the colour set for `el` from its computed style. A colour-mix token
 * computes to a colour value, so the canvas only normalises what the parser
 * cannot read.
 */
export function readBackgroundColours(
  el: Element,
  normaliser?: CanvasRenderingContext2D | null,
): BackgroundColours | null {
  const styles = getComputedStyle(el);
  const normalise = (value: string) => {
    if (!normaliser) return value;
    normaliser.fillStyle = '#000';
    normaliser.fillStyle = value;
    return String(normaliser.fillStyle);
  };
  return coloursFromTokens((name) => styles.getPropertyValue(name), normalise);
}
