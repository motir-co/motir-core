// Topography — contour lines over a slowly moving noise height map (marching
// squares), redrawn per style (MOTIR-11617). Each style supplies its contour
// stroke, its terrace fill and its motion — the per-style tables below, ported
// from the approved design (MOTIR-11602, design/backgrounds/). A style id with
// no entry draws Warm Editorial's variation.
//
// Every ink comes from `env.colours` (the live tokens). The terrace fill is
// painted into an off-screen canvas from `env.createCanvas`; with none, the
// contours still draw.

import { seeded } from './cellular';
import { A, PathRec, fillPath, hash, hueBand, mix, rr, strokePath } from './drawKit';
import type { Rgb } from './colour';
import type { StyleId } from '../theme/styles';
import type {
  BackgroundColours,
  BackgroundContext,
  BackgroundDrawer,
  BackgroundFrameEnv,
} from './types';

export type ContourPoint = [number, number];
type Pt = ContourPoint;
type Noise = (x: number, y: number) => number;

/** How a style shapes the contours and their motion. */
export interface TopoConfig {
  /** Grid cell in CSS pixels (chunkier = larger). */
  step: number;
  /** Contour levels. */
  levels: number;
  /** Moves in jumps, this many times a second. */
  stepped?: number;
  /** Never moves. */
  still?: boolean;
  /** Speed multiplier. */
  speed?: number;
  /** A gentle bob of the field. */
  bob?: number;
}

/** One frame's scene, handed to a style's drawing. */
export interface TopoScene {
  W: number;
  H: number;
  t: number;
  tt: number;
  /** Heights 0..1, `cols × rows`, row-major. */
  field: Float32Array;
  cols: number;
  rows: number;
  step: number;
  c: BackgroundColours;
  T: TopoConfig;
  createCanvas: BackgroundFrameEnv['createCanvas'];
}

type TopoDraw = (ctx: BackgroundContext, o: TopoScene) => void;

function makeNoise(seed: number): Noise {
  const G = 64;
  const r = seeded(seed);
  const g = new Float32Array(G * G);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const ss = (t: number): number => t * t * (3 - 2 * t);
  const at = (i: number, j: number): number => g[(j % G) * G + (i % G)]!;
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = ss(x - xi);
    const yf = ss(y - yi);
    const i = ((xi % G) + G) % G;
    const j = ((yi % G) + G) % G;
    const a = at(i, j);
    const b = at(i + 1, j);
    const cc = at(i, j + 1);
    const d = at(i + 1, j + 1);
    const top = a + (b - a) * xf;
    return top + (cc + (d - cc) * xf - top) * yf;
  };
}
function fbm(noise: Noise, x: number, y: number): number {
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let o = 0; o < 4; o++) {
    v += a * noise(x * f, y * f);
    a *= 0.5;
    f *= 2;
  }
  return v / 0.9375;
}
function contours(
  field: Float32Array,
  cols: number,
  rows: number,
  step: number,
  level: number,
  interp: boolean,
  seg: (a: Pt, b: Pt) => void,
): void {
  for (let r = 0; r < rows - 1; r++)
    for (let c = 0; c < cols - 1; c++) {
      const a = field[r * cols + c]!;
      const b = field[r * cols + c + 1]!;
      const d = field[(r + 1) * cols + c]!;
      const e = field[(r + 1) * cols + c + 1]!;
      const cs =
        (a >= level ? 8 : 0) | (b >= level ? 4 : 0) | (e >= level ? 2 : 0) | (d >= level ? 1 : 0);
      if (cs === 0 || cs === 15) continue;
      const x = c * step;
      const y = r * step;
      const s = step;
      const k = (p: number, q: number): number => (interp ? (level - p) / (q - p) : 0.5);
      const T = (): Pt => [x + k(a, b) * s, y];
      const B = (): Pt => [x + k(d, e) * s, y + s];
      const L = (): Pt => [x, y + k(a, d) * s];
      const R = (): Pt => [x + s, y + k(b, e) * s];
      switch (cs) {
        case 1:
        case 14:
          seg(L(), B());
          break;
        case 2:
        case 13:
          seg(B(), R());
          break;
        case 3:
        case 12:
          seg(L(), R());
          break;
        case 4:
        case 11:
          seg(T(), R());
          break;
        case 5:
          seg(L(), T());
          seg(B(), R());
          break;
        case 6:
        case 9:
          seg(T(), B());
          break;
        case 7:
        case 8:
          seg(L(), T());
          break;
        case 10:
          seg(L(), B());
          seg(T(), R());
          break;
      }
    }
}
const levelPath = (
  o: TopoScene,
  k: number,
  interp = true,
  dx = 0,
  dy = 0,
  jitter: ((p: Pt) => Pt) | null = null,
): PathRec => {
  const p = new PathRec();
  const lv = k / (o.T.levels + 1);
  contours(o.field, o.cols, o.rows, o.step, lv, interp, (a, b) => {
    const ja: Pt = jitter ? jitter(a) : [0, 0];
    const jb: Pt = jitter ? jitter(b) : [0, 0];
    p.moveTo(a[0] + dx + ja[0], a[1] + dy + ja[1]);
    p.lineTo(b[0] + dx + jb[0], b[1] + dy + jb[1]);
  });
  return p;
};
/** The field painted into a cols × rows image, one colour per height bucket, scaled up smooth. */
function terraces(
  ctx: BackgroundContext,
  o: TopoScene,
  colourOf: (bucket: number) => readonly number[],
  smooth = true,
): void {
  const { field, cols, rows, step } = o;
  const oc = o.createCanvas(cols, rows);
  const octx = oc?.getContext('2d');
  // No off-screen canvas (a test or a static renderer): the contours still draw.
  if (!oc || !octx) return;
  const img = octx.createImageData(cols, rows);
  for (let i = 0; i < field.length; i++) {
    const bucket = Math.max(0, Math.min(o.T.levels, Math.floor(field[i]! * (o.T.levels + 1))));
    const [r = 0, g = 0, b = 0, a = 255] = colourOf(bucket);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = a;
  }
  octx.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = smooth;
  ctx.drawImage(oc as unknown as CanvasImageSource, -step / 2, -step / 2, cols * step, rows * step);
  ctx.restore();
}

