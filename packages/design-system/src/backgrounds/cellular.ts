// The four cellular-automaton backgrounds — Cyclic CA, Brian's Brain, Day &
// Night and Rule 110 — ported from dooooWeb's `Login{CyclicCA,BriansBrain,
// DayNight,Rule110}`. Same in every style: they never read the style.
//
// Each runs on a cell grid painted into ONE off-screen image (one pixel per
// cell) that is scaled up onto the box without smoothing. Every cell colour is
// a live token mixed into the page background, so a palette or mode change
// recolours the grid on the next frame. The randomness is seeded, so two
// instances of the same size show the same frame, and each automaton is run
// ahead before its first frame so it opens already formed (Rule 110 opens
// with the screen full) — which is also the still frame under reduced motion.

import { mixRgb, packRgb, ramp, type Rgb } from './colour';
import type {
  BackgroundCanvas,
  BackgroundColours,
  BackgroundContext,
  BackgroundDrawer,
  BackgroundDrawerFactory,
} from './types';

/** A small seeded generator (LCG), uniform in [0, 1). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Grid = Uint8Array;

/** How one automaton behaves. */
export interface CellularSpec {
  seed: number;
  /** Seconds between steps. */
  interval: number;
  /** Steps run before the first frame. */
  prerun: number;
  /** Cell size in CSS pixels for a box of this width. */
  cell: (width: number) => number;
  init: (cols: number, rows: number, rnd: () => number) => Grid;
  step: (grid: Grid, cols: number, rows: number, rnd: () => number) => Grid;
  /** The packed colour of each state (index = state), from the live inks. */
  colours: (c: BackgroundColours) => number[];
  /** Write the grid into the image buffer. */
  paint: (grid: Grid, buf: Uint32Array, cols: number, rows: number, pal: number[]) => void;
}

/** At most this many steps are caught up in one frame after a stall. */
const MAX_CATCH_UP = 3;

const bySize =
  (big: number, small: number) =>
  (w: number): number =>
    w > 600 ? big : small;

const paintStates: CellularSpec['paint'] = (grid, buf, _c, _r, pal) => {
  for (let i = 0; i < grid.length; i++) buf[i] = pal[grid[i]!] ?? 0;
};

/** How many of the 8 neighbours (wrapping at the edges) hold `value`. */
export function mooreCount(
  grid: Grid,
  cols: number,
  rows: number,
  x: number,
  y: number,
  value: number,
): number {
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = (y + dy + rows) % rows;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (grid[yy * cols + ((x + dx + cols) % cols)] === value) n++;
    }
  }
  return n;
}

/** Packed colours of `stops` mixed `k` of the way from the page background. */
const mixedRamp = (bg: Rgb, stops: readonly Rgb[], count: number, k: number): number[] =>
  ramp(stops, count).map((c) => packRgb(mixRgb(bg, c, k)));

const randomGrid = (
  cols: number,
  rows: number,
  rnd: () => number,
  p: (r: number) => number,
): Grid => {
  const g = new Uint8Array(cols * rows);
  for (let i = 0; i < g.length; i++) g[i] = p(rnd());
  return g;
};

export const CYCLIC_STATES = 16;

/** Cyclic CA: a cell is consumed by the next state when a neighbour holds it. */
export const CYCLIC: CellularSpec = {
  seed: 5,
  interval: 0.1,
  prerun: 140,
  cell: bySize(5, 3),
  init: (c, r, rnd) => randomGrid(c, r, rnd, (v) => Math.floor(v * CYCLIC_STATES)),
  step: (g, c, r) => {
    const next = new Uint8Array(c * r);
    for (let y = 0; y < r; y++) {
      for (let x = 0; x < c; x++) {
        const i = y * c + x;
        const s = (g[i]! + 1) % CYCLIC_STATES;
        next[i] = mooreCount(g, c, r, x, y, s) >= 1 ? s : g[i]!;
      }
    }
    return next;
  },
  colours: (c) => mixedRamp(c.bg, c.hues, CYCLIC_STATES, c.dark ? 0.55 : 0.45),
  paint: paintStates,
};

/** Brian's Brain: off → firing on exactly two firing neighbours; firing → dying → off. */
export const BRIAN: CellularSpec = {
  seed: 9,
  interval: 0.12,
  prerun: 20,
  cell: bySize(5, 3),
  init: (c, r, rnd) => randomGrid(c, r, rnd, (v) => (v < 0.15 ? 1 : 0)),
  step: (g, c, r, rnd) => {
    const next = new Uint8Array(c * r);
    let firing = 0;
    for (let y = 0; y < r; y++) {
      for (let x = 0; x < c; x++) {
        const i = y * c + x;
        const s = g[i];
        if (s === 1) next[i] = 2;
        else if (s === 0 && mooreCount(g, c, r, x, y, 1) === 2) {
          next[i] = 1;
          firing++;
        }
      }
    }
    // It reseeds rather than dying out.
    return firing < c * r * 0.005 ? BRIAN.init(c, r, rnd) : next;
  },
  colours: (c) => [
    packRgb(c.bg),
    packRgb(mixRgb(c.bg, c.accent, 0.85)),
    packRgb(mixRgb(c.bg, c.accent, 0.28)),
  ],
  paint: paintStates,
};

