// Colour arithmetic for the backgrounds. Every colour a background paints comes
// from a design-system token read off the live theme (`./tokens`), so these
// helpers only PARSE a token's computed value and MIX between token colours —
// they never introduce a hue of their own.

/** An sRGB colour as 0–255 channels. */
export type Rgb = readonly [number, number, number];

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * Parse a computed CSS colour into channels: `#rgb`, `#rrggbb(aa)`, `rgb()` /
 * `rgba()` (comma or space separated) and the `color(srgb r g b)` a
 * `color-mix()` token computes to. Returns `null` for anything else (an empty
 * string from an undeclared token included), so a caller can skip the ink.
 */
export function parseColour(value: string | null | undefined): Rgb | null {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return null;
  return parseHex(v) ?? parseRgbFunction(v) ?? parseSrgb(v);
}

const triple = (a: number, b: number, c: number): Rgb => [clamp255(a), clamp255(b), clamp255(c)];

function parseHex(v: string): Rgb | null {
  const h = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (!h) return null;
  const at = (i: number, len: number) =>
    parseInt(len === 1 ? h[i]! + h[i]! : h.slice(i, i + 2), 16);
  if (h.length === 3 || h.length === 4) return triple(at(0, 1), at(1, 1), at(2, 1));
  if (h.length === 6 || h.length === 8) return triple(at(0, 2), at(2, 2), at(4, 2));
  return null;
}

function parseRgbFunction(v: string): Rgb | null {
  const body = /^rgba?\(([^)]+)\)$/.exec(v)?.[1];
  if (!body) return null;
  const [r, g, b] = body
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
  if (r === undefined || g === undefined || b === undefined) return null;
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return triple(r, g, b);
}

function parseSrgb(v: string): Rgb | null {
  const m = /^color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)/.exec(v);
  if (!m) return null;
  return triple(parseFloat(m[1]!) * 255, parseFloat(m[2]!) * 255, parseFloat(m[3]!) * 255);
}

/** `a` mixed toward `b` by `t` (0 = a, 1 = b). */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return triple(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

/** The colour as an `rgba()` string at alpha `a`. */
export function rgba(c: Rgb, a = 1): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}

/** The colour packed for a little-endian `Uint32Array` view of `ImageData`, fully opaque. */
export function packRgb(c: Rgb): number {
  return ((255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
}

/** Relative luminance (WCAG), 0 = black, 1 = white. */
export function luminance(c: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/**
 * The colour at `position` along a closed ramp through `stops` — position 0 is
 * stops[0], 1 is stops[1], `stops.length` wraps back to stops[0].
 */
export function cycleRgb(stops: readonly Rgb[], position: number): Rgb {
  const n = stops.length;
  const p = ((position % n) + n) % n;
  const i = Math.floor(p);
  return mixRgb(stops[i % n]!, stops[(i + 1) % n]!, p - i);
}

/** `count` colours spaced evenly round the closed ramp through `stops`. */
export function ramp(stops: readonly Rgb[], count: number): Rgb[] {
  return Array.from({ length: count }, (_, s) => cycleRgb(stops, (s / count) * stops.length));
}
