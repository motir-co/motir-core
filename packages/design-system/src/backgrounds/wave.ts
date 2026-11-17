// The Wave — the line from the Motir mark, repeated across the page, redrawn per
// style (MOTIR-11606). Every style keeps the mark: the deep dip first and the
// crest later, the lines gathering around the main content, the sliding band of
// the palette's wave hues and the decision squares riding the lines. A style
// supplies only its shape, stroke, glow and motion — the per-style tables below,
// ported from the approved design (MOTIR-11602, design/backgrounds/).
//
// Warm Editorial is today's HeroWaves, ported line for line (`drawMark`). A
// style id with no entry draws Warm Editorial's variation, so a style
// registered later still gets a Wave.
//
// Every ink comes from `env.colours` (the live tokens); the Wave's "accent" is
// the decision touch (`--el-showcase-decision`), never the ink CTA fill.

import { seeded } from './cellular';
import { A, PathRec, fillPath, hash, hueBand, mix, rr, strokePath } from './drawKit';
import type { Rgb } from './colour';
import type { StyleId } from '../theme/styles';

type Pt = [number, number];
import type {
  BackgroundBox,
  BackgroundColours,
  BackgroundContext,
  BackgroundDrawer,
  BackgroundFrameEnv,
} from './types';

/** One line of the Wave. */
export interface WaveLine {
  i: number;
  /** Position across the stack, -1 (top) to 1 (bottom); 0 runs through the content. */
  u: number;
  base: number;
  amp: number;
  phase: number;
  sp: number;
}

/** A decision square riding a line. */
export interface WaveSquare {
  u: number;
  x: number;
  kind: number;
}

/** How a style shapes the Wave's lines and motion. */
export interface WaveConfig {
  /** Number of lines. */
  lines: number;
  /** How tightly the lines bunch toward the content (1 = even). */
  bunch: number;
  /** Amplitude as a share of the box height. */
  amp: number;
  /** Drift speed. */
  drift: number;
  /** Moves in jumps, this many times a second. */
  stepped?: number;
  /** Never moves. */
  still?: boolean;
  /** A springy vertical bob, as a share of the height. */
  bob?: number;
  /** An amplitude swell. */
  breath?: number;
  /**
   * Draw today's HeroWaves exactly (Warm Editorial): its line set, its drift and
   * its alphas, so the package's Wave matches the shipped one side by side.
   */
  mark?: boolean;
}

/** One frame's scene, handed to a style's drawing. */
export interface WaveScene {
  W: number;
  H: number;
  t: number;
  /** Time after the style's stepping. */
  tt: number;
  lines: WaveLine[];
  y: (l: WaveLine, x: number) => number;
  c: BackgroundColours;
  sq: WaveSquare[];
  f: BackgroundBox;
}

type WaveDraw = (ctx: BackgroundContext, o: WaveScene) => void;

function trace(
  ctx: BackgroundContext,
  l: WaveLine,
  y: WaveScene['y'],
  W: number,
  step: number,
  dx = 0,
  dy = 0,
): void {
  let first = true;
  for (let x = -12; x <= W + 12; x += step) {
    const yy = y(l, x) + dy;
    if (first) {
      ctx.moveTo(x + dx, yy);
      first = false;
    } else ctx.lineTo(x + dx, yy);
  }
}
const lineAt = (lines: WaveLine[], s: WaveSquare): WaveLine =>
  lines[Math.round(((s.u + 1) / 2) * (lines.length - 1))]!;
const bandIdx = (n: number): [number, number] => [
  Math.max(0, Math.floor(n / 2) - 2),
  Math.min(n - 1, Math.floor(n / 2) + 2),
];

/* ───────────────────────────── The Wave ───────────────────────────── */

const waveFn = (t: number): number =>
  Math.sin(t * Math.PI * 2) * 0.8 + Math.sin(t * Math.PI * 4 - 0.5) * 0.22;

// lines · bunch toward the content · amplitude · drift speed · stepped (moves N
// times a second) · still (never moves) · bob (springy vertical bob) · breath (amplitude swell)
const WAVE: Partial<Record<StyleId, WaveConfig>> = {
  'warm-editorial': { lines: 46, bunch: 1.7, amp: 0.15, drift: 0.012, mark: true },
  'soft-playful': { lines: 16, bunch: 1.3, amp: 0.17, drift: 0.03, bob: 0.012 },
  'swiss-minimal-flat': { lines: 12, bunch: 1.0, amp: 0.12, drift: 0.025 },
  'neo-brutalism': { lines: 11, bunch: 1.1, amp: 0.2, drift: 0.06, stepped: 2 },
  glassmorphism: { lines: 13, bunch: 1.25, amp: 0.16, drift: 0.022 },
  'cybercore-y2k': { lines: 16, bunch: 1.3, amp: 0.17, drift: 0.04 },
  aurora: { lines: 24, bunch: 1.45, amp: 0.16, drift: 0.015 },
  '3d-immersive': { lines: 18, bunch: 1.3, amp: 0.16, drift: 0.03 },
  neumorphism: { lines: 9, bunch: 1.1, amp: 0.14, drift: 0.025 },
  'hand-drawn-indie': { lines: 20, bunch: 1.35, amp: 0.16, drift: 0.03 },
  retrofuturism: { lines: 14, bunch: 1.2, amp: 0.15, drift: 0.02 },
  'dense-pro': { lines: 64, bunch: 1.5, amp: 0.13, drift: 0.035 },
  'high-contrast-accessible': { lines: 8, bunch: 1.0, amp: 0.14, drift: 0, still: true },
  'tonal-elevated': { lines: 10, bunch: 1.15, amp: 0.15, drift: 0.02 },
  claymorphism: { lines: 7, bunch: 1.0, amp: 0.17, drift: 0.025, breath: 0.06 },
  bento: { lines: 22, bunch: 1.3, amp: 0.16, drift: 0.03 },
  'editorial-print': { lines: 26, bunch: 1.4, amp: 0.14, drift: 0.03, stepped: 1 },
  'art-deco': { lines: 15, bunch: 1.2, amp: 0.15, drift: 0.02, stepped: 4 },
  memphis: { lines: 10, bunch: 1.1, amp: 0.2, drift: 0.05 },
};