/** Day & Night (B3678/S34678), with a few random flips per step so its edges keep moving. */
export const DAY_NIGHT: CellularSpec = {
  seed: 3,
  interval: 0.2,
  prerun: 40,
  cell: bySize(5, 3),
  init: (c, r, rnd) => randomGrid(c, r, rnd, (v) => (v < 0.5 ? 1 : 0)),
  step: (g, c, r, rnd) => {
    const next = new Uint8Array(c * r);
    for (let y = 0; y < r; y++) {
      for (let x = 0; x < c; x++) {
        const i = y * c + x;
        const n = mooreCount(g, c, r, x, y, 1);
        next[i] = (g[i] ? n === 3 || n === 4 || n >= 6 : n === 3 || n >= 6) ? 1 : 0;
      }
    }
    const flips = Math.ceil(c * r * 0.0006);
    for (let k = 0; k < flips; k++) {
      const i = Math.floor(rnd() * next.length);
      next[i] = next[i]! ^ 1;
    }
    return next;
  },
  colours: (c) => [packRgb(c.bg), packRgb(mixRgb(c.bg, c.accent, c.dark ? 0.22 : 0.15))],
  paint: paintStates,
};

const RULE_110 = [0, 1, 1, 1, 0, 1, 1, 0];
const RULE_110_HUES = 32;

/** Write row `to` of `g` from row `from` under Rule 110 (wrapping at the edges). */
function row110(g: Grid, cols: number, from: number, to: number): void {
  for (let x = 0; x < cols; x++) {
    const l = g[from + ((x - 1 + cols) % cols)]!;
    const m = g[from + x]!;
    const r = g[from + ((x + 1) % cols)]!;
    g[to + x] = RULE_110[(l << 2) | (m << 1) | r]!;
  }
}

/** Rule 110: a random first row, the whole screen computed up front, scrolling up a row per step. */
export const RULE110: CellularSpec = {
  seed: 1,
  interval: 0.07,
  prerun: 0,
  cell: bySize(4, 2),
  init: (c, r, rnd) => {
    const g = new Uint8Array(c * r);
    for (let x = 0; x < c; x++) g[x] = rnd() < 0.5 ? 1 : 0;
    for (let y = 1; y < r; y++) row110(g, c, (y - 1) * c, y * c);
    return g;
  },
  step: (g, c, r) => {
    g.copyWithin(0, c);
    row110(g, c, (r - 2) * c, (r - 1) * c);
    return g;
  },
  // [page background, then a ramp of the palette's hues across the width]
  colours: (c) => [packRgb(c.bg), ...mixedRamp(c.bg, c.hues, RULE_110_HUES, c.dark ? 0.45 : 0.38)],
  paint: (g, buf, cols, rows, pal) => {
    const bg = pal[0] ?? 0;
    const n = pal.length - 1;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        buf[i] = g[i] ? (pal[1 + Math.floor((x / cols) * n)] ?? bg) : bg;
      }
    }
  },
};

interface Surface {
  canvas: BackgroundCanvas;
  ctx: BackgroundContext;
  img: ImageData;
  buf: Uint32Array;
}

function makeSurface(
  create: (w: number, h: number) => BackgroundCanvas | null,
  cols: number,
  rows: number,
): Surface | null {
  const canvas = create(cols, rows);
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return null;
  const img = ctx.createImageData(cols, rows);
  return { canvas, ctx, img, buf: new Uint32Array(img.data.buffer) };
}

/** A drawer that runs `spec` on a grid sized to its box. */
export function cellular(spec: CellularSpec): BackgroundDrawerFactory {
  return (): BackgroundDrawer => {
    let W = 0;
    let H = 0;
    let cs = 1;
    let cols = 0;
    let rows = 0;
    let grid: Grid = new Uint8Array(0);
    let rnd = seeded(spec.seed);
    let last: number | null = null;
    let surface: Surface | null = null;
    return {
      resize(width, height) {
        if (width === W && height === H && grid.length) return;
        W = width;
        H = height;
        cs = spec.cell(width);
        cols = Math.max(1, Math.ceil(width / cs));
        rows = Math.max(2, Math.ceil(height / cs));
        rnd = seeded(spec.seed);
        grid = spec.init(cols, rows, rnd);
        for (let i = 0; i < spec.prerun; i++) grid = spec.step(grid, cols, rows, rnd);
        last = null;
        surface = null;
      },
      frame(ctx, t, env) {
        if (last === null) last = t;
        let n = 0;
        while (t - last >= spec.interval && n < MAX_CATCH_UP) {
          grid = spec.step(grid, cols, rows, rnd);
          last += spec.interval;
          n++;
        }
        if (t - last > spec.interval) last = t;
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgb(${env.colours.bg.join(', ')})`;
        ctx.fillRect(0, 0, W, H);
        surface ??= makeSurface(env.createCanvas, cols, rows);
        if (!surface) return;
        spec.paint(grid, surface.buf, cols, rows, spec.colours(env.colours));
        surface.ctx.putImageData(surface.img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(surface.canvas as unknown as CanvasImageSource, 0, 0, cols * cs, rows * cs);
      },
    };
  };
}

export const createCyclic = cellular(CYCLIC);
export const createBriansBrain = cellular(BRIAN);
export const createDayNight = cellular(DAY_NIGHT);
export const createRule110 = cellular(RULE110);