const TOPO: Partial<Record<StyleId, TopoConfig>> = {
  'warm-editorial': { step: 7, levels: 14 },
  'soft-playful': { step: 9, levels: 8, bob: 0.4 },
  'swiss-minimal-flat': { step: 8, levels: 7 },
  'neo-brutalism': { step: 22, levels: 5, stepped: 1 },
  glassmorphism: { step: 10, levels: 7 },
  'cybercore-y2k': { step: 6, levels: 9 },
  aurora: { step: 8, levels: 10, speed: 0.5 },
  '3d-immersive': { step: 10, levels: 7 },
  neumorphism: { step: 10, levels: 6 },
  'hand-drawn-indie': { step: 11, levels: 10 },
  retrofuturism: { step: 8, levels: 8, speed: 0.6 },
  'dense-pro': { step: 6, levels: 22 },
  'high-contrast-accessible': { step: 12, levels: 5, still: true },
  'tonal-elevated': { step: 10, levels: 6 },
  claymorphism: { step: 12, levels: 5 },
  bento: { step: 8, levels: 10 },
  'editorial-print': { step: 8, levels: 12, stepped: 1 },
  'art-deco': { step: 14, levels: 6, stepped: 4 },
  memphis: { step: 14, levels: 5 },
};

const TOPO_DRAW: Partial<Record<StyleId, TopoDraw>> = {
  'warm-editorial'(ctx, o) {
    const { c, T, W, tt } = o;
    const g = hueBand(ctx, W, tt, c);
    for (let k = 1; k <= T.levels; k++) {
      const p = levelPath(o, k);
      if (k % 3 === 0) {
        ctx.strokeStyle = g;
        ctx.globalAlpha = c.dark ? 0.6 : 0.5;
        ctx.lineWidth = 1.5;
      } else {
        ctx.strokeStyle = A(c.ink);
        ctx.globalAlpha = c.dark ? 0.16 : 0.13;
        ctx.lineWidth = 1;
      }
      strokePath(ctx, p);
    }
  },
  'soft-playful'(ctx, o) {
    const { c, T } = o;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    terraces(ctx, o, (b) => [...mix(c.bg, c.hues[b % 3]!, c.dark ? 0.12 : 0.08), b % 2 ? 255 : 0]);
    for (let k = 1; k <= T.levels; k++) {
      ctx.strokeStyle = A(c.hues[k % 3]!, c.dark ? 0.6 : 0.5);
      ctx.lineWidth = 2.6;
      strokePath(ctx, levelPath(o, k));
    }
  },
  'swiss-minimal-flat'(ctx, o) {
    const { c, T } = o;
    for (let k = 1; k <= T.levels; k++) {
      ctx.strokeStyle = A(k === 4 ? c.accent : c.ink, k === 4 ? 1 : c.dark ? 0.28 : 0.24);
      ctx.lineWidth = k === 4 ? 1.5 : 1;
      strokePath(ctx, levelPath(o, k));
    }
  },
  'neo-brutalism'(ctx, o) {
    const { field, cols, rows, step, c, T } = o;
    for (let r = 0; r < rows; r++)
      for (let cc = 0; cc < cols; cc++) {
        const v = field[r * cols + cc]!;
        let col: Rgb | null = null;
        if (v > 0.7) col = c.hues[0];
        else if (v < 0.26) col = c.hues[1];
        else if (v > 0.47 && v < 0.52) col = c.hues[2];
        if (col) {
          ctx.fillStyle = A(col);
          ctx.fillRect(cc * step - step / 2, r * step - step / 2, step, step);
        }
      }
    const path = new PathRec();
    for (let k = 1; k <= T.levels; k++) path.addPath(levelPath(o, k, false));
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
    ctx.lineWidth = 3;
    ctx.save();
    ctx.translate(4, 4);
    ctx.strokeStyle = A(c.ground);
    strokePath(ctx, path);
    ctx.restore();
    ctx.strokeStyle = A(c.ink);
    strokePath(ctx, path);
  },
  glassmorphism(ctx, o) {
    const { c, T } = o;
    ctx.save();
    ctx.filter = 'blur(3px)';
    terraces(ctx, o, (b) => [...mix(c.bg, c.hues[b % 3]!, (c.dark ? 0.05 : 0.035) * b), 255]);
    ctx.restore();
    for (let k = 1; k <= T.levels; k++) {
      ctx.strokeStyle = A(c.dark ? c.ink : c.surface, c.dark ? 0.22 : 0.95);
      ctx.lineWidth = 1.2;
      strokePath(ctx, levelPath(o, k, true, 0, -0.8));
      ctx.strokeStyle = A(c.ink, c.dark ? 0.0 : 0.08);
      ctx.lineWidth = 1;
      strokePath(ctx, levelPath(o, k, true, 0, 0.6));
    }
  },
  'cybercore-y2k'(ctx, o) {
    const { cols, rows, step, c, T, H, W, field } = o;
    for (let k = 1; k <= T.levels; k++) {
      const p = new PathRec();
      contours(field, cols, rows, step, k / (T.levels + 1), true, (a) => {
        p.rect(Math.floor(a[0] / step) * step, Math.floor(a[1] / step) * step, step - 1, step - 1);
      });
      ctx.save();
      if (c.dark && k % 3 === 0) {
        ctx.shadowBlur = 10;
        ctx.shadowColor = A(c.hues[0]);
      }
      ctx.fillStyle = A(c.hues[k % 3]!, k % 3 === 0 ? 0.9 : 0.45);
      fillPath(ctx, p);
      ctx.restore();
    }
    ctx.fillStyle = A(c.bg, 0.22);
    for (let yy = 0; yy < H; yy += 3) ctx.fillRect(0, yy, W, 1);
  },
  aurora(ctx, o) {
    const { c, T, W, tt } = o;
    const g = hueBand(ctx, W, tt, c);
    ctx.save();
    if (c.dark) ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = A(c.hues[0], c.dark ? 0.9 : 0.4);
    ctx.shadowBlur = c.dark ? 14 : 8;
    ctx.strokeStyle = g;
    for (let k = 1; k <= T.levels; k++) {
      ctx.globalAlpha = k % 2 ? (c.dark ? 0.55 : 0.4) : c.dark ? 0.25 : 0.18;
      ctx.lineWidth = k % 2 ? 1.8 : 1;
      strokePath(ctx, levelPath(o, k));
    }
    ctx.restore();
  },
  '3d-immersive'(ctx, o) {
    const { c, T, W, tt } = o;
    const g = hueBand(ctx, W, tt, c);
    // Terraces lifted level by level: each contour drawn higher than the last,
    // seated on a drop shadow, so the map reads as a raised relief.
    for (let k = 1; k <= T.levels; k++) {
      const lift = -k * 2.4;
      ctx.save();
      ctx.shadowColor = A(c.ground, c.dark ? 0.6 : 0.22);
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 5;
      ctx.strokeStyle = k % 2 ? g : A(c.ink, c.dark ? 0.3 : 0.22);
      ctx.globalAlpha = k % 2 ? 0.8 : 1;
      ctx.lineWidth = 1 + k * 0.25;
      strokePath(ctx, levelPath(o, k, true, 0, lift));
      ctx.restore();
    }
  },
  neumorphism(ctx, o) {
    const { c, T, W, tt } = o;
    const hl = c.dark ? mix(c.bg, c.ink, 0.1) : c.surface;
    const sh = c.dark ? mix(c.bg, c.ground, 0.8) : mix(c.bg, c.ink, 0.13);
    ctx.lineCap = 'round';
    for (let k = 1; k <= T.levels; k++) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = A(hl);
      strokePath(ctx, levelPath(o, k, true, -1.5, -1.5));
      ctx.strokeStyle = A(sh);
      strokePath(ctx, levelPath(o, k, true, 1.5, 1.5));
      ctx.strokeStyle = A(c.bg);
      strokePath(ctx, levelPath(o, k));
    }
    ctx.strokeStyle = hueBand(ctx, W, tt, c);
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.5;
    strokePath(ctx, levelPath(o, 3));
  },
  'hand-drawn-indie'(ctx, o) {
    const { c, T, t } = o;
    const boil = Math.floor(t * 8);
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++)
      for (let k = 1; k <= T.levels; k++) {
        const s = boil * 2 + pass;
        const amp = pass ? 2.2 : 1.4;
        const jit = (p: Pt): Pt => [
          hash(Math.round(p[0] * 4), Math.round(p[1] * 4), s) * amp,
          hash(Math.round(p[0] * 4), Math.round(p[1] * 4) + 7, s) * amp,
        ];
        const pencil = k === 5;
        ctx.strokeStyle = A(pencil ? c.accent : c.ink, (pencil ? 0.8 : 0.32) * (pass ? 0.5 : 1));
        ctx.lineWidth = pass ? 0.8 : 1.3;
        strokePath(ctx, levelPath(o, k, true, 0, 0, jit));
      }
  },
  retrofuturism(ctx, o) {
    const { c, T, W, H, tt } = o;
    // The same STATIC floor as its Wave: horizon glow and receding grid.
    const hz = H * 0.7;
    const glow = ctx.createLinearGradient(0, hz - H * 0.3, 0, hz);
    glow.addColorStop(0, A(c.hues[0], 0));
    glow.addColorStop(1, A(c.hues[2], c.dark ? 0.4 : 0.2));
    ctx.fillStyle = glow;
    ctx.fillRect(0, hz - H * 0.3, W, H * 0.3);
    ctx.strokeStyle = A(c.accent, c.dark ? 0.45 : 0.26);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = -12; k <= 12; k++) {
      ctx.moveTo(W / 2 + k * 14, hz);
      ctx.lineTo(W / 2 + k * W * 0.16, H + 4);
    }
    for (let d = 4; hz + d < H; d *= 1.55) {
      ctx.moveTo(0, hz + d);
      ctx.lineTo(W, hz + d);
    }
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, hz);
    ctx.clip();
    ctx.strokeStyle = hueBand(ctx, W, tt, c);
    if (c.dark) {
      ctx.shadowColor = A(c.hues[0]);
      ctx.shadowBlur = 8;
    }
    for (let k = 1; k <= T.levels; k++) {
      ctx.globalAlpha = k % 2 ? 0.75 : 0.35;
      ctx.lineWidth = k % 2 ? 1.6 : 1;
      strokePath(ctx, levelPath(o, k));
    }
    ctx.restore();
  },
  'dense-pro'(ctx, o) {
    const { c, T, W, tt } = o;
    const g = hueBand(ctx, W, tt, c);
    for (let k = 1; k <= T.levels; k++) {
      const index = k % 5 === 0;
      ctx.strokeStyle = index ? g : A(c.ink, c.dark ? 0.14 : 0.11);
      ctx.globalAlpha = index ? 0.6 : 1;
      ctx.lineWidth = index ? 1 : 0.6;
      strokePath(ctx, levelPath(o, k));
    }
  },
  'high-contrast-accessible'(ctx, o) {
    const { c, T } = o;
    ctx.lineJoin = 'round';
    for (let k = 1; k <= T.levels; k++) {
      const index = k === 3;
      ctx.strokeStyle = A(index ? c.accent : c.ink, index ? 1 : 0.55);
      ctx.lineWidth = index ? 3 : 2;
      strokePath(ctx, levelPath(o, k));
    }
  },
  'tonal-elevated'(ctx, o) {
    const { c, T } = o;
    terraces(ctx, o, (b) => [...mix(c.bg, c.ink, 0.04 * b), 255], false);
    ctx.strokeStyle = A(c.line);
    ctx.lineWidth = 1;
    for (let k = 1; k <= T.levels; k++) {
      ctx.save();
      ctx.shadowColor = A(c.ground, c.dark ? 0.45 : 0.12);
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;
      strokePath(ctx, levelPath(o, k));
      ctx.restore();
    }
    ctx.strokeStyle = A(c.hues[0], 0.8);
    ctx.lineWidth = 1.5;
    strokePath(ctx, levelPath(o, 4));
  },
  claymorphism(ctx, o) {
    const { c, T } = o;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let k = 1; k <= T.levels; k++) {
      const base =
        k === 2
          ? mix(c.bg, c.hues[0], 0.6)
          : k === 4
            ? mix(c.bg, c.hues[1], 0.6)
            : mix(c.bg, c.ink, c.dark ? 0.14 : 0.07);
      ctx.save();
      ctx.shadowColor = A(c.ground, c.dark ? 0.55 : 0.2);
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 6;
      ctx.lineWidth = 9;
      ctx.strokeStyle = A(base);
      strokePath(ctx, levelPath(o, k));
      ctx.restore();
      ctx.lineWidth = 3;
      ctx.strokeStyle = A(mix(base, c.surface, 0.6), 0.75);
      strokePath(ctx, levelPath(o, k, true, 0, -2));
    }
  },
  bento(ctx, o) {
    const { c, T, W, H, tt } = o;
    const g = hueBand(ctx, W, tt, c);
    const cols = W > 480 ? 4 : 3;
    const rows = 3;
    const gut = 10;
    const tw = (W - gut * (cols + 1)) / cols;
    const th = (H - gut * (rows + 1)) / rows;
    let k = 0;
    for (let r = 0; r < rows; r++)
      for (let cc = 0; cc < cols; cc++, k++) {
        const x = gut + cc * (tw + gut);
        const yy = gut + r * (th + gut);
        const hero = k === 2 * cols - 2;
        rr(ctx, x, yy, tw, th, 16);
        ctx.fillStyle = A(hero ? mix(c.surface, c.hues[1], c.dark ? 0.22 : 0.14) : c.surface);
        ctx.fill();
        ctx.strokeStyle = A(c.line);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.save();
        rr(ctx, x, yy, tw, th, 16);
        ctx.clip();
        for (let lv = 1; lv <= T.levels; lv++) {
          ctx.strokeStyle = hero || lv % 3 === 0 ? g : A(c.ink, c.dark ? 0.16 : 0.12);
          ctx.globalAlpha = hero ? 0.8 : lv % 3 === 0 ? 0.45 : 1;
          strokePath(ctx, levelPath(o, lv));
        }
        ctx.restore();
      }
  },
  'editorial-print'(ctx, o) {
    const { c, T, W, H } = o;
    ctx.strokeStyle = A(c.ink, 0.12);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = W / 6; x < W; x += W / 6) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, H);
    }
    ctx.stroke();
    for (let k = 1; k <= T.levels; k++) {
      const index = k % 4 === 0;
      const press = k === 6;
      ctx.strokeStyle = A(press ? c.accent : c.ink, index ? 0.85 : press ? 0.9 : 0.22);
      ctx.lineWidth = index ? 2 : press ? 1.5 : 1;
      strokePath(ctx, levelPath(o, k));
    }
  },
  'art-deco'(ctx, o) {
    const { c, T } = o;
    const metal = mix(c.accent, c.ink, 0.25);
    for (let k = 1; k <= T.levels; k++) {
      const col = k === 3 ? c.hues[0] : metal;
      ctx.strokeStyle = A(col, 0.8);
      ctx.lineJoin = 'miter';
      ctx.lineWidth = 2;
      strokePath(ctx, levelPath(o, k, false));
      ctx.lineWidth = 1;
      strokePath(ctx, levelPath(o, k, false, 0, 4));
    }
  },
  memphis(ctx, o) {
    const { c, T, W, H } = o;
    terraces(
      ctx,
      o,
      (b) => (b % 2 ? [...mix(c.bg, c.hues[b % 3]!, 0.55), 255] : [0, 0, 0, 0]),
      false,
    );
    for (let r = 0, yy = 10; yy < H; r++, yy += 22)
      for (let x = r % 2 ? 11 : 0; x < W; x += 22) {
        ctx.fillStyle = A(c.ink, 0.14);
        ctx.fillRect(x, yy, 3, 3);
      }
    ctx.lineJoin = 'miter';
    for (let k = 1; k <= T.levels; k++) {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = A(c.accent);
      strokePath(ctx, levelPath(o, k, true, 3, 3));
      ctx.strokeStyle = A(c.ink);
      strokePath(ctx, levelPath(o, k));
    }
  },
};

