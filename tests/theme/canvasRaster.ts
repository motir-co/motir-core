// MOTIR-10736 — a minimal rasteriser for a style's canvas `background-image`.
//
// The style × palette × mode gate (`stylePaletteModeContrast.test.ts`) used to
// flatten a canvas by compositing EACH gradient layer ALONE over the page
// ground. A browser stacks every layer at every pixel, so where two translucent
// washes overlap the real ground is further from the page than any single-layer
// stop, and the gate under-reported exactly there (MOTIR-10707's glass corner,
// MOTIR-10709's aurora ribbons).
//
// This module paints the stack the way CSS Backgrounds 3 and CSS Images 3 say a
// browser does, at sampled pixels of a set of viewports, and returns the worst
// contrast each ink reaches. It is deliberately small: it reads the forms the
// shipped canvases use and THROWS on any other form, so a canvas written in a
// syntax it cannot paint fails the gate loudly instead of being measured as
// something else.
//
// What it models:
//   - `linear-gradient` / `repeating-linear-gradient` (an angle, `to <side>`,
//     or the default `to bottom`) and `radial-gradient` / `repeating-radial-
//     gradient` (an ellipse with two explicit lengths, a circle with one, or a
//     bare `circle` / `ellipse` at farthest-corner for a circle);
//   - colour stops with zero, one or two positions in `%`, `px` or a bare `0`,
//     fixed up as CSS Images 3 §3.5.3 orders it, and interpolated in
//     PREMULTIPLIED sRGB, which is what makes `transparent` a pure alpha ramp;
//   - `background-size` (lengths, percentages, `auto`), `background-position`
//     (lengths, percentages, the five keywords) and `background-repeat`
//     (`repeat` / `no-repeat`), per layer, with the list cycled as CSS cycles it;
//   - the positioning area is the VIEWPORT. Every canvas member is either
//     `background-attachment: fixed` or a box the size of the viewport (`body`
//     and the `h-dvh` shell), so the two coincide;
//   - each output pixel is rounded to 8 bits, as the screenshot a person
//     measures would be.
//
// What it does not, and why that is the safe direction:
//   - a TEXTURE layer (a repeating gradient, or a tile 64 px or smaller) is
//     painted once over a window, and every colour it produces is composited
//     over every field pixel. A texture repeats every few pixels, so each of its
//     colours lands on every neighbourhood of the slow-varying washes; taking
//     all of them is the worst case of that, never a better one. Textures are
//     composited ABOVE the field layers, whatever their place in the list;
//   - the field is sampled on a grid and the worst point refined to one pixel.
//     Washes vary over hundreds of pixels, so the grid cannot step over a
//     minimum wider than itself.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A length that may mix an absolute part and a percentage of a reference. */
export interface Length {
  px: number;
  pct: number;
}

const resolveLength = (l: Length, reference: number) => l.px + (l.pct / 100) * reference;

interface RawStop {
  colour: Rgba;
  /** Positions as written, relative to the gradient ray. */
  at: Length[];
}

export interface Gradient {
  kind: 'linear' | 'radial';
  repeating: boolean;
  /** Linear: the CSS angle in degrees (0 = to top, 90 = to right). */
  angle: number;
  /** Radial: the explicit radii, or `null` for a farthest-corner circle. */
  radii: [Length, Length] | null;
  centre: [Length, Length];
  stops: RawStop[];
}

export interface Layer {
  image: Gradient;
  size: [Length | 'auto', Length | 'auto'];
  position: [Length, Length];
  repeat: boolean;
}

export type ColourOf = (expression: string) => Rgba | undefined;