const WAVE_DRAW: Partial<Record<StyleId, WaveDraw>> = {
  'soft-playful'(ctx, o) {
    const { W, lines, y, c, tt, sq } = o;
    const g = hueBand(ctx, W, tt, c);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.save();
    ctx.filter = 'blur(6px)';
    ctx.strokeStyle = g;
    ctx.lineWidth = 9;
    ctx.globalAlpha = c.dark ? 0.12 : 0.08;
    ctx.beginPath();
    for (const l of lines) trace(ctx, l, y, W, 10);
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = g;
    ctx.lineWidth = 2.6;
    for (const l of lines) {
      const near = 1 - Math.abs(l.u);
      ctx.globalAlpha = (c.dark ? 0.16 : 0.12) + 0.48 * near * near;
      ctx.beginPath();
      trace(ctx, l, y, W, 8);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    sq.forEach((s) => {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      ctx.save();
      ctx.shadowColor = A(c.ground, c.dark ? 0.5 : 0.22);
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 3;
      rr(ctx, x - 8, yy - 8, 16, 16, 6);
      ctx.fillStyle = A(s.kind ? c.hues[1] : c.accent);
      ctx.fill();
      ctx.restore();
    });
  },

  'swiss-minimal-flat'(ctx, o) {
    const { W, lines, y, c, sq } = o;
    const n = lines.length;
    const hi = Math.round(n * 0.6);
    ctx.lineWidth = 1;
    ctx.strokeStyle = A(c.ink);
    ctx.globalAlpha = c.dark ? 0.26 : 0.22;
    ctx.beginPath();
    lines.forEach((l, i) => {
      if (i !== hi) trace(ctx, l, y, W, 6);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = A(c.accent);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    trace(ctx, lines[hi]!, y, W, 6);
    ctx.stroke();
    ctx.fillStyle = A(c.accent);
    sq.slice(0, 3).forEach((s) => {
      const x = s.x * W;
      const yy = y(lines[hi]!, x);
      ctx.fillRect(x - 4, yy - 4, 8, 8);
    });
  },

  'neo-brutalism'(ctx, o) {
    const { W, lines, y, c, sq } = o;
    const knot = Math.max(44, W / 14);
    const P = lines.map((l) => {
      const a: Pt[] = [];
      for (let x = -knot; x <= W + knot * 1.01; x += knot) a.push([x, y(l, x)]);
      return a;
    });
    const poly = (pts: Pt[], dx: number, dy: number) => {
      ctx.beginPath();
      pts.forEach(([x, yy], i) => (i ? ctx.lineTo(x + dx, yy + dy) : ctx.moveTo(x + dx, yy + dy)));
    };
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'square';
    const n = lines.length;
    const bands: [number, number, number][] = [
      [1, 2, 0],
      [Math.floor(n / 2) + 1, Math.floor(n / 2) + 2, 1],
      [n - 3, n - 2, 2],
    ];
    for (const [a, b, hi] of bands) {
      const pts = [...P[a]!, ...P[b]!.slice().reverse()];
      poly(pts, 6, 6);
      ctx.closePath();
      ctx.fillStyle = A(c.ground);
      ctx.fill();
      poly(pts, 0, 0);
      ctx.closePath();
      ctx.fillStyle = A(c.hues[hi]!);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = A(c.ground);
      ctx.stroke();
    }
    lines.forEach((l, i) => {
      poly(P[i]!, 4, 4);
      ctx.lineWidth = 3;
      ctx.strokeStyle = A(c.ground);
      ctx.stroke();
      poly(P[i]!, 0, 0);
      ctx.strokeStyle = A(i % 4 === 2 ? c.accent : c.ink);
      ctx.stroke();
    });
    for (const s of sq) {
      const x = Math.round((s.x * W) / knot) * knot;
      const yy = y(lineAt(lines, s), x);
      ctx.fillStyle = A(c.ground);
      ctx.fillRect(x - 4, yy - 4, 18, 18);
      ctx.fillStyle = A(s.kind ? c.hues[1] : c.accent);
      ctx.fillRect(x - 9, yy - 9, 18, 18);
      ctx.lineWidth = 3;
      ctx.strokeStyle = A(c.ground);
      ctx.strokeRect(x - 9, yy - 9, 18, 18);
    }
  },

  glassmorphism(ctx, o) {
    const { W, lines, y, c, sq } = o;
    const n = lines.length;
    // Frosted ribbons between line pairs, blurred, then a light glass edge on top.
    ctx.save();
    ctx.filter = 'blur(8px)';
    for (let i = 1, k = 0; i < n - 1; i += 3, k++) {
      ctx.beginPath();
      trace(ctx, lines[i]!, y, W, 10);
      for (let x = W + 12; x >= -12; x -= 10) ctx.lineTo(x, y(lines[i + 1]!, x));
      ctx.closePath();
      ctx.fillStyle = A(c.hues[k % 3]!, c.dark ? 0.2 : 0.14);
      ctx.fill();
    }
    ctx.restore();
    ctx.lineWidth = 1;
    lines.forEach((l, i) => {
      const near = 1 - Math.abs(l.u);
      ctx.strokeStyle = A(c.dark ? c.ink : c.surface, c.dark ? 0.1 + 0.25 * near : 0.9);
      ctx.beginPath();
      trace(ctx, l, y, W, 8);
      ctx.stroke();
      ctx.strokeStyle = A(c.ink, c.dark ? 0 : 0.05 + 0.12 * near);
      ctx.beginPath();
      trace(ctx, l, y, W, 8, 0, 1);
      ctx.stroke();
      if (i === bandIdx(n)[0]) {
        ctx.strokeStyle = A(c.accent, 0.55);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        trace(ctx, l, y, W, 8);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    });
    for (const s of sq) {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      ctx.save();
      ctx.shadowColor = A(c.ground, c.dark ? 0.45 : 0.14);
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 4;
      rr(ctx, x - 9, yy - 9, 18, 18, 5);
      ctx.fillStyle = A(c.surface, c.dark ? 0.28 : 0.6);
      ctx.fill();
      ctx.restore();
      rr(ctx, x - 9, yy - 9, 18, 18, 5);
      ctx.strokeStyle = A(c.dark ? c.ink : c.line, c.dark ? 0.3 : 1);
      ctx.stroke();
      ctx.fillStyle = A(s.kind ? c.hues[1] : c.accent);
      ctx.fillRect(x - 3, yy - 3, 6, 6);
    }
  },

  'cybercore-y2k'(ctx, o) {
    const { W, H, lines, y, c, t } = o;
    const cs = W < 500 ? 4 : 6;
    const near = new PathRec();
    const far = new PathRec();
    for (const l of lines) {
      const p = Math.abs(l.u) < 0.45 ? near : far;
      let prev = null;
      for (let cx = 0; cx * cs < W; cx++) {
        const cy = Math.floor(y(l, cx * cs + cs / 2) / cs);
        const a = prev === null ? cy : Math.min(prev, cy);
        const b = prev === null ? cy : Math.max(prev, cy);
        for (let k = a; k <= b; k++) p.rect(cx * cs, k * cs, cs - 1, cs - 1);
        prev = cy;
      }
    }
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.translate(-2, 0);
    ctx.fillStyle = A(c.hues[1]);
    fillPath(ctx, near);
    ctx.translate(4, 0);
    ctx.fillStyle = A(c.hues[2]);
    fillPath(ctx, near);
    ctx.restore();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = A(c.hues[0]);
    fillPath(ctx, far);
    ctx.save();
    if (c.dark) {
      ctx.shadowBlur = 12;
      ctx.shadowColor = A(c.hues[0]);
    }
    ctx.globalAlpha = 0.9;
    fillPath(ctx, near);
    ctx.restore();
    const n = lines.length;
    for (let k = 0; k < 5; k++) {
      const l = lines[(k * 3 + 2) % n]!;
      const head = ((t * 160 + (k * W) / 5) % (W + 200)) - 100;
      for (let j = 0; j < 8; j++) {
        const x = Math.floor((head - j * cs) / cs) * cs;
        const cy = Math.floor(y(l, x + cs / 2) / cs) * cs;
        ctx.globalAlpha = 1 - j / 8;
        ctx.fillStyle = A(c.ink);
        ctx.fillRect(x, cy, cs - 1, cs - 1);
      }
    }
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = A(c.bg);
    for (let yy = 0; yy < H; yy += 3) ctx.fillRect(0, yy, W, 1);
    ctx.globalAlpha = 1;
  },

  aurora(ctx, o) {
    const { W, lines, y, c, tt, sq } = o;
    const g = hueBand(ctx, W, tt, c);
    ctx.save();
    if (c.dark) ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = g;
    ctx.shadowColor = A(c.hues[0], c.dark ? 0.9 : 0.45);
    ctx.shadowBlur = c.dark ? 16 : 10;
    ctx.lineCap = 'round';
    const [b1, b2] = bandIdx(lines.length);
    lines.forEach((l, i) => {
      const near = 1 - Math.abs(l.u);
      const band = i === b1 || i === b2;
      ctx.lineWidth = band ? 3 : 1.4;
      ctx.globalAlpha = band ? 0.75 : (c.dark ? 0.1 : 0.07) + (c.dark ? 0.45 : 0.32) * near * near;
      ctx.beginPath();
      trace(ctx, l, y, W, 6);
      ctx.stroke();
    });
    ctx.restore();
    for (const s of sq) {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      ctx.save();
      ctx.shadowColor = A(s.kind ? c.hues[1] : c.accent);
      ctx.shadowBlur = 14;
      rr(ctx, x - 6, yy - 6, 12, 12, 4);
      ctx.fillStyle = A(s.kind ? c.hues[1] : c.accent);
      ctx.fill();
      ctx.restore();
    }
  },

  '3d-immersive'(ctx, o) {
    const { W, lines, y, c, tt, t, sq } = o;
    const g = hueBand(ctx, W, tt, c);
    // Three depth planes, far to near: thinner, fainter and slower far away;
    // the near plane is thick, seated on a deep drop shadow, and parallaxes.
    for (let z = 0; z < 3; z++) {
      const sway = Math.sin(t * 0.35) * W * 0.03 * z;
      ctx.save();
      if (z === 2) {
        ctx.shadowColor = A(c.ground, c.dark ? 0.7 : 0.3);
        ctx.shadowBlur = 14;
        ctx.shadowOffsetY = 8;
      }
      ctx.lineWidth = [0.8, 1.4, 2.6][z]!;
      ctx.strokeStyle = z === 0 ? A(c.ink) : g;
      ctx.globalAlpha = [c.dark ? 0.14 : 0.1, 0.4, 0.85][z]!;
      ctx.beginPath();
      lines.forEach((l) => {
        if (l.i % 3 === z) trace(ctx, l, (ll, x) => y(ll, x + sway), W, 6);
      });
      ctx.stroke();
      ctx.restore();
    }
    for (const s of sq) {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      const d = 5;
      const col = s.kind ? c.hues[1] : c.accent;
      ctx.fillStyle = A(mix(col, c.surface, 0.45));
      ctx.beginPath();
      ctx.moveTo(x - 7, yy - 7);
      ctx.lineTo(x - 7 + d, yy - 7 - d);
      ctx.lineTo(x + 7 + d, yy - 7 - d);
      ctx.lineTo(x + 7, yy - 7);
      ctx.fill();
      ctx.fillStyle = A(mix(col, c.ground, 0.45));
      ctx.beginPath();
      ctx.moveTo(x + 7, yy - 7);
      ctx.lineTo(x + 7 + d, yy - 7 - d);
      ctx.lineTo(x + 7 + d, yy + 7 - d);
      ctx.lineTo(x + 7, yy + 7);
      ctx.fill();
      ctx.fillStyle = A(col);
      ctx.fillRect(x - 7, yy - 7, 14, 14);
    }
  },

  neumorphism(ctx, o) {
    const { W, lines, y, c, tt, sq } = o;
    const hl = c.dark ? mix(c.bg, c.ink, 0.1) : c.surface;
    const sh = c.dark ? mix(c.bg, c.ground, 0.8) : mix(c.bg, c.ink, 0.13);
    ctx.lineCap = 'round';
    ctx.lineWidth = 4;
    // Each line is a soft groove moulded into the page: highlight top-left,
    // shade bottom-right, the page colour on top.
    for (const l of lines) {
      ctx.strokeStyle = A(hl);
      ctx.beginPath();
      trace(ctx, l, y, W, 8, -1.5, -1.5);
      ctx.stroke();
      ctx.strokeStyle = A(sh);
      ctx.beginPath();
      trace(ctx, l, y, W, 8, 1.5, 1.5);
      ctx.stroke();
      ctx.strokeStyle = A(c.bg);
      ctx.beginPath();
      trace(ctx, l, y, W, 8);
      ctx.stroke();
    }
    const [b1] = bandIdx(lines.length);
    ctx.strokeStyle = hueBand(ctx, W, tt, c);
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    trace(ctx, lines[b1]!, y, W, 8);
    ctx.stroke();
    ctx.globalAlpha = 1;
    for (const s of sq) {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      ctx.save();
      ctx.shadowColor = A(sh);
      ctx.shadowBlur = 8;
      ctx.shadowOffsetX = 3;
      ctx.shadowOffsetY = 3;
      rr(ctx, x - 9, yy - 9, 18, 18, 6);
      ctx.fillStyle = A(c.bg);
      ctx.fill();
      ctx.shadowColor = A(hl);
      ctx.shadowOffsetX = -3;
      ctx.shadowOffsetY = -3;
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = A(s.kind ? c.hues[1] : c.accent);
      ctx.fillRect(x - 3, yy - 3, 6, 6);
    }
  },

  'hand-drawn-indie'(ctx, o) {
    const { W, lines, y, c, t, sq } = o;
    const boil = Math.floor(t * 8);
    const n = lines.length;
    const step = 14;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    lines.forEach((l, li) => {
      const near = 1 - Math.abs(l.u);
      const pencil = li === Math.floor(n / 2) - 1 || li === Math.floor(n / 2) + 2;
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        let k = 0;
        for (let x = -step; x <= W + step; x += step, k++) {
          const s = boil * 2 + pass;
          const xx = x + hash(li, k, s) * 1.2;
          const yy = y(l, x) + hash(li + 99, k, s) * 2.2;
          if (k === 0) ctx.moveTo(xx, yy);
          else ctx.lineTo(xx, yy);
        }
        ctx.strokeStyle = A(pencil ? c.accent : c.ink);
        ctx.globalAlpha = (pencil ? 0.75 : 0.34) * (pass ? 0.5 : 1) * (0.45 + 0.55 * near);
        ctx.lineWidth = pass ? 0.8 : 1.3;
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = A(c.accent);
    ctx.lineWidth = 1.8;
    sq.forEach((s, i) => {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      const j = (a: number) => hash(i, a, boil) * 2;
      ctx.beginPath();
      ctx.moveTo(x - 7 + j(1), yy - 7 + j(2));
      ctx.lineTo(x + 7 + j(3), yy - 7 + j(4));
      ctx.lineTo(x + 7 + j(5), yy + 7 + j(6));
      ctx.lineTo(x - 7 + j(7), yy + 7 + j(8));
      ctx.closePath();
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  },

  retrofuturism(ctx, o) {
    const { W, H, lines, y, c, tt, sq, f } = o;
    // A STATIC synthwave floor: a horizon glow band and a receding grid below it.
    const hz = Math.min(H * 0.78, f.y + f.h + 40);
    const glow = ctx.createLinearGradient(0, hz - H * 0.25, 0, hz + 6);
    glow.addColorStop(0, A(c.hues[0], 0));
    glow.addColorStop(0.85, A(c.hues[0], c.dark ? 0.32 : 0.16));
    glow.addColorStop(1, A(c.hues[2], c.dark ? 0.5 : 0.25));
    ctx.fillStyle = glow;
    ctx.fillRect(0, hz - H * 0.25, W, H * 0.25 + 6);
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
    const g = hueBand(ctx, W, tt, c);
    ctx.strokeStyle = g;
    if (c.dark) {
      ctx.shadowColor = A(c.hues[0]);
      ctx.shadowBlur = 10;
    }
    const [b1, b2] = bandIdx(lines.length);
    lines.forEach((l, i) => {
      const near = 1 - Math.abs(l.u);
      ctx.lineWidth = i === b1 || i === b2 ? 2.6 : 1.4;
      ctx.globalAlpha = 0.2 + 0.6 * near * near;
      ctx.beginPath();
      trace(ctx, l, y, W, 6);
      ctx.stroke();
    });
    ctx.restore();
    ctx.globalAlpha = 1;
    for (const s of sq) {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      if (yy > hz - 8) continue;
      const chrome = ctx.createLinearGradient(0, yy - 8, 0, yy + 8);
      chrome.addColorStop(0, A(c.surface));
      chrome.addColorStop(0.5, A(mix(c.surface, c.ink, 0.35)));
      chrome.addColorStop(1, A(mix(c.surface, c.ink, 0.6)));
      ctx.save();
      ctx.shadowColor = A(s.kind ? c.hues[1] : c.accent);
      ctx.shadowBlur = 10;
      rr(ctx, x - 9, yy - 7, 18, 14, 7);
      ctx.fillStyle = chrome;
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = A(s.kind ? c.hues[1] : c.accent);
      ctx.fillRect(x - 3, yy - 2, 6, 4);
    }
  },

  'dense-pro'(ctx, o) {
    const { W, lines, y, c, tt, sq } = o;
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = A(c.ink);
    for (const l of lines) {
      const near = 1 - Math.abs(l.u);
      ctx.globalAlpha = (c.dark ? 0.06 : 0.05) + 0.2 * near * near;
      ctx.beginPath();
      trace(ctx, l, y, W, 5);
      ctx.stroke();
    }
    const [b1, b2] = bandIdx(lines.length);
    ctx.strokeStyle = hueBand(ctx, W, tt, c);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    trace(ctx, lines[b1]!, y, W, 5);
    trace(ctx, lines[b2]!, y, W, 5);
    ctx.stroke();
    ctx.globalAlpha = 1;
    for (const s of sq) {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      ctx.fillStyle = A(s.kind ? c.hues[1] : c.accent);
      ctx.fillRect(x - 3, yy - 3, 6, 6);
    }
  },

  'high-contrast-accessible'(ctx, o) {
    const { W, lines, y, c, sq } = o;
    const [b1, b2] = bandIdx(lines.length);
    ctx.lineJoin = 'round';
    lines.forEach((l, i) => {
      const band = i === b1 || i === b2;
      ctx.lineWidth = band ? 3 : 2;
      ctx.strokeStyle = A(i === b1 ? c.accent : i === b2 ? c.hues[1] : c.ink, band ? 1 : 0.55);
      ctx.beginPath();
      trace(ctx, l, y, W, 6);
      ctx.stroke();
    });
    for (const s of sq) {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      ctx.fillStyle = A(s.kind ? c.hues[1] : c.accent);
      ctx.fillRect(x - 7, yy - 7, 14, 14);
      ctx.lineWidth = 2;
      ctx.strokeStyle = A(c.ink);
      ctx.strokeRect(x - 7, yy - 7, 14, 14);
    }
  },

  'tonal-elevated'(ctx, o) {
    const { W, lines, y, c, sq } = o;
    const n = lines.length;
    const [b1] = bandIdx(n);
    // Tonal rungs: each band between two lines is the page tone stepped 4%
    // further toward the ink the nearer it is to the content, seated by a soft shadow.
    for (let i = 0; i < n - 1; i++) {
      const rung = Math.round((1 - Math.abs(lines[i]!.u)) * 4);
      ctx.save();
      ctx.shadowColor = A(c.ground, c.dark ? 0.4 : 0.1);
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 3;
      ctx.beginPath();
      trace(ctx, lines[i]!, y, W, 8);
      for (let x = W + 12; x >= -12; x -= 8) ctx.lineTo(x, y(lines[i + 1]!, x));
      ctx.closePath();
      ctx.fillStyle = A(
        i === b1 ? mix(c.bg, c.hues[0], c.dark ? 0.3 : 0.22) : mix(c.bg, c.ink, 0.04 * rung),
      );
      ctx.globalAlpha = i % 2 ? 0.55 : 1;
      ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = A(c.line);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const l of lines) trace(ctx, l, y, W, 8);
    ctx.stroke();
    for (const s of sq) {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      ctx.save();
      ctx.shadowColor = A(c.ground, c.dark ? 0.5 : 0.16);
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
      rr(ctx, x - 8, yy - 8, 16, 16, 4);
      ctx.fillStyle = A(mix(c.surface, c.ink, 0.04));
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = A(s.kind ? c.hues[1] : c.accent);
      ctx.fillRect(x - 3, yy - 3, 6, 6);
    }
  },

  claymorphism(ctx, o) {
    const { W, H, lines, y, c, sq } = o;
    const w = Math.max(10, H * 0.045);
    const [b1, b2] = bandIdx(lines.length);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    lines.forEach((l, i) => {
      const base =
        i === b1
          ? mix(c.bg, c.hues[0], 0.6)
          : i === b2
            ? mix(c.bg, c.hues[1], 0.6)
            : mix(c.bg, c.ink, c.dark ? 0.14 : 0.07);
      ctx.save();
      ctx.shadowColor = A(c.ground, c.dark ? 0.55 : 0.2);
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 7;
      ctx.lineWidth = w;
      ctx.strokeStyle = A(base);
      ctx.beginPath();
      trace(ctx, l, y, W, 10);
      ctx.stroke();
      ctx.restore();
      ctx.lineWidth = w * 0.3;
      ctx.strokeStyle = A(mix(base, c.surface, 0.6), 0.75);
      ctx.beginPath();
      trace(ctx, l, y, W, 10, 0, -w * 0.22);
      ctx.stroke();
      ctx.strokeStyle = A(mix(base, c.ground, 0.3), 0.45);
      ctx.beginPath();
      trace(ctx, l, y, W, 10, 0, w * 0.25);
      ctx.stroke();
    });
    for (const s of sq) {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      const col = s.kind ? c.hues[1] : c.accent;
      ctx.save();
      ctx.shadowColor = A(c.ground, c.dark ? 0.55 : 0.25);
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 6;
      rr(ctx, x - 11, yy - 11, 22, 22, 8);
      ctx.fillStyle = A(col);
      ctx.fill();
      ctx.restore();
      rr(ctx, x - 7, yy - 9, 14, 5, 3);
      ctx.fillStyle = A(mix(col, c.surface, 0.55), 0.8);
      ctx.fill();
    }
  },

  bento(ctx, o) {
    const { W, H, lines, y, c, tt, sq } = o;
    const g = hueBand(ctx, W, tt, c);
    const cols = W > 480 ? 4 : 3;
    const rows = 3;
    const gut = 10;
    const tw = (W - gut * (cols + 1)) / cols;
    const th = (H - gut * (rows + 1)) / rows;
    let k = 0;
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++, k++) {
        const x = gut + cc * (tw + gut);
        const yy = gut + r * (th + gut);
        const hero = k === cols + 1;
        rr(ctx, x, yy, tw, th, 16);
        ctx.fillStyle = A(hero ? mix(c.surface, c.hues[0], c.dark ? 0.22 : 0.14) : c.surface);
        ctx.fill();
        ctx.strokeStyle = A(c.line);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.save();
        rr(ctx, x, yy, tw, th, 16);
        ctx.clip();
        ctx.strokeStyle = g;
        lines.forEach((l) => {
          const near = 1 - Math.abs(l.u);
          ctx.globalAlpha = (hero ? 0.3 : 0.08) + (hero ? 0.5 : 0.3) * near * near;
          ctx.lineWidth = hero ? 1.6 : 1;
          ctx.beginPath();
          trace(ctx, l, y, W, 6);
          ctx.stroke();
        });
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    for (const s of sq) {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      rr(ctx, x - 5, yy - 5, 10, 10, 3);
      ctx.fillStyle = A(s.kind ? c.hues[1] : c.accent);
      ctx.fill();
    }
  },

  'editorial-print'(ctx, o) {
    const { W, H, lines, y, c, sq } = o;
    ctx.strokeStyle = A(c.ink, 0.12);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = W / 6; x < W; x += W / 6) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, H);
    }
    ctx.stroke();
    const n = lines.length;
    const rules = [Math.floor(n * 0.25), Math.floor(n * 0.75)];
    const [b1] = bandIdx(n);
    lines.forEach((l, i) => {
      const near = 1 - Math.abs(l.u);
      const rule = rules.includes(i);
      ctx.lineWidth = rule ? 2 : i === b1 ? 1.5 : 1;
      ctx.strokeStyle = A(
        i === b1 ? c.accent : c.ink,
        rule ? 0.85 : i === b1 ? 0.9 : 0.08 + 0.3 * near * near,
      );
      ctx.beginPath();
      trace(ctx, l, y, W, 6);
      ctx.stroke();
    });
    for (const s of sq) {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      ctx.fillStyle = A(s.kind ? c.ink : c.accent);
      ctx.fillRect(x - 4, yy - 4, 8, 8);
    }
  },

  'art-deco'(ctx, o) {
    const { W, lines, y, c, sq, f } = o;
    const metal = mix(c.accent, c.ink, 0.25);
    // A static sunburst fanning up from under the content.
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h + 30;
    ctx.strokeStyle = A(metal, c.dark ? 0.12 : 0.09);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let a = 0; a < 25; a++) {
      const ang = Math.PI + (a / 24) * Math.PI;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * W, cy + Math.sin(ang) * W);
    }
    ctx.stroke();
    const [b1, b2] = bandIdx(lines.length);
    lines.forEach((l, i) => {
      if (i % 2 && i !== b1 && i !== b2) return;
      const near = 1 - Math.abs(l.u);
      const col = i === b1 ? c.hues[0] : i === b2 ? c.hues[1] : metal;
      ctx.strokeStyle = A(col, 0.35 + 0.55 * near);
      ctx.lineWidth = 2;
      ctx.beginPath();
      trace(ctx, l, y, W, 6);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.beginPath();
      trace(ctx, l, y, W, 6, 0, 4);
      ctx.stroke();
    });
    for (const s of sq) {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      const q = 9;
      const k = 3;
      ctx.beginPath();
      ctx.moveTo(x - q + k, yy - q);
      ctx.lineTo(x + q - k, yy - q);
      ctx.lineTo(x + q, yy - q + k);
      ctx.lineTo(x + q, yy + q - k);
      ctx.lineTo(x + q - k, yy + q);
      ctx.lineTo(x - q + k, yy + q);
      ctx.lineTo(x - q, yy + q - k);
      ctx.lineTo(x - q, yy - q + k);
      ctx.closePath();
      ctx.fillStyle = A(s.kind ? c.hues[1] : c.accent);
      ctx.fill();
      ctx.strokeStyle = A(c.bg);
      ctx.lineWidth = 1;
      ctx.strokeRect(x - q + 4, yy - q + 4, q * 2 - 8, q * 2 - 8);
    }
  },

  memphis(ctx, o) {
    const { W, H, lines, y, c, sq } = o;
    // The static Bacterio texture: staggered dots and one diagonal hatch strip.
    for (let r = 0, yy = 10; yy < H; r++, yy += 22) {
      for (let x = r % 2 ? 11 : 0; x < W; x += 22) {
        ctx.fillStyle = A(c.hues[(r + Math.floor(x / 22)) % 3]!, 0.16);
        ctx.fillRect(x, yy, 3, 3);
      }
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, H * 0.08, W, 18);
    ctx.clip();
    ctx.strokeStyle = A(c.ink, 0.14);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = -40; x < W + 40; x += 10) {
      ctx.moveTo(x, H * 0.08 + 18);
      ctx.lineTo(x + 18, H * 0.08);
    }
    ctx.stroke();
    ctx.restore();
    const [b1, b2] = bandIdx(lines.length);
    const zig = (l: WaveLine, x: number) => y(l, x) + (Math.floor(x / 16) % 2 ? 5 : -5);
    const squig = (l: WaveLine, x: number) => y(l, x) + Math.sin(x / 9) * 3;
    ctx.lineJoin = 'miter';
    lines.forEach((l, i) => {
      const band = i === b1 || i === b2;
      const fn = i % 3 === 0 ? zig : squig;
      const step = i % 3 === 0 ? 16 : 4;
      ctx.lineWidth = band ? 4 : 2.5;
      ctx.strokeStyle = A(c.accent);
      ctx.beginPath();
      trace(ctx, l, fn, W, step, 3, 3);
      ctx.stroke();
      ctx.strokeStyle = A(band ? c.hues[i === b1 ? 0 : 1]! : c.ink, band ? 1 : 0.8);
      ctx.beginPath();
      trace(ctx, l, fn, W, step);
      ctx.stroke();
    });
    for (const s of sq) {
      const x = s.x * W;
      const yy = y(lineAt(lines, s), x);
      ctx.fillStyle = A(c.ground);
      ctx.fillRect(x - 4, yy - 4, 16, 16);
      ctx.fillStyle = A(c.accent);
      ctx.fillRect(x - 6, yy - 6, 16, 16);
      ctx.fillStyle = A(s.kind ? c.hues[1] : c.hues[2]);
      ctx.fillRect(x - 8, yy - 8, 16, 16);
      ctx.lineWidth = 2;
      ctx.strokeStyle = A(c.ink);
      ctx.strokeRect(x - 8, yy - 8, 16, 16);
    }
  },
};

/* ───────────── Warm Editorial — today's HeroWaves, line for line ───────────── */

// Ported from motir-core's `components/brand/HeroWaves.tsx` (deleted by
// MOTIR-11608) and its motir.co twin: the same 47 lines, bunching, drift, glow,
// touches and squares, so the swap is invisible.
const MARK_LINES = 46;
const MARK_DRIFT = 0.012;
const MARK_BAND_SPEED = 0.035;
const MARK_GLOW_WIDTH = 6;
const MARK_GLOW_BLUR = 4;
const MARK_TOUCH_ALPHA = 0.35;

export interface MarkLine {
  u: number;
  base: number;
  amp: number;
  phase: number;
}
export interface MarkSquare {
  line: number;
  x: number;
  kind: number;
}

/** The HeroWaves line set for a box and its focus. */
export function markLines(H: number, f: BackgroundBox): MarkLine[] {
  const fy = f.y + f.h / 2;
  return Array.from({ length: MARK_LINES + 1 }, (_, k) => {
    const u = (k / MARK_LINES) * 2 - 1;
    return {
      u,
      base: fy + Math.sign(u) * Math.pow(Math.abs(u), 1.7) * H * 0.95,
      amp: 70 + 110 * (1 - Math.abs(u)),
      phase: u * 0.18,
    };
  });
}

const markY = (l: MarkLine, x: number, W: number, t: number): number =>
  l.base +
  l.amp * (1 + 0.08 * Math.sin(t * 0.4 + l.u * 3)) * waveFn(x / W + l.phase + t * MARK_DRIFT);

/** The seven squares, placed once on the resting field clear of the content, as HeroWaves does. */
export function markSquares(W: number, lines: MarkLine[], f: BackgroundBox): MarkSquare[] {
  const near = (x: number, yy: number, pad: number) =>
    x > f.x - pad && x < f.x + f.w + pad && yy > f.y - pad && yy < f.y + f.h + pad;
  const rand = seeded(7);
  const squares: MarkSquare[] = [];
  for (let tries = 0; squares.length < 7 && tries < 400; tries++) {
    const line = 2 + Math.floor(rand() * (MARK_LINES - 4));
    const x = 40 + rand() * (W - 80);
    if (near(x, markY(lines[line]!, x, W, 0), 90)) continue;
    squares.push({ line, x, kind: squares.length % 3 });
  }
  return squares;
}

function drawMark(
  ctx: BackgroundContext,
  W: number,
  t: number,
  c: BackgroundColours,
  f: BackgroundBox,
  lines: MarkLine[],
  squares: MarkSquare[],
): void {
  const period = W * 1.4;
  const x0 = -period * ((t * MARK_BAND_SPEED) % 1);
  const band = ctx.createLinearGradient(x0, 0, x0 + period * 2, 0);
  const cycle = [...c.hues, ...c.hues, c.hues[0]];
  cycle.forEach((h, i) => band.addColorStop(i / (cycle.length - 1), A(h)));

  const glow = new PathRec();
  for (const l of lines) {
    for (let x = -10; x <= W + 10; x += 6) {
      const yy = markY(l, x, W, t);
      if (x === -10) glow.moveTo(x, yy);
      else glow.lineTo(x, yy);
    }
  }
  ctx.save();
  ctx.strokeStyle = band;
  ctx.lineWidth = MARK_GLOW_WIDTH;
  ctx.globalAlpha = c.dark ? 0.06 : 0.035;
  ctx.filter = `blur(${MARK_GLOW_BLUR}px)`;
  strokePath(ctx, glow);
  ctx.restore();

  ctx.lineWidth = 1;
  ctx.strokeStyle = band;
  for (const l of lines) {
    ctx.beginPath();
    for (let x = -10; x <= W + 10; x += 6) {
      const yy = markY(l, x, W, t);
      if (x === -10) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    const nearness = 1 - Math.abs(l.u);
    ctx.globalAlpha = c.dark ? 0.06 + 0.13 * nearness * nearness : 0.03 + 0.1 * nearness * nearness;
    ctx.stroke();
  }

  const touches: [number, Rgb][] = [
    [Math.floor(MARK_LINES / 2) - 2, c.decision],
    [Math.floor(MARK_LINES / 2) + 3, c.highlight],
  ];
  for (const [index, colour] of touches) {
    const l = lines[index]!;
    const from = f.x - 240;
    const to = f.x + f.w + 240;
    const g = ctx.createLinearGradient(from, 0, to, 0);
    g.addColorStop(0, A(colour, 0));
    g.addColorStop(0.25, A(colour));
    g.addColorStop(0.75, A(colour));
    g.addColorStop(1, A(colour, 0));
    ctx.beginPath();
    for (let x = from; x <= to; x += 4) {
      const yy = markY(l, x, W, t);
      if (x === from) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.globalAlpha = MARK_TOUCH_ALPHA;
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = g;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  ctx.globalAlpha = 1;
  for (const sq of squares) {
    const yy = markY(lines[sq.line]!, sq.x, W, t);
    if (sq.kind === 0) {
      ctx.fillStyle = A(c.decision);
      ctx.fillRect(sq.x - 5, yy - 5, 10, 10);
    } else {
      ctx.fillStyle = A(c.ground);
      ctx.fillRect(sq.x - 6, yy - 6, 12, 12);
      ctx.fillStyle = A(c.highlight);
      ctx.fillRect(sq.x - 3, yy - 3, 6, 6);
    }
  }
  ctx.globalAlpha = 1;
}

export function createWave(): BackgroundDrawer {
  let W = 0;
  let H = 0;
  let sq: WaveSquare[] = [];
  // Warm Editorial's line set and squares depend on the focus, so they are
  // cached per box size and focus, and rebuilt when either changes.
  let markKey = '';
  let mLines: MarkLine[] = [];
  let mSquares: MarkSquare[] = [];
  return {
    resize(w: number, h: number) {
      W = w;
      H = h;
      const r = seeded(7);
      sq = [];
      for (let i = 0; i < 7; i++)
        sq.push({ u: (r() * 2 - 1) * 0.5, x: 0.06 + r() * 0.88, kind: i % 2 });
    },
    frame(ctx: BackgroundContext, t0: number, env: BackgroundFrameEnv) {
      const cfg = waveConfigFor(env.style);
      // The Wave's "accent" is the hero's decision colour, never the ink CTA fill.
      const c = { ...env.colours, accent: env.colours.decision };
      const t = cfg.still ? 0 : t0;
      ctx.fillStyle = A(c.bg);
      ctx.fillRect(0, 0, W, H);
      const draw = WAVE_DRAW[env.style];
      if (cfg.mark || !draw) {
        const fb = env.focus;
        const key = `${W}x${H}:${fb.x},${fb.y},${fb.w},${fb.h}`;
        if (key !== markKey) {
          markKey = key;
          mLines = markLines(H, fb);
          mSquares = markSquares(W, mLines, fb);
        }
        drawMark(ctx, W, t, env.colours, fb, mLines, mSquares);
        return;
      }
      const tt = cfg.stepped ? Math.floor(t * cfg.stepped) / cfg.stepped : t;
      const f = env.focus;
      const cy = f.y + f.h / 2;
      const breath = cfg.breath ? 1 + cfg.breath * Math.sin(t * 1.2) : 1;
      const lines: WaveLine[] = [];
      for (let i = 0; i < cfg.lines; i++) {
        const u = (i / (cfg.lines - 1)) * 2 - 1;
        lines.push({
          i,
          u,
          base: cy + Math.sign(u) * Math.pow(Math.abs(u), cfg.bunch) * H * 0.72,
          amp: H * cfg.amp * (0.75 + 0.5 * Math.abs(u)) * breath,
          phase: i * 0.011,
          sp: 1 + ((i * 37) % 11) / 40,
        });
      }
      const period = Math.max(W, 320);
      const bob = cfg.bob ?? 0;
      const y = (l: WaveLine, x: number): number =>
        l.base +
        l.amp * waveFn(x / period + l.phase - tt * cfg.drift * l.sp) +
        Math.sin(tt * 0.5 + l.i * 1.7) * H * 0.006 +
        (bob ? Math.sin(t * 2.2 + l.i * 0.9) * H * bob : 0);
      ctx.save();
      draw(ctx, { W, H, t, tt, lines, y, c, sq, f });
      ctx.restore();
    },
  };
}

/* ─────────────────────────── Topography ─────────────────────────── */

/** The style whose variation a style without an entry draws. */
export const WAVE_BASE_STYLE: StyleId = 'warm-editorial';

/** The Wave's shape for a style, falling back to the base variation. */
export function waveConfigFor(style: string): WaveConfig {
  return WAVE[style as StyleId] ?? WAVE[WAVE_BASE_STYLE]!;
}

/** True when a style has its own Wave variation. */
export function hasWaveVariation(style: string): boolean {
  const cfg = WAVE[style as StyleId];
  return cfg !== undefined && (cfg.mark === true || style in WAVE_DRAW);
}