export function createTopography(): BackgroundDrawer {
  let W = 0;
  let H = 0;
  const noise = makeNoise(11);
  return {
    resize(w: number, h: number) {
      W = w;
      H = h;
    },
    frame(ctx: BackgroundContext, t0: number, env: BackgroundFrameEnv) {
      const c = { ...env.colours, accent: env.colours.decision };
      const T = topoConfigFor(env.style);
      const t = T.still ? 0 : t0 * (T.speed ?? 1);
      ctx.fillStyle = A(c.bg);
      ctx.fillRect(0, 0, W, H);
      const tt = T.stepped ? Math.floor(t * T.stepped) / T.stepped : t;
      const step = Math.max(4, Math.round(T.step * (W < 500 ? 0.7 : 1)));
      const cols = Math.ceil(W / step) + 2;
      const rows = Math.ceil(H / step) + 2;
      const sc = Math.max(W, H) / 4.2;
      const ts = tt * 0.05 + (T.bob ? Math.sin(t * 1.4) * 0.02 * T.bob : 0);
      const field = new Float32Array(cols * rows);
      let lo = 1;
      let hi = 0;
      for (let r = 0; r < rows; r++)
        for (let cc = 0; cc < cols; cc++) {
          const v = fbm(noise, (cc * step) / sc + ts, (r * step) / sc + ts * 0.7);
          field[r * cols + cc] = v;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      const span = Math.max(1e-6, hi - lo);
      for (let i = 0; i < field.length; i++) field[i] = (field[i]! - lo) / span;
      ctx.save();
      topoDrawFor(env.style)(ctx, {
        W,
        H,
        t,
        tt,
        field,
        cols,
        rows,
        step,
        c,
        T,
        createCanvas: env.createCanvas,
      });
      ctx.restore();
    },
  };
}

/* ─────────────────────────── The board loop ─────────────────────────── */

/** The style whose variation a style without an entry draws. */
export const TOPO_BASE_STYLE: StyleId = 'warm-editorial';

/** Topography's shape for a style, falling back to the base variation. */
export function topoConfigFor(style: string): TopoConfig {
  return TOPO[style as StyleId] ?? TOPO[TOPO_BASE_STYLE]!;
}

/** Topography's drawing for a style, falling back to the base variation. */
export function topoDrawFor(style: string): TopoDraw {
  return TOPO_DRAW[style as StyleId] ?? TOPO_DRAW[TOPO_BASE_STYLE]!;
}

/** True when a style has its own Topography variation. */
export function hasTopoVariation(style: string): boolean {
  return style in TOPO && style in TOPO_DRAW;
}