/** Split on `separator` at parenthesis depth 0. */
export function splitTopLevel(text: string, separator = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === separator && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Split on whitespace at parenthesis depth 0. */
function words(text: string): string[] {
  return splitTopLevel(text.trim().replace(/\s+/g, ' '), ' ');
}

const LENGTH = /^(-?[\d.]+)(%|px)?$/;

/** A `<length-percentage>`; a bare number is legal only as `0`. */
export function parseLength(token: string): Length | undefined {
  const match = LENGTH.exec(token.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  if (match[2] === '%') return { px: 0, pct: value };
  if (match[2] === 'px' || value === 0) return { px: value, pct: 0 };
  return undefined;
}

const X_KEYWORDS: Record<string, number> = { left: 0, center: 50, right: 100 };
const Y_KEYWORDS: Record<string, number> = { top: 0, center: 50, bottom: 100 };

/** A one- or two-value `<position>`, as `background-position` and `at <position>` take it. */
export function parsePosition(text: string): [Length, Length] {
  const tokens = words(text);
  if (tokens.length === 0 || tokens.length > 2) {
    throw new Error(`unsupported position "${text}"`);
  }
  const [first, second = 'center'] = tokens as [string, string?];
  // A vertical keyword first (`top center`) swaps the pair.
  const swapped = first in Y_KEYWORDS && first !== 'center';
  const [xText, yText] = swapped ? [second, first] : [first, second];
  const axis = (token: string, keywords: Record<string, number>): Length => {
    if (token in keywords) return { px: 0, pct: keywords[token]! };
    const length = parseLength(token);
    if (!length) throw new Error(`unsupported position "${text}"`);
    return length;
  };
  return [axis(xText, X_KEYWORDS), axis(yText!, Y_KEYWORDS)];
}

const SIDE_ANGLES: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270 };

function parseAngle(token: string): number | undefined {
  const match = /^(-?[\d.]+)(deg|turn)$/.exec(token);
  if (!match) return undefined;
  return match[2] === 'turn' ? Number(match[1]) * 360 : Number(match[1]);
}

/** One colour stop: the colour, then zero, one or two positions. */
function parseStop(arg: string, colourOf: ColourOf): RawStop | undefined {
  const tokens = words(arg);
  const at: Length[] = [];
  while (tokens.length > 1) {
    const length = parseLength(tokens[tokens.length - 1]!);
    if (!length) break;
    at.unshift(length);
    tokens.pop();
  }
  const colour = colourOf(tokens.join(' '));
  if (!colour || at.length > 2) return undefined;
  return { colour, at };
}

/** Parse one RESOLVED gradient (no `var()` left). Throws on a form it cannot paint. */
export function parseGradient(text: string, colourOf: ColourOf): Gradient {
  const match = /^(repeating-)?(linear|radial)-gradient\(([\s\S]*)\)$/.exec(text.trim());
  if (!match) throw new Error(`unsupported image "${text}"`);
  const args = splitTopLevel(match[3]!);
  const gradient: Gradient = {
    kind: match[2] as 'linear' | 'radial',
    repeating: Boolean(match[1]),
    angle: 180,
    radii: null,
    centre: [
      { px: 0, pct: 50 },
      { px: 0, pct: 50 },
    ],
    stops: [],
  };
  const firstStop = parseStop(args[0] ?? '', colourOf);
  const prelude = firstStop ? undefined : args.shift();
  if (prelude !== undefined) {
    if (gradient.kind === 'linear') {
      const side = /^to (top|right|bottom|left)$/.exec(prelude);
      const angle = side ? SIDE_ANGLES[side[1]!] : parseAngle(prelude);
      if (angle === undefined) throw new Error(`unsupported direction "${prelude}"`);
      gradient.angle = angle;
    } else {
      const [shapeText, positionText] = prelude.split(/\s*\bat\b\s*/) as [string, string?];
      if (positionText !== undefined) gradient.centre = parsePosition(positionText);
      const shape = words(shapeText);
      const circle = shape.includes('circle');
      const lengths = shape.filter((t) => t !== 'circle' && t !== 'ellipse').map(parseLength);
      if (lengths.some((l) => l === undefined)) {
        throw new Error(`unsupported radial shape "${prelude}"`);
      }
      if (lengths.length === 2 && !circle) gradient.radii = [lengths[0]!, lengths[1]!];
      else if (lengths.length === 1 && circle) gradient.radii = [lengths[0]!, lengths[0]!];
      else if (lengths.length === 0 && circle) gradient.radii = null;
      else throw new Error(`unsupported radial shape "${prelude}"`);
    }
  }
  for (const arg of args) {
    const stop = parseStop(arg, colourOf);
    if (!stop) throw new Error(`unsupported colour stop "${arg}"`);
    gradient.stops.push(stop);
  }
  if (gradient.stops.length < 2) throw new Error(`a gradient needs two stops: "${text}"`);
  return gradient;
}

/** Parse a `background-size` entry. */
export function parseSize(text: string): [Length | 'auto', Length | 'auto'] {
  const tokens = words(text);
  if (tokens.length === 0 || tokens.length > 2) throw new Error(`unsupported size "${text}"`);
  const one = (token: string): Length | 'auto' => {
    if (token === 'auto') return 'auto';
    const length = parseLength(token);
    if (!length) throw new Error(`unsupported size "${text}"`);
    return length;
  };
  return [one(tokens[0]!), one(tokens[1] ?? 'auto')];
}

export interface BackgroundDeclarations {
  image: string;
  size?: string;
  position?: string;
  repeat?: string;
}

/** The layer list of a resolved `background-*` set, top layer first. */
export function parseLayers(declarations: BackgroundDeclarations, colourOf: ColourOf): Layer[] {
  const images = splitTopLevel(declarations.image);
  const cycle = (value: string | undefined, fallback: string) => {
    const list = value ? splitTopLevel(value) : [fallback];
    return (index: number) => list[index % list.length]!;
  };
  const size = cycle(declarations.size, 'auto');
  const position = cycle(declarations.position, '0% 0%');
  const repeat = cycle(declarations.repeat, 'repeat');
  return images.map((image, index) => {
    const repeatValue = repeat(index).trim();
    if (repeatValue !== 'repeat' && repeatValue !== 'no-repeat') {
      throw new Error(`unsupported background-repeat "${repeatValue}"`);
    }
    return {
      image: parseGradient(image, colourOf),
      size: parseSize(size(index)),
      position: parsePosition(position(index)),
      repeat: repeatValue === 'repeat',
    };
  });
}

/** Parse a `background-position` LIST (as a keyframe declares it). */
export function parsePositionList(text: string): [Length, Length][] {
  return splitTopLevel(text).map(parsePosition);
}

/** Linear interpolation of two position lists, as an animation between two keyframes paints it. */
export function interpolatePositions(
  from: [Length, Length][],
  to: [Length, Length][],
  w: number,
): [Length, Length][] {
  const count = Math.max(from.length, to.length);
  const mix = (a: Length, b: Length): Length => ({
    px: a.px + (b.px - a.px) * w,
    pct: a.pct + (b.pct - a.pct) * w,
  });
  return Array.from({ length: count }, (_, i) => {
    const [a, b] = [from[i % from.length]!, to[i % to.length]!];
    return [mix(a[0], b[0]), mix(a[1], b[1])];
  });
}

// ── Painting ────────────────────────────────────────────────────────────────

interface Box {
  width: number;
  height: number;
}

/** Stops resolved to fractions of the gradient ray, CSS Images 3 §3.5.3. */
interface Stop {
  t: number;
  /** Premultiplied channels. */
  pr: number;
  pg: number;
  pb: number;
  a: number;
}

interface Prepared {
  layer: Layer;
  tile: Box;
  offset: [number, number];
  /** Evaluate the image at a point inside its tile, premultiplied. */
  at: (u: number, v: number, out: Stop) => void;
}

function fixStops(raw: RawStop[], rayLength: number): Stop[] {
  const flat: { colour: Rgba; t: number | undefined }[] = [];
  for (const stop of raw) {
    if (stop.at.length === 0) flat.push({ colour: stop.colour, t: undefined });
    for (const at of stop.at) {
      flat.push({ colour: stop.colour, t: resolveLength(at, rayLength) / rayLength });
    }
  }
  if (flat[0]!.t === undefined) flat[0]!.t = 0;
  if (flat[flat.length - 1]!.t === undefined) flat[flat.length - 1]!.t = 1;
  let max = -Infinity;
  for (const stop of flat) {
    if (stop.t !== undefined) {
      stop.t = Math.max(stop.t, max);
      max = stop.t;
    }
  }
  for (let i = 0; i < flat.length; i += 1) {
    if (flat[i]!.t !== undefined) continue;
    let j = i;
    while (flat[j]!.t === undefined) j += 1;
    const [from, to] = [flat[i - 1]!.t!, flat[j]!.t!];
    for (let k = i; k < j; k += 1) flat[k]!.t = from + ((to - from) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  return flat.map(({ colour, t }) => ({
    t: t!,
    pr: colour.r * colour.a,
    pg: colour.g * colour.a,
    pb: colour.b * colour.a,
    a: colour.a,
  }));
}

function sampleStops(stops: Stop[], repeating: boolean, t: number, out: Stop): void {
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  let position = t;
  const period = last.t - first.t;
  if (repeating && period > 0) {
    position = first.t + ((((t - first.t) % period) + period) % period);
  }
  let pick: Stop | undefined;
  if (position <= first.t) pick = first;
  else if (position >= last.t) pick = last;
  if (pick) {
    Object.assign(out, pick);
    return;
  }
  let i = 1;
  while (stops[i]!.t <= position) i += 1;
  const [lo, hi] = [stops[i - 1]!, stops[i]!];
  const w = (position - lo.t) / (hi.t - lo.t);
  out.pr = lo.pr + (hi.pr - lo.pr) * w;
  out.pg = lo.pg + (hi.pg - lo.pg) * w;
  out.pb = lo.pb + (hi.pb - lo.pb) * w;
  out.a = lo.a + (hi.a - lo.a) * w;
}

function prepare(layer: Layer, area: Box, position = layer.position): Prepared {
  const [sw, sh] = layer.size;
  const tile: Box = {
    width: sw === 'auto' ? area.width : resolveLength(sw, area.width),
    height: sh === 'auto' ? area.height : resolveLength(sh, area.height),
  };
  // A percentage aligns that point of the tile with the same point of the area.
  const offset: [number, number] = [
    position[0].px + (position[0].pct / 100) * (area.width - tile.width),
    position[1].px + (position[1].pct / 100) * (area.height - tile.height),
  ];
  const image = layer.image;
  const cx = resolveLength(image.centre[0], tile.width);
  const cy = resolveLength(image.centre[1], tile.height);
  let at: Prepared['at'];
  if (image.kind === 'linear') {
    const radians = (image.angle * Math.PI) / 180;
    const [sin, cos] = [Math.sin(radians), Math.cos(radians)];
    const length = Math.abs(tile.width * sin) + Math.abs(tile.height * cos);
    const stops = fixStops(image.stops, length);
    at = (u, v, out) =>
      sampleStops(
        stops,
        image.repeating,
        ((u - tile.width / 2) * sin - (v - tile.height / 2) * cos) / length + 0.5,
        out,
      );
  } else {
    let [rx, ry] = image.radii
      ? [resolveLength(image.radii[0], tile.width), resolveLength(image.radii[1], tile.height)]
      : [0, 0];
    if (!image.radii) {
      const corner = Math.max(
        ...[
          [0, 0],
          [tile.width, 0],
          [0, tile.height],
          [tile.width, tile.height],
        ].map(([x, y]) => Math.hypot(x! - cx, y! - cy)),
      );
      [rx, ry] = [corner, corner];
    }
    const stops = fixStops(image.stops, rx);
    at = (u, v, out) =>
      sampleStops(
        stops,
        image.repeating,
        Math.sqrt(((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2),
        out,
      );
  }
  return { layer, tile, offset, at };
}

const scratch: Stop = { t: 0, pr: 0, pg: 0, pb: 0, a: 0 };

/**
 * Composite the prepared layers (top first) at pixel centre (x, y) over `under`,
 * premultiplied, into `out` (which may be `under` itself).
 */
function paint(layers: Prepared[], x: number, y: number, under: Stop, out: Stop): Stop {
  let [pr, pg, pb, a] = [under.pr, under.pg, under.pb, under.a];
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const p = layers[i]!;
    let u = x - p.offset[0];
    let v = y - p.offset[1];
    if (p.layer.repeat) {
      u = ((u % p.tile.width) + p.tile.width) % p.tile.width;
      v = ((v % p.tile.height) + p.tile.height) % p.tile.height;
    } else if (u < 0 || v < 0 || u >= p.tile.width || v >= p.tile.height) continue;
    p.at(u, v, scratch);
    const keep = 1 - scratch.a;
    pr = scratch.pr + pr * keep;
    pg = scratch.pg + pg * keep;
    pb = scratch.pb + pb * keep;
    a = scratch.a + a * keep;
  }
  out.pr = pr;
  out.pg = pg;
  out.pb = pb;
  out.a = a;
  return out;
}

const LINEAR = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** WCAG relative luminance of an opaque colour, rounded to 8 bits per channel. */
export function relativeLuminance(c: Rgba): number {
  const lin = (v: number) => LINEAR[Math.max(0, Math.min(255, Math.round(v)))]!;
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

const ratioOf = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** A texture layer repeats every few pixels: a repeating gradient, or a tile ≤ 64 px. */
export const TEXTURE_TILE_MAX = 64;
export function isTexture(layer: Layer): boolean {
  if (layer.image.repeating) return true;
  const [w, h] = layer.size;
  const small = (l: Length | 'auto') => l !== 'auto' && l.pct === 0 && l.px <= TEXTURE_TILE_MAX;
  return small(w) && small(h);
}

export interface Viewport {
  width: number;
  height: number;
}

/** One way the canvas is painted: its layers' positions (the declared ones, or an animation frame). */
export type RenderState = { name: string; positions: ([Length, Length] | undefined)[] };

export interface CanvasInput {
  /** The opaque colour under every layer. */
  ground: Rgba;
  layers: Layer[];
  viewports: Viewport[];
  states: RenderState[];
  inks: { name: string; colour: Rgba }[];
  /** The field sample pitch in px (default 12). The worst point is refined to 1 px around it. */
  step?: number;
}

export interface InkResult {
  ink: string;
  ratio: number;
  /** Where it was reached: viewport, state and pixel. */
  where: string;
}

/** The colours a texture stack paints, over transparent, deduplicated. */
function textureColours(layers: Layer[], area: Box): Stop[] {
  const transparent: Stop = { t: 0, pr: 0, pg: 0, pb: 0, a: 0 };
  if (layers.length === 0) return [transparent];
  const prepared = layers.map((l) => prepare(l, area));
  const seen = new Map<string, Stop>();
  // A window four tiles wide (a repeating gradient's tile is the area, so its
  // period, not its tile, is what repeats: 64 px stands in for it) at half a
  // pixel, which lands on every phase of every tile and every 1 px line.
  const span = Math.min(
    area.width,
    4 * Math.max(...prepared.map((p) => Math.min(p.tile.width, TEXTURE_TILE_MAX))),
  );
  for (let y = 0; y < span; y += 0.5) {
    for (let x = 0; x < span; x += 0.5) {
      const c = paint(prepared, x, y, transparent, { ...transparent });
      const key = `${Math.round(c.pr)},${Math.round(c.pg)},${Math.round(c.pb)},${c.a.toFixed(3)}`;
      if (!seen.has(key)) seen.set(key, c);
    }
  }
  return [...seen.values()];
}

/**
 * Paint the canvas and return each ink's WORST contrast against it, with where
 * it was reached. The ground is opaque, so every painted pixel is too.
 */
export function worstCanvasContrast(input: CanvasInput): InkResult[] {
  const step = input.step ?? 12;
  const ground: Stop = { t: 0, pr: input.ground.r, pg: input.ground.g, pb: input.ground.b, a: 1 };
  const inks = input.inks.map((ink) => ({ name: ink.name, lum: relativeLuminance(ink.colour) }));
  const results: InkResult[] = inks.map((ink) => ({ ink: ink.name, ratio: Infinity, where: '' }));
  const fields = input.layers.flatMap((layer, index) =>
    isTexture(layer) ? [] : [{ layer, index }],
  );
  const largest = input.viewports.reduce((a, b) =>
    a.width * a.height >= b.width * b.height ? a : b,
  );
  const textures = textureColours(input.layers.filter(isTexture), largest);

  for (const viewport of input.viewports) {
    for (const state of input.states) {
      const field = fields.map(({ layer, index }) =>
        prepare(layer, viewport, state.positions[index]),
      );
      /** The luminance of every colour pixel (x, y) can take, one per texture colour. */
      const memo = new Map<number, number[]>();
      const under: Stop = { t: 0, pr: 0, pg: 0, pb: 0, a: 1 };
      const luminances = (x: number, y: number) => {
        paint(field, x + 0.5, y + 0.5, ground, under);
        // Neighbouring pixels of a wash share a colour, and a canvas with no
        // field layer has one colour everywhere: paint each colour's textures once.
        const q = (n: number) => Math.round(n * 16);
        const key = (q(under.pr) * 4096 + q(under.pg)) * 4096 + q(under.pb);
        const cached = memo.get(key);
        if (cached) return cached;
        const lums = textures.map((t) => {
          const keep = 1 - t.a;
          return relativeLuminance({
            r: t.pr + under.pr * keep,
            g: t.pg + under.pg * keep,
            b: t.pb + under.pb * keep,
            a: 1,
          });
        });
        memo.set(key, lums);
        return lums;
      };
      const worstOf = (lums: number[], k: number) => {
        let worst = Infinity;
        for (const lum of lums) worst = Math.min(worst, ratioOf(lum, inks[k]!.lum));
        return worst;
      };
      const grid = (extent: number) => {
        const out: number[] = [];
        for (let i = 0; i < extent; i += step) out.push(i);
        if (out[out.length - 1] !== extent - 1) out.push(extent - 1);
        return out;
      };
      const coarse = inks.map(() => ({ x: 0, y: 0, ratio: Infinity }));
      for (const y of grid(viewport.height)) {
        for (const x of grid(viewport.width)) {
          const lums = luminances(x, y);
          coarse.forEach((best, k) => {
            const ratio = worstOf(lums, k);
            if (ratio < best.ratio) Object.assign(best, { x, y, ratio });
          });
        }
      }
      coarse.forEach((best, k) => {
        // Refine the coarse winner to one pixel: a pattern search that scans a
        // grid step around it at a third of the step, then that pitch at 1 px.
        for (const [radius, pitch] of [
          [step, Math.max(1, Math.round(step / 3))],
          [Math.max(1, Math.round(step / 3)), 1],
        ] as const) {
          const [cx, cy] = [best.x, best.y];
          for (let dy = -radius; dy <= radius; dy += pitch) {
            for (let dx = -radius; dx <= radius; dx += pitch) {
              const [x, y] = [cx + dx, cy + dy];
              if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) continue;
              const ratio = worstOf(luminances(x, y), k);
              if (ratio < best.ratio) Object.assign(best, { x, y, ratio });
            }
          }
        }
        if (best.ratio < results[k]!.ratio) {
          results[k] = {
            ink: inks[k]!.name,
            ratio: best.ratio,
            where: `${viewport.width}x${viewport.height} ${state.name} at (${best.x},${best.y})`,
          };
        }
      });
    }
  }
  return results;
}
